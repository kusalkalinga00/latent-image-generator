# image-editor

[Qwen-Image-Edit-2511](https://huggingface.co/Qwen/Qwen-Image-Edit-2511) hosted on
[Modal](https://modal.com) for personal use. An H100-backed image editor that runs
on demand, shuts down when you stop using it, and **never puts a model weight on
your machine.**

## What it does

Upload one to three reference images, describe the edit in plain language, get a
result back. The model is a 20B MMDiT with a Qwen2.5-VL text encoder — strong at
preserving a subject's identity while changing the scene, and unusually good at
editing **text inside images**.

## Where everything lives

| Thing | Location |
|---|---|
| Code | this repo (a few MB) |
| 57.7 GB of weights | a **Modal Volume** in Modal's cloud, mounted at `/models` |
| The download | runs in a Modal container, Hugging Face → Volume, **once ever** |
| Images you edit | passed in per request, never persisted |

Nothing is written to your disk except the code, and `inputs/` + `outputs/` which
are git-ignored.

## Cost

Modal's Starter plan includes **$30/month of compute**. GPU rates are per second:

| GPU | Rate | $30 buys |
|---|---|---|
| L40S 48 GB | $1.95/hr | 15.4 hr |
| A100 40 GB | $2.10/hr | 14.3 hr |
| A100 80 GB | $2.50/hr | 12.0 hr |
| **H100 80 GB** (this app) | **$3.95/hr** | **7.6 hr** |
| B200 180 GB | $6.25/hr | 4.8 hr |

Volume storage is $0.09/GiB-month **with the first 1 TiB free**, so the 57.7 GB
checkpoint costs **$0.00**.

### The only number that matters

Billing is per GPU-second, so the design is entirely about how long an H100 is
alive. Three decisions follow, and they are load-bearing rather than stylistic:

1. **`max_containers=1`** — a personal tool must never bill two H100s at once.
2. **`scaledown_window=60`** — the GPU is released a minute after the last edit.
   Keeping one H100 warm for a month would cost **$2,848**, or 95× the credit.
3. **The Gradio UI runs on a separate CPU-only container** that calls the GPU over
   Modal's internal RPC. This is the non-obvious one. A browser holding an open
   Gradio tab would otherwise keep the H100 alive while you read the result — at
   $3.95/hr. On a CPU container that same idle tab costs cents.

The trade is cold-start latency: the first edit after a pause waits while 57.7 GB
loads into VRAM. That is the honest cost of scale-to-zero, and it is the right
trade at $30/month.

### What was deliberately *not* done

**GPU memory snapshots.** Modal's own docs say snapshots "do not speed up model
loading from storage... and may even worsen them", because a snapshot helps with
CPU-bound initialization (imports, JIT) rather than bytes read from disk. For a
57.7 GB checkpoint, initialization *is* storage-bound, so a GPU snapshot would add
overhead and save nothing.

## Verified environment

Measured by `check_env` on a Modal CPU container — not copied from a README:

| Component | Version |
|---|---|
| torch | 2.14.1+cu130 |
| diffusers | 0.41.0 |
| transformers | 5.19.0 |
| `QwenImageEditPlusPipeline` present | yes |

Qwen's Quick Start tells you to install diffusers from git. The released
**0.41.0** already ships the pipeline class, so this image pins a release instead
and stays reproducible. Qwen also asks for `transformers>=4.51.3`; the resolver
picked 5.19.0, which satisfies it.

## Setup

Prerequisites: an Apple Silicon or any machine with Python 3.12+, `uv`, and a
Modal account.

```sh
# 1. authenticate (opens a browser; writes ~/.modal.toml)
uv tool install modal
modal setup

# 2. install the workspace
uv sync --all-packages

# 3. verify the dependency set can import the pipeline — CPU only, costs ~nothing
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

# 4. pull the weights into the Volume, once (~57.7 GB, 2-5 min, storage is free)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

# 5. a password for the Gradio UI — the UI refuses to serve without it
modal secret create image-editor-auth \
  GRADIO_USER=you GRADIO_PASSWORD=$(openssl rand -base64 24)

# 6. deploy
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

Step 6 prints two URLs: the Gradio UI and the JSON API.

### One real edit, no HTTP in the way

```sh
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
  --image inputs/ref.png --prompt "make it snow, keep the person unchanged"
```

Writes `outputs/smoke-ref.png` and prints how long the edit took. This goes
straight to the GPU class, so a failure here is unambiguously the model rather
than the web layer.

### The JSON API

Protected by Modal **proxy tokens**, so no secret lives in this repo. Create a
token in the Modal dashboard (Settings → Proxy Tokens) or
`modal workspace proxy-tokens`, then:

```sh
curl -X POST "$IMAGE_EDITOR_API_URL" \
  -H "Authorization: Bearer $MODAL_TOKEN_ID.$MODAL_TOKEN_SECRET" \
  -H 'Content-Type: application/json' \
  -d "{\"image_b64\": \"$(base64 -i inputs/ref.png)\", \"prompt\": \"make it night\"}"
```

Returns `{"ok": true, "image_b64": "...", "seconds": 41.2, ...}`.

## Layout

```
modal_app/src/modal_app/app.py    the whole deployment
docs/COST.md                      measured cost per edit
inputs/                           your test images (git-ignored)
outputs/                          results (git-ignored)
```

## Licence

App code: do as you like. Model weights: **Apache 2.0**, from Qwen — ungated,
so no Hugging Face token is required.
