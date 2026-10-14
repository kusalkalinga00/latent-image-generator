# image-editor

[Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) distilled to **4
steps**, running as a GPU service on [Modal](https://modal.com) with a React UI on Vercel.
Edit a photo by describing the change in plain language.

```
Browser (TanStack Start / React)
   |  posts an image to a server function
   v
Vercel -- src/lib/edit.ts        <- holds the Modal credential, never the browser
   |
   v
Modal -- Qwen-Image-Edit-2511 + 4-step Lightning LoRA on an H100
```

Two deliberate consequences of that shape:

- **The browser never talks to Modal.** No credential reaches a client, no CORS, and the
  endpoint cannot be scraped out of the page source. The token lives in Vercel's environment
  variables.
- **The GPU service serves no UI.** It answers JSON and nothing else. An earlier version
  embedded a Gradio app, which then needed its own password, its own secret, and its own
  failure modes - all of it removed, about 175 lines.

## Layout

| Path | What |
|---|---|
| `web/` | TanStack Start app (React 19, Tailwind 4) - deploy target: Vercel |
| `modal_app/` | the Modal GPU service (Python) |
| `docs/COST.md` | rates, budget, and what would blow it |

## Cost

Measured on an H100 with a 896x1184 image:

| | Measured | Cost |
|---|---|---|
| Load 53.76 GiB into VRAM (once per container) | 31.7 s | $0.035 |
| A 4-step edit | **3.61 s** | **$0.004** |
| First edit of a session | ~35 s | $0.039 |
| Each further edit while warm | ~3.6 s | $0.004 |

4 steps against 40 is **9.3x faster** - 3.61 s versus 33.53 s for the same image - which moves
the ceiling on a $30/month credit from roughly 810 edits to roughly **7,500**. That is the
single change that makes a public app viable.

Three things keep it there: `max_containers=1` (one GPU whatever the traffic),
`scaledown_window=60` (release it a minute after the last edit - a warm H100 for a month is
$2,848), and the 4-step distillation itself.

Not used, deliberately: **GPU memory snapshots.** Modal's docs say they "do not speed up model
loading from storage" and may worsen it, and for a 53.76 GiB checkpoint init *is*
storage-bound.

## Setup

### 1. The Modal service

```sh
modal setup                      # authenticate
uv sync --all-packages

# verify the dependency set on a CPU container - costs cents, not a GPU
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

# one-off: base weights + the 4-step LoRA into the Modal Volume (~54.6 GiB, storage free)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

# prove the distilled model runs, on a real GPU
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
    --prompt "make it snow" --image inputs/ref.png

uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

`modal deploy` prints the endpoint URL. Note it.

### 2. A proxy token

```sh
modal workspace proxy-tokens create
```

Gives a `wk-...` id and a `ws-...` secret. **This is what keeps the endpoint private**, and it
only ever lives server-side.

### 3. The web app

```sh
cd web
pnpm install
cp .env.example .env      # then fill in the three values
pnpm dev                  # http://localhost:3000
```

`.env` needs:

```
IMAGE_EDITOR_API_URL=https://<workspace>--image-editor-api.modal.run
MODAL_TOKEN_ID=wk-...
MODAL_TOKEN_SECRET=ws-...
```

**No `VITE_` prefix.** TanStack Start inlines `VITE_`-prefixed values into browser code, which
would hand the credential to every visitor. These three are read only inside the server
function.

### 4. Deploy to Vercel

```sh
cd web
pnpm dlx vercel deploy --prod
```

Then set the same three variables in **Vercel -> Settings -> Environment Variables** and
redeploy. `web/vercel.json` already declares `framework: tanstack-start`; Vercel detects the
build through Nitro.

## What is going on inside the model

The 4-step LoRA must be loaded onto a **rebuilt scheduler**, and this is the detail that decides
whether the output is good or garbage. The distillation used `shift=3`, so the pipeline gets a
`FlowMatchEulerDiscreteScheduler` with `base_shift` and `max_shift` both `math.log(3)`, plus
`shift_terminal=None`, `stochastic_sampling=False` and `use_dynamic_shifting=True`. Calling
`load_lora_weights()` on the pipeline's default scheduler is the mistake the Lightning repo
documents as grid artifacts - a faint grid over an otherwise plausible image, which is exactly
the kind of failure that survives a quick glance.

Guidance is 1.0: a distilled model is guidance-free. The Lightning reference passes no
`guidance_scale` at all while Qwen's 40-step example passes 1.0, so the code follows whichever
mode is in use rather than assuming they are interchangeable.

## Troubleshooting

**A fix appears not to work.** `modal.Cls.from_name` resolves the **deployed** app, not your
local file, so after changing the image or the `Editor` class you must `modal deploy` before a
local smoke run can see it. Skipping that makes a correct fix look broken while the deployed
container crash-loops on the old image.

**`ImportError: Qwen2VLVideoProcessor requires the Torchvision library`** - add `torchvision`.

**`ValueError: PEFT backend is required for load_lora_weights()`** - add `peft`.

Both are the same trap: nothing at import time asks for them, so the image builds clean and the
failure only lands on a GPU. `check_env` now loads the processor, imports `peft`, and constructs
the distillation scheduler, so the next one of these costs cents rather than a container.

**`Unrecognized processing class in Qwen/Qwen-Image-Edit-2511`** - a healthy model. Components
live in subfolders, so the processor needs `subfolder="processor"`.

**A 401 from the web app** means the proxy token is wrong, not that the model failed. The server
returns Modal's status and body so the two are distinguishable.

**A cold start slower than it should be may be a crash loop.** Containers that repeatedly fail to
start still bill. Check `modal app logs` before optimising.

## Licence

App code: do as you like. Model weights: **Apache 2.0** (Qwen), and the Lightning LoRA is
**Apache 2.0** (LightX2V). Neither is gated, so no Hugging Face token is needed.
