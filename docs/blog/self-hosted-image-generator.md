# Create your own self-hosted image generator for free

### Clone the MIT-licensed repo, point it at your own Modal account, and you have a working image editor in about an hour.

This is a guide to running my image app on your own accounts. You don't need a GPU. Nothing here
expects a local GPU, Docker, or a Hugging Face login. The model runs on Modal, the UI runs on
Vercel, and "self-hosted" means your account, your weights, your endpoint, and no API key belonging
to somebody else.

Total cost: **$0/month for personal use.** Modal's Starter plan includes $30 of compute a month,
which covers roughly 330 single renders or 3,500 in batches. The UI runs on Vercel Hobby, which is
free for non-commercial projects.

One thing to know before you start, because it decides what you can do with the result: the code is
MIT, the **model weights are not**. They're research-licensed, non-commercial. [Licence](#licence)
at the bottom has the details.

---

## What you're cloning

```
latent-image-generator/
├── modal_app/src/modal_app/app.py   GPU service: one class, three endpoints
├── web/                             TanStack Start app (React 19) + the server functions
└── scripts/edit.py                  small CLI client, useful for testing the endpoint
```

Two processes, one credential rule: the browser posts to a Vercel server function, that function
holds the Modal proxy token and calls the GPU service. The token never reaches a browser. If you
change one thing about this architecture, keep that.

The GPU service does both jobs with one model. Send an image and it edits; send only text and it
generates. There's no mode switch to get wrong.

---

## What you need

