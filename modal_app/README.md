# modal_app

The Modal GPU service for `image-editor`. It answers JSON and nothing else — there
is no UI in here, by design (see the root README for why).

One model, one class:

| Class | Checkpoint | Job |
|---|---|---|
| `Image21` | `Qwen/Qwen-Image-2.1` + 4-step Lightning LoRA | change a photo **or** make a new one |

It is one class because it is one checkpoint: 33.1 GiB, 44 GB peak VRAM at the sizes
the app serves. An earlier build ran `Editor` (Edit-2511) and `Painter` (2512) as
separate classes — 53.7 GiB each, so they could not share an 80 GB card, and every
edit → generate switch paid a second cold start. The migration removed a class, a
Volume, the matting step, and half the load time.

```sh
# dependency + scheduler + LoRA check on a CPU container (cents, not a GPU)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

# one-off: pull the checkpoint into the Volume (33.1 GiB, storage free)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

# all three paths in one container: generate, generate+alpha, edit
uv run --package modal-app modal run modal_app/src/modal_app/app.py::selftest

# or one at a time
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke --image inputs/ref.png
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate --aspect 16:9

# deploy
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

All three endpoints require Modal proxy auth and scale to zero. See `docs/COST.md` for
the measured cost model — in particular, that the 60-second idle window is billed.

## Transparency

2.1 renders RGBA natively when asked in the phrasing it was trained on, so
`transparent: true` appends that phrasing, the model returns a real alpha channel,
and the render only clamps the 1–7/255 background haze to 0. `transparent` in the
response says whether an alpha channel actually came back — not whether one was
asked for.

The old path — a geometric key plus a u2net fallback in `matting.py`, with a
176 MB model in the image — is gone with the RGB-only checkpoints that needed it.

```sh
# prove it: writes an RGBA PNG and prints alpha=true
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
    --transparent --prompt "a cute cartoon dragon sticker"
```

## Sizes

Every side of every bucket is a multiple of 32, because the pipeline works on a
32-pixel latent grid and silently snaps what it is given (1328 → 1312). Editing
inherits the source image's size rather than resizing a photo the user did not ask
to resize.
