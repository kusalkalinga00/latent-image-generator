Title (Medium field):
Create your own self-hosted image generator for free

Subtitle (Medium field):
Clone the repo, point it at your own Modal account, deploy.

Tags: AI, Machine Learning, Web Development, Side Project, Deployment
Cover: medium-cover.png

────────────────────────────────────────
DO NOT PASTE ANYTHING ABOVE THIS LINE
────────────────────────────────────────

A small image studio. Type a prompt and it generates an image. Attach a photo and it edits that photo instead. The model runs on Modal, the UI runs on Vercel, and you don't need a GPU on your machine.

It costs $0 for personal use. Modal's Starter plan gives $30 of compute a month and Vercel Hobby is free.

### Prerequisites

- Modal account
- Vercel account
- uv, Node 22, pnpm

### Lets start

Clone the repo and install dependencies.

```
git clone https://github.com/kusalkalinga00/latent-image-generator.git
cd latent-image-generator

modal setup
uv sync --all-packages
```

`modal setup` opens the browser and logs the CLI in.

Next, check that the dependencies load before you rent a GPU.

```
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env
```

This runs on CPU. You should see `processor_ok: true`, `lora_backend_ok: true` and `lightning_scheduler_ok: true` in the output. If one of them is false, the error says which one.

### Download the model

```
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights
```

33.1 GiB into a Modal Volume. The download runs on Modal, so nothing lands on your laptop.

Then check it.

```
uv run --package modal-app modal run modal_app/src/modal_app/app.py::volume_stats
```

You want `{"gib": 33.1, "files": 198}`. If the number is lower, run `download_weights` again, it resumes.

### Test it

```
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
    --prompt "a red fox in falling snow"
```

The PNG is written to `outputs/`. This run includes loading the weights, so it takes around 25 seconds and costs about $0.09.

Add `--transparent` to get an RGBA PNG with a transparent background instead.

### Deploy the model

```
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

It prints three URLs. Copy the one ending in `-api`.

### Create a proxy token

```
modal workspace proxy-tokens create
```

You get a `wk-...` id and a `ws-...` secret. Without these, anyone with the endpoint URL can use your GPU.

### Add the env file

```
cd web
pnpm install
cp .env.example .env
```

Fill in `web/.env`.

```
IMAGE_EDITOR_API_URL=https://<workspace>--image-editor-api.modal.run
MODAL_PROXY_TOKEN_ID=wk-...
MODAL_PROXY_TOKEN_SECRET=ws-...
```

Don't rename these to `MODAL_TOKEN_ID` or `MODAL_TOKEN_SECRET`, those are the Modal CLI's own variables and the CLI stops working. And don't add a `VITE_` prefix, TanStack inlines those into the browser bundle.

### Run it

```
pnpm dev
```

Open http://localhost:3000.

### Deploy the web app

```
pnpm dlx vercel deploy --prod
```

Run this from the repo root, not from `web/`.

Then add the same three variables in Vercel → Settings → Environment Variables and redeploy.

### Notes

- Image sizes are rounded down to a multiple of 32, so 1328 becomes 1312.
- Vercel rejects request bodies over 4.5 MB. The UI converts your uploads to WebP for this reason.
- A render costs about $0.07 when the GPU has to start, and $0.004 when you do a few in a row. The 60 seconds the container stays alive after the last request are billed too.
- If you swap the model, the scheduler values in `app.py` have to match that model's LoRA.

### Licence

The code is MIT. The model weights are not: Qwen-Image-2.1 is under the Qwen Research Licence, which is non-commercial use only.

Repo: https://github.com/kusalkalinga00/latent-image-generator