| | |
|---|---|
| [Modal](https://modal.com) account | Starter plan, $30/month of compute included |
| [Vercel](https://vercel.com) account | Hobby tier — free for non-commercial use |
| `uv` | Python 3.12+ |
| Node 22 + `pnpm` | for the web half |
| Disk space | none for weights — they download inside a Modal Volume (33.1 GiB) |

No credit card is needed for Modal's Starter plan, and no Hugging Face token is needed: neither repo
is gated.

---

## 1. Clone and install

```sh
git clone https://github.com/kusalkalinga00/latent-image-generator.git
cd latent-image-generator

uv sync --all-packages                   # installs the modal_app workspace, and the modal CLI with it
uv run --package modal-app modal setup   # opens a browser, writes ~/.modal.toml
```

`modal` comes from the workspace, not from your machine, so the sync has to happen first — a fresh
checkout has no `modal` command until it does. `modal setup` is a one-time CLI login.

---

## 2. Check the environment before you pay for a GPU

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env
```

Expected output, trimmed:

```json
{
  "torch": "2.15.0+cu132",
  "diffusers": "0.41.0",
  "transformers": "5.22.1",
  "pipeline": "QwenImage21Pipeline",
  "processor": "Qwen3VLProcessor",
  "processor_ok": true,
  "peft": "0.21.2",
  "lora_backend_ok": true,
  "lightning_scheduler": "FlowMatchEulerDiscreteScheduler",
  "lightning_scheduler_ok": true,
  "lora_bytes": 67144280,
  "lora_ok": true
}
```

This runs on CPU and costs cents. It exists because every failure it checks for — a missing
`torchvision`, a missing `peft`, a scheduler config that won't parse, a LoRA file that moved — only
shows up at model-load time, on a GPU, once you're already paying. Run it again after any change to
the Docker image.

If `processor_ok` is `false`, the model repo changed its layout; the error names the folder it
looked in.

---

## 3. Download the weights, once

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights
uv run --package modal-app modal run modal_app/src/modal_app/app.py::volume_stats
```

This pulls 33.1 GiB into a Modal Volume. It runs on Modal's CPU workers, so nothing lands on your
laptop. Storage is free under Modal's 1 TiB allowance.

`volume_stats` should print something like `{"gib": 33.1, "files": 198}`. If it prints much less,
the download was interrupted — run it again, Hugging Face resumes where it stopped.

Two details in that step that cost me time:

- The image sets `HF_HUB_DISABLE_XET=1`. Hugging Face's chunked transfer stalled at 28.2 of 33 GiB
  and never recovered; plain HTTP resumed and finished the remaining 5 GiB in seconds.
- `download_weights` calls `commit()` on the Volume. Without it the files are discarded when the
  container exits, and every cold start silently re-downloads 33 GiB.

---

## 4. Run it once, on your own account

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
    --prompt "a red fox in falling snow" --aspect 1:1
```

The PNG lands in `outputs/`. The first run includes the weight load, so it takes about 25 seconds
and costs roughly **$0.09**.

To check the alpha path, add `--transparent`. The result should be an RGBA PNG whose background is
fully transparent:

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
    --prompt "a cute cartoon mushroom sticker" --transparent
```

To exercise all three paths — generate, generate with alpha, edit — in a single cold start:

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::selftest
```

---

## 5. Deploy the GPU service

```sh
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

It prints three URLs:

```text
https://<workspace>--image-editor-api.modal.run      POST
https://<workspace>--image-editor-result.modal.run   GET
https://<workspace>--image-editor-usage.modal.run    GET
```

All three require proxy auth, so they're useless to anyone without the token. Copy the `-api` URL —
you need it in step 7.

---

## 6. Create a proxy token

```sh
uv run --package modal-app modal workspace proxy-tokens create
```

You get a `wk-…` id and a `ws-…` secret. This is the pair the web app sends as a bearer token.
Without it, the endpoint from step 5 is a public GPU that anyone can spend.

---

## 7. Run the UI locally

```sh
cd web
pnpm install
cp .env.example .env
```

Fill in three values in `web/.env`:

```dotenv
IMAGE_EDITOR_API_URL=https://<workspace>--image-editor-api.modal.run
MODAL_PROXY_TOKEN_ID=wk-...
MODAL_PROXY_TOKEN_SECRET=ws-...
```

```sh
pnpm dev        # http://localhost:3000
```

Three things to get right here, all of which have bitten me:

- **No `VITE_` prefix.** TanStack Start inlines `VITE_`-prefixed variables into browser code, which
  would hand your Modal credential to every visitor.
- **Don't rename them to `MODAL_TOKEN_ID` / `MODAL_TOKEN_SECRET`.** Those are the Modal *CLI's* auth
  variables; a proxy token exported under those names breaks the CLI with `Token ID is malformed`.
- **Restart the dev server after editing `.env`.** Vite reads it at boot.

---

## 8. Deploy the UI

The Vercel project's Root Directory is `web`, so the deploy runs from the **repository root**:

```sh
pnpm dlx vercel deploy --prod
```

Running it from inside `web/` makes Vercel look for `web/web` and fail with `The specified Root
Directory "web" does not exist`.

Then add the same three variables in **Vercel → Settings → Environment Variables** and redeploy. The
Hobby plan allows 300 seconds per function, which comfortably fits a cold start plus a render.

---

## What it costs, and where the money goes

An H100 on Modal is **$0.001097/second** ($3.95/hour). Two details decide whether that fits inside
the credit:

**The 60-second idle window is billed.** Containers stay alive a minute after the last request and
you pay for that minute. A single isolated render therefore costs about **$0.07**, of which $0.066
is waiting. Batched, a warm render is **$0.0041**.

**`max_containers=1`.** Not a rate limit — it's what stops a burst of traffic from starting several
GPUs at once. The trade is that concurrent requests queue behind each other.

| | Cost | Runs per month on $30 |
|---|---|---|
| Cold render (19.3 s load + 3.7 s work) | ~$0.09 | ~330 |
| Warm render, batched | ~$0.0041 | ~7,300 |

If testing feels expensive, it's almost always the idle tail: ten one-off renders cost more than a
single run of ten.

---

## Five things that will bite you

**Sizes snap to a 32-pixel grid.** The pipeline rounds to the nearest multiple of 32 and does it
silently — ask for 1328 and you get 1312. Every value in `ASPECTS` is already on the grid.

**Vercel rejects request bodies over 4.5 MB.** Base64 adds a third to whatever you upload, so a
3.7 MB PNG becomes 4.9 MB and the request is refused *before* your function runs — it looks like a
model failure, and nothing appears in your logs. The web app encodes attachments to WebP in the
browser and keeps them under 3.4 MB. If you raise the upload limit, watch this one.

**iOS Safari ignores `<a download>` on a `data:` URL.** The click silently does nothing, so on iOS
the app uses the share sheet. Everywhere else it downloads normally — and the gate is the platform,
not `navigator.canShare`, which returns true on desktop too.

**The scheduler config belongs to the LoRA version.** `base_shift 0.5`, `max_shift 0.9` and the
sigmas `[1.0, 0.75, 0.5, 0.25]` are the 2.1 distillation's. Older LoRAs used `log(3)`. Get it wrong
and you get a faint grid over an otherwise plausible image, not an error.

**`min_containers` will quietly spend your credit.** Leave it at zero. One always-warm H100 is
$2,848 a month.

---

## Licence

**The code is MIT.** Fork it, change it, ship your changes — see `LICENSE`.

**The weights are not.** `Qwen/Qwen-Image-2.1` is under the **Qwen Research Licence Agreement**,
which permits non-commercial use, defined as research or evaluation. Commercial use needs a separate
licence from Qwen. The 4-step LoRA declares no licence at all, and as a derivative of the base model
it inherits the base model's terms.

Vercel's Hobby tier is also non-commercial, so the free path and the legal path are the same path:
personal use. `MODEL-LICENSE.md` in the repo has the details.

---

## Changing the model

The model is two constants near the top of `modal_app/src/modal_app/app.py` — `MODEL_ID` and the LoRA
repo — plus `LIGHTNING_SCHEDULER_CONFIG`. Read the model card of whatever you swap in, copy its
scheduler values, and run `check_env` before deploying. It's a cheap way to find out that the new
checkpoint wants different settings.

Repo: **[github.com/kusalkalinga00/latent-image-generator](https://github.com/kusalkalinga00/latent-image-generator)**
