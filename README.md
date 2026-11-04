# image-editor

An image tool with two jobs and one rule: **a photo means edit, no photo means generate.**

- **Edit** — give it a photo and an instruction ("make it night time with warm street lights")
  and it returns the same photo, changed, with a wipe to compare before and after.
- **Generate** — give it only an instruction ("a lighthouse on a cliff at dusk") and it returns a
  new image, in a shape you pick.

Both run on demand on an H100 at [Modal](https://modal.com), behind a React app deployed to
Vercel. Nothing is stored anywhere. The whole thing is designed to survive on the $30/month
Modal Starter credit, which is the constraint that shaped most of the decisions below.

---

## Contents

1. [What a user sees](#what-a-user-sees)
2. [Architecture](#architecture)
3. [Request lifecycle](#request-lifecycle)
4. [The two models](#the-two-models)
5. [Repository layout](#repository-layout)
6. [The web app](#the-web-app)
7. [The Modal service](#the-modal-service)
8. [Cost model](#cost-model)
9. [Setup from zero](#setup-from-zero)
10. [Configuration reference](#configuration-reference)
11. [Verifying a deployment](#verifying-a-deployment)
12. [Troubleshooting](#troubleshooting)
13. [Known limits](#known-limits)
14. [Licence](#licence)

---

## What a user sees

| State | What is on screen |
|---|---|
| Empty | A headline, a drop target (the whole canvas), and a pill composer at the bottom |
| Photo attached | The photo centred, small thumbnails above the composer, seed control at the end of that row |
| Prompt only | The same composer, plus a shape picker — Square / Wide / Tall / Cinema |
| Running | The prompt as a right-aligned bubble, then a field of dots filling in behind a percentage |
| Done (edit) | Before/after wipe over the result, model name + seconds + steps underneath |
| Done (generate) | The generated image tagged `Generated`, same metadata row |

The instruction is echoed as a chat bubble above the result, because the thing on screen is the
answer to the sentence you typed — and after a cold start of 40-plus seconds, being able to see
what you asked for is what tells you the wait was worth it.

A checkerboard icon in the composer asks for a **transparent background**. It applies to both
jobs: a generated icon or a cut-out subject from a photo. When the result really carries an alpha
channel the stage draws a checkerboard behind it, so the transparency is visible rather than
merely claimed.

---

## Architecture

```text
                                  ┌──────────────────────────────────────────────┐
   Browser                        │  Vercel  ·  TanStack Start (React 19)        │
   ───────                        │                                              │
   · no secrets anywhere    POST  │  routes/index.tsx      the studio, client    │
   · never calls Modal   ────────▶│        │                                     │
     directly                     │        └─ createServerFn                     │
                                  │             src/lib/edit.ts   ── held here ──┼──┐
                                  │             src/lib/credit.ts                │  │
                                  │                                              │  │
                                  └──────────────────────────────────────────────┘  │
                                                                                    │
                              HTTPS · Authorization: Bearer <wk-id>.<ws-secret>     │
                              (Modal proxy auth — the credential never leaves here) │
                                                                                    ▼
                 ┌───────────────────────────────────────────────────────────────────────┐
                 │  Modal app "image-editor"   (one region, e.g. us-east)                │
                 │                                                                       │
                 │   POST api()                  GET usage()                              │
                 │   ├─ image_b64 present        └─ billing summary → remaining credit   │
                 │   │    → Editor.edit          (CPU only, never starts a GPU)          │
                 │   └─ image_b64 empty                                                  │
                 │        → Painter.generate                                             │
                 └───────────────┬───────────────────────────────┬───────────────────────┘
                                 │                               │
                     ┌───────────▼──────────┐        ┌───────────▼───────────┐
                     │ Editor               │        │ Painter               │
                     │ Qwen-Image-Edit-2511 │        │ Qwen-Image-2512       │
                     │ + 4-step LoRA        │        │ + 4-step LoRA         │
                     │ H100 80 GB · 1 max   │        │ H100 80 GB · 1 max    │
                     │ 60 s scaledown       │        │ 60 s scaledown        │
                     └───────────┬──────────┘        └───────────┬───────────┘
                                 │                               │
                                 └───────────────┬───────────────┘
                                                 ▼
                                 ┌───────────────────────────────┐
                                 │ Modal Volume                  │
                                 │ image-editor-weights          │
                                 │ 2 × ~54 GiB checkpoints       │
                                 │ storage free under 1 TiB      │
                                 └───────────────────────────────┘
```

Three consequences of that shape, each deliberate:

**The browser never talks to Modal.** The endpoint URL and the proxy token live in the server
runtime (`process.env`, read *inside* the handler). Nothing is prefixed `VITE_`, because TanStack
Start inlines `VITE_`-prefixed values into client bundles — the single easiest way to hand a
credential to every visitor. No CORS config exists because no browser request ever reaches Modal.

**The GPU service serves no UI.** It answers JSON. An earlier version embedded a Gradio app,
which then needed its own password, its own secret, and its own failure modes; all of it was
deleted. The UI lives where it is cheap to serve and cheap to change.

**Two model containers, not one.** Each checkpoint is a 20 B MMDiT (38.05 GiB) plus a
Qwen2.5-VL text encoder (15.45 GiB) — 53.7 GiB apiece, download sizes verified against the HF
API. Together that is ~108 GiB against 80 GB of VRAM, so they cannot share a process. Two `@modal.cls` classes means two cold starts — but each
container only ever holds the model it is working with, and `max_containers=1` per class keeps
the ceiling at two cards instead of unbounded.

---

## Request lifecycle

```text
 user                browser                        Vercel fn                Modal                GPU
  │                     │                               │                      │                   │
  ├─ types a prompt ───▶│                               │                      │                   │
  ├─ presses enter ────▶│ validate (prompt, image ≤3)   │                      │                   │
  │                     ├── POST serverFn ─────────────▶│                      │                   │
  │                     │                               │ read env, POST ─────▶│ proxy auth        │
  │                     │                               │                      │ route by payload  │
  │                     │                               │                      ├─ cold? load 30-70 s
  │                     │◀── dots fill, elapsed ticks ──┤                      │                   │
  │                     │                               │                      │ 4 denoise steps ─▶│
  │                     │                               │◀──── PNG + seconds ──┤                   │
  │                     │◀── {ok, mode, model, image_b64}                      │                   │
  │◀── result + wipe ───┤                               │                      │                   │
  │                     │                               │                      │ 60 s idle ──▶ down
```

The client polls nothing and streams nothing. One request, one response, one image; the progress
UI is a client-side estimate (see [the wait](#the-wait-is-an-estimate-not-a-feed)).

---

## The two models

| | Edit | Generate |
|---|---|---|
| Checkpoint | `Qwen/Qwen-Image-Edit-2511` | `Qwen/Qwen-Image-2512` |
| Size on disk | 53.76 GiB (38.05 transformer + 15.45 text encoder) | 53.74 GiB (same split) |
| LoRA | `lightx2v/Qwen-Image-Edit-2511-Lightning`, 4-step, bf16 | `lightx2v/Qwen-Image-2512-Lightning`, 4-step, bf16 |
| Steps at runtime | 4 | 4 |
| Guidance | none (distilled); `1.0` only above 4 steps | same |
| Negative prompt | `" "` (a single space) | 2512's own quality-negative, Chinese, shipped with the model |
| Output size | inherits the input | trained buckets: 1328², 1584×1056, 1056×1584, 1664×928, 928×1664, 1472×1104, 1104×1472 |
| Licence | Apache 2.0 | Apache 2.0 |

All weights are downloaded once into a Modal Volume and read from there on every cold start. No
model file ever touches a developer machine, and there is no Hugging Face token because neither
repo is gated.

### The scheduler is the thing that decides good output from garbage

A Lightning LoRA is a distillation, and a distillation carries an implicit noise schedule. The
LoRA file does not contain it. Both pipelines therefore get a **rebuilt**
`FlowMatchEulerDiscreteScheduler` with `base_shift` and `max_shift` both `math.log(3)`
(the training used `shift=3`), `shift_terminal=None`, `stochastic_sampling=False`,
`use_dynamic_shifting=True`.

Attaching the LoRA to the pipeline's *default* scheduler is the mistake the Lightning repo
documents as grid artifacts: a faint grid over an otherwise plausible image. That is exactly the
kind of failure that survives a quick glance, so the config is a single constant
(`LIGHTNING_SCHEDULER_CONFIG`) used by both classes, and `check_env` builds it on a CPU
container to prove it parses before any GPU is rented.

---

## Repository layout

```text
image-editor/
├── web/                          TanStack Start app — deploy target: Vercel
│   ├── src/
│   │   ├── routes/
│   │   │   ├── __root.tsx        shell, theme script, error + 404 components
│   │   │   └── index.tsx         the studio: stage, composer, wait, result
│   │   ├── components/
│   │   │   ├── Header.tsx        chrome floated over the canvas
│   │   │   ├── CreditChip.tsx    remaining credit, top right
│   │   │   ├── ThemeToggle.tsx   light / dark / auto
│   │   │   └── Toaster.tsx       transient messages
│   │   ├── lib/
│   │   │   ├── edit.ts           the ONLY place that talks to Modal (server)
│   │   │   ├── credit.ts         credit server function (server)
│   │   │   ├── credit-store.ts   tiny external store + localStorage cache
│   │   │   └── toast.ts          external store for toasts
│   │   └── styles.css            design tokens (light + dark) and all component CSS
│   ├── vercel.json               framework: tanstack-start
│   └── .env.example              3 required variables, no VITE_ prefix
│
├── modal_app/
│   └── src/modal_app/
│       ├── app.py                the GPU service: 2 classes, 2 endpoints, helpers
│       └── matting.py            RGB → RGBA: geometric key, or u2net for photos
│
├── scripts/edit.py               CLI client for the deployed endpoint
├── docs/COST.md                  the longer cost argument
└── pyproject.toml                uv workspace root
```

---

## The web app

### Routes

`__root.tsx` renders the HTML shell: a blocking theme script (so there is no light flash before
hydration), `Header`, and children. `index.tsx` is the entire studio — one route, because the
product is one screen.

### Server functions

`src/lib/edit.ts` is the only module that knows Modal exists. It exports two server functions:

```ts
editImage({ imagesBase64, prompt, steps, seed })     // requires 1–3 images
generateImage({ prompt, steps, seed, aspect })       // no images
```

Both validate their own inputs and share one transport (`callModal`). The transport reads
`IMAGE_EDITOR_API_URL`, `MODAL_PROXY_TOKEN_ID`, `MODAL_PROXY_TOKEN_SECRET` from `process.env`
inside the handler, posts JSON, and normalises failures into `{ ok: false, error }` so the UI
never has to parse a stack trace. It also checks `body.mode` against what it asked for: a
generate call that somehow came back as an edit is an error, not a result.

`src/lib/credit.ts` does the same for `GET usage` — deriving the usage URL from the API URL by
replacing `-api` with `-usage`, with `IMAGE_EDITOR_USAGE_URL` as an override.

### State

One reducer-shaped `useState` set in `index.tsx`:

```text
idle ──prompt+photo──────────▶ running ──ok──▶ done ──"Edit this result"──▶ idle (photo = result)
  ▲      │                        │  │
  │      └─prompt only───────────▶│  └──error──▶ error ──"Try again"──▶ running
  │                               │
  └────────"Start over"───────────┴──"Stop waiting"──▶ done (if a result existed) or idle
```

`runId` is bumped on every new run and every cancellation, so a late response from an abandoned
request can never overwrite the screen.

### The wait is an estimate, not a feed

Modal does not stream progress, so `waitProgress(elapsed, warmed)` maps elapsed seconds onto a
percentage: three phases (`Starting a GPU`, `Loading the model`, then `Editing` or `Painting`),
capped at **92%**. The cap is deliberate — a bar that reaches 100% while the image has not
arrived is a lie, and the arrival of the image is the only real completion signal.

The dot field is 390 dots (26 × 15) lit in a **fixed** pseudo-random order: a fixed shuffle looks
scattered while every tick keeps the same arrangement, where `Math.random()` per frame reads as
noise instead of progress.

### Images are downscaled in the browser

Phone photos are 8–12 MP; the model was trained around 1 MP, and Vercel caps request bodies near
4.5 MB which base64 pushes over fast. `prepareImage()` re-encodes through a canvas to a 1536 px
long edge before anything is uploaded — which also strips EXIF rotation problems, since
`createImageBitmap` honours orientation.

### Theming

One token block per theme in `styles.css` (`:root`/`.light` and `.dark`), no
`prefers-color-scheme` media query in CSS: the blocking script in `__root.tsx` resolves
`auto → light|dark` and puts the class on `<html>` before first paint, so CSS only ever sees a
resolved theme.

---

## The Modal service

`modal_app/src/modal_app/app.py` is the whole backend. Nothing else runs in Python.

| Object | Kind | GPU | Purpose |
|---|---|---|---|
| `api` | FastAPI endpoint (POST) | no | Routes a request to the right class by payload |
| `usage` | FastAPI endpoint (GET) | no | Remaining credit for the header chip |
| `Editor` | `@modal.cls` | H100 | `edit(images, prompt, steps, cfg, seed)` |
| `Painter` | `@modal.cls` | H100 | `generate(prompt, aspect, steps, cfg, seed)` |
| `check_env` | function | no | Proves the dependency set loads before renting a GPU |
| `download_weights` | function | no | Edit checkpoint + LoRA into the Volume |
| `download_t2i` | function | no | Generate checkpoint + LoRA into the Volume |
| `volume_stats` | function | no | What is actually in the Volume |
| `smoke` / `smoke_generate` | local entrypoints | — | One real run each, no HTTP or auth in the way |

Both endpoints are `requires_proxy_auth=True`. Both classes are `max_containers=1`,
`scaledown_window=60`, `timeout=1200`.

### One endpoint, two jobs

```http
POST https://<workspace>--image-editor-api.modal.run
Authorization: Bearer <wk-id>.<ws-secret>
Content-Type: application/json

{ "prompt": "make it night", "image_b64": ["iVBOR..."], "steps": 4, "seed": 0 }
{ "prompt": "a lighthouse at dusk", "image_b64": [], "aspect": "16:9", "steps": 4, "seed": 0 }
```

```json
{
  "ok": true,
  "mode": "edit" | "generate",
  "model": "Qwen/Qwen-Image-Edit-2511",
  "transparent": false,
  "image_b64": "iVBOR...",
  "seconds": 3.61,
  "steps": 4,
  "size": [896, 1184]
}
```

`transparent` reflects what actually happened, not what was asked: if the cutout fails the field
is `false` and the image is returned intact, because losing a render the user waited for is worse
than returning one without alpha.

The mode is decided by **whether `image_b64` arrived**, not by a flag. That keeps the rule in one
place: the client cannot ask for a generate while sending a photo, and the API function is the
only thing that has to branch.

Failures are JSON with `ok: false` and a one-line `error`, never an opaque 500 — the web app
distinguishes "your token is wrong" (HTTP 401 from proxy auth) from "the model failed" (200 with
`ok: false`) by shape alone.

### Transparency is post-processing, not generation

The models are RGB. Asked for a "transparent background", Qwen paints a **grey checkerboard** —
that is the visual idiom it learned, not an alpha channel — and the pipeline would save RGB in any
case. So the request carries `transparent: true` and the API function cuts the background out
after the render, on CPU, which costs nothing next to a GPU second.

`matting.py` has two methods and picks one:

| Method | When | Why |
|---|---|---|
| Geometric key | flat illustration on a flat field | an exact mask: hard edges, every detail kept. This is most of what people want a cutout for |
| Model matte (u2net) | photographs and busy backgrounds | a key has nothing to hold on to |

Both are finished the same way: one pixel of erosion (the checkerboard is anti-aliased into the
subject's outline, and without that the cutout keeps a grey fringe on a light page) and a half
pixel of feather. The u2net mask is soft — an interior at alpha 254 is technically translucent —
so it is pushed through a curve first to make solid pixels solid.

`check_matting` proves the whole path on a synthetic red square, on CPU, for cents:

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_matting
```

### Loading order inside a class

Both classes do the same four things in the same order, because the order is part of the
correctness:

1. build the transformer from the checkpoint (`QwenImageTransformer2DModel`, bf16),
2. build the distillation scheduler,
3. construct the pipeline with both,
4. **then** `load_lora_weights()`, then `.to("cuda")`.

The load time is logged (`pipeline + 4-step LoRA on GPU in Ns`) so the cold-start share of a bill
is measurable rather than remembered.

---

## Cost model

Modal bills per second of a live container. H100 SXM5 is **$0.001097/s** ($3.95/hr).

The important subtlety, and the one that makes naive estimates wrong: **the 60-second scaledown
window is billed.** Modal's own pricing FAQ says containers stay alive "for 60 seconds after the
last inputs before we shut them down, which we also bill for". So a single isolated edit costs
its load, its work, *and* a minute of idle H100 — about 6.6 cents of pure waiting. Batching is
not an optimisation, it is the difference between 286 edits a month and 3,300.

### Measured

| | Work | + idle tail | Cost, isolated |
|---|---|---|---|
| Edit, warm | 3.6–5.3 s | 64 s | ~$0.07 |
| Edit, cold | 31.7 s load + edit | 95 s | ~$0.105 |
| Generate, warm | 3.3–3.9 s | 64 s | ~$0.07 |
| Generate, cold | 76.8 s wall, 3.9 s of it denoise | 134 s | ~$0.147 |

The first inference on a freshly loaded container is slower than the steady state (5.29 s versus
3.61 s for the same edit) because of kernel warm-up; both numbers are real, and the README quotes
the steady state for throughput and the first-run figure for what a user actually waits.

### What $30/month buys

| Pattern | Edits | Generations |
|---|---|---|
| Every request isolated (cold start each) | ~286 | ~204 |
| Batches of 5 in one sitting | ~1,240 | ~910 |
| Batches of 20 in one sitting | ~3,330 | ~2,600 |
| Marginal cost of one more, GPU already warm | **$0.004 → ~7,500** | **$0.0043 → ~7,000** |

The header chip shows the last row — the optimistic bound, because it assumes the GPU is already
warm. The honest planning numbers are the batch rows. `docs/COST.md` carries the longer argument.

### What would blow the budget

| Lever | Effect |
|---|---|
| `max_containers` raised above 1 | N concurrent requests = N H100s at once |
| `scaledown_window` raised | Every idle minute after the last edit is billed |
| `min_containers` set | A permanently warm H100 is **$2,848/month** |
| Alternating edit ↔ generate | Each switch pays a full cold start once the other container has scaled down |
| A shared public link | No rate limit exists; the $30 is the only ceiling |

GPU memory snapshots are **not** used: Modal's docs state they "do not speed up model loading
from storage" and may worsen it, and for a 53.76 GiB checkpoint initialisation is entirely
storage-bound.

---

## Setup from zero

### 0. Prerequisites

- [`uv`](https://docs.astral.sh/uv/) (Python 3.12+), Node 20+, `pnpm`
- a Modal account (Starter includes $30/month of compute)
- a Vercel account for the web half

### 1. Authenticate and install

```sh
modal setup                      # opens the browser
uv sync --all-packages           # the uv workspace: modal_app
```

### 2. Prove the dependency set — on a CPU, for cents

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env
```

This loads the processor, imports `peft`, checks that `diffusers` exports both pipeline classes,
and constructs the distillation scheduler. Everything it checks has failed at least once, and
every one of those failures only surfaced on a GPU. Run it before every deploy that touches the
image.

### 3. Pull the weights into the Volume (once, ~93 GiB total)

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights   # edit
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_t2i       # generate
uv run --package modal-app modal run modal_app/src/modal_app/app.py::volume_stats
```

Two checkpoints of ~54 GiB each, so ~108 GiB. Storage is free under 1 TiB, so this costs $0/month.
(`volume_stats` skips symlinks so it does not double-count a Hugging Face cache, which means it
reports less than the model sizes add up to — the figure to budget with is the one above.) Both functions `commit()` the Volume —
without that the writes vanish when the container exits and every cold start re-downloads
everything.

### 4. Prove both models actually run

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
    --prompt "make it snow" --image path/to/photo.jpg

uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
    --prompt "a red fox in falling snow" --aspect 1:1
```

Outputs land in `outputs/`. Each run costs a cold start (~$0.10–0.15).

### 5. Deploy the GPU service

```sh
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

It prints both endpoint URLs:

```text
https://<workspace>--image-editor-api.modal.run     POST  (proxy auth)
https://<workspace>--image-editor-usage.modal.run   GET   (proxy auth)
```

### 6. Create a proxy token

```sh
modal workspace proxy-tokens create
```

You get a `wk-…` id and a `ws-…` secret. This is what keeps the endpoint private: without it the
URL is a public GPU.

### 7. Point the web app at it

```sh
cd web
pnpm install
cp .env.example .env      # then fill in the three values
pnpm dev                  # http://localhost:3000
```

```dotenv
IMAGE_EDITOR_API_URL=https://<workspace>--image-editor-api.modal.run
MODAL_PROXY_TOKEN_ID=wk-...
MODAL_PROXY_TOKEN_SECRET=ws-...
```

The names are not cosmetic. `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET` are the **Modal CLI's** own
auth variables; these are **proxy** tokens for web-function auth. Exporting a proxy token under
the CLI's names breaks the CLI with `Token ID is malformed`.

**Never add a `VITE_` prefix.** TanStack Start inlines those into the browser bundle.

### 8. Deploy the web app

```sh
pnpm dlx vercel deploy --prod
```

Then set the same three variables in **Vercel → Settings → Environment Variables** and redeploy.
`web/vercel.json` declares `framework: tanstack-start`; Vercel builds through Nitro. The Hobby
plan allows up to 300 s per function, which fits a cold start plus an edit.

---

## Configuration reference

| Variable | Where | Required | What breaks without it |
|---|---|---|---|
| `IMAGE_EDITOR_API_URL` | Vercel env / `web/.env` | yes | `The editor is not available right now.` |
| `MODAL_PROXY_TOKEN_ID` | same | yes | same |
| `MODAL_PROXY_TOKEN_SECRET` | same | yes | same |
| `IMAGE_EDITOR_USAGE_URL` | optional | no | derived from the API URL by swapping `-api` → `-usage` |

Model and runtime constants live in `app.py` and are meant to be edited there:

| Constant | Value | Meaning |
|---|---|---|
| `MODEL_ID` / `T2I_MODEL_ID` | Qwen-Image-Edit-2511 / Qwen-Image-2512 | checkpoints |
| `DEFAULT_STEPS` | 4 | distilled path |
| `MAX_STEPS` | 60 | server-side clamp; the UI sends 4 |
| `MAX_IMAGES` | 3 | reference images per edit |
| `ASPECTS` | 7 buckets | trained output sizes |
| `MAX_EDGE` (web) | 1536 px | client-side downscale before upload |
| `MAX_UPLOAD_BYTES` (web) | 20 MB | rejected before decode |

---

## Verifying a deployment

| Question | Command |
|---|---|
| Do the dependencies import and does the scheduler build? | `modal run …::check_env` |
| Is the Volume intact? | `modal run …::volume_stats` |
| Does the edit model produce a sane image? | `modal run …::smoke --image … --prompt …` |
| Does the generate model? | `modal run …::smoke_generate --prompt …` |
| Does the transparency path work? | `modal run …::check_matting` |
| Is the app that is deployed the code I just wrote? | `modal app list`, then compare deploy time |

`smoke` and `smoke_generate` call the **deployed** class through `modal.Cls.from_name`, so they
test the deployment, not the file on disk.

---

## Troubleshooting

**A fix appears not to work.** `modal.Cls.from_name` resolves the *deployed* app, not your local
file, so after changing the image or a class you must `modal deploy` before a local smoke run can
see it. Skipping that makes a correct fix look broken while the deployed container crash-loops on
the old image.

**`ImportError: Qwen2VLVideoProcessor requires the Torchvision library`** — add `torchvision`.
**`ValueError: PEFT backend is required for load_lora_weights()`** — add `peft`. Both are the
same trap: nothing asks for them at import time, so the image builds clean and the failure lands
only on a GPU. `check_env` exists to catch exactly this for cents.

**`Unrecognized processing class in Qwen/Qwen-Image-Edit-2511`** — a healthy model. Components
live in subfolders; the processor needs `subfolder="processor"`.

**Faint grid over an otherwise plausible image** — the LoRA is attached to a default scheduler.
Rebuild it with `LIGHTNING_SCHEDULER_CONFIG`.

**A 401 from the web app** — the proxy token is wrong, not the model. The server logs Modal's
status and body so the two are distinguishable.

**The editor answered something unexpected** — the mode guard fired: the request asked for a
generate and got an edit (or vice versa). Check that the payload still carries `image_b64: []`
for generations.

**A cold start slower than it should be may be a crash loop.** Containers that repeatedly fail to
start still bill. Check `modal app logs` before optimising anything.

**A checkerboard appears in the generated image.** That is the *model* drawing a checkerboard
because the prompt asked for a transparent background — it is opaque grey pixels, not alpha. Turn
on the transparency toggle, or ask for "a plain solid white background" and cut it out later.

**A generation takes ~77 s the first time and ~4 s after.** Two checkpoints, two containers. Any
edit → generate switch after the 60 s window pays the full load again. Both classes log their own
`... on GPU in Ns` line, so the load/work split is checkable in `modal app logs` rather than
guessed.

---

## Known limits

- **`max_containers=1` per class serialises requests.** Two visitors at once means the second
  waits with no feedback until Vercel's 300 s cap returns a 504 — while the GPU bills the queue.
- **Cancel is not cancel.** `Stop waiting` abandons the client-side promise. Modal cannot cancel
  a call already running, so the GPU finishes and bills anyway. The copy says so rather than
  pretending otherwise.
- **No rate limiting.** Anyone with the URL can spend the credit; the $30 is the only ceiling.
  A per-IP limit on the server function is the obvious next guard.
- **The credit chip is optimistic.** It estimates from the warm edit cost and ignores cold
  starts and the idle tail.
- **No history.** One result at a time, and `Start over` discards it on purpose.

---

## Licence

Application code: do as you like. Model weights: **Apache 2.0** (Qwen), and the Lightning LoRAs
are **Apache 2.0** (LightX2V). Neither repo is gated, so no Hugging Face token is needed.
