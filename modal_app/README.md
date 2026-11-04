# modal_app

The Modal GPU service for `image-editor`. It answers JSON and nothing else — there
is no UI in here, by design (see the root README for why).

Two models, two classes:

| Class | Checkpoint | Job |
|---|---|---|
| `Editor` | `Qwen/Qwen-Image-Edit-2511` + 4-step Lightning LoRA | change a photo |
| `Painter` | `Qwen/Qwen-Image-2512` + 4-step Lightning LoRA | make a new one |

They are separate classes because both checkpoints are ~54 GiB and cannot be
resident on one 80 GB card.

```sh
# dependency + scheduler check on a CPU container (cents, not a GPU)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

# one-off: pull the checkpoints into the Volume (~108 GiB total, storage free)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_t2i

# prove each one runs on a real GPU
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke --image inputs/ref.png
uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate --aspect 16:9

# deploy
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

Both endpoints require Modal proxy auth and scale to zero. See `docs/COST.md` for
the measured cost model — in particular, that the 60-second idle window is billed.

## Transparency

The models render RGB and cannot emit alpha; asked for a transparent background
they paint a checkerboard. `transparent: true` on the request cuts the background
out afterwards in the CPU container (`matting.py`: geometric key for flat art,
u2net for photos), and `transparent` in the response says whether it worked.

```sh
# prove the cutout path without renting a GPU
uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_matting

# cache the 176 MB u2net weights in the Volume (one-off)
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_matting
```
