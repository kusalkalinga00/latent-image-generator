# modal_app

The Modal deployment package for `image-editor`.

```sh
# one-off: pull 57.7 GB of Qwen-Image-Edit-2511 weights into the Modal Volume
uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

# deploy (Gradio UI + JSON endpoint)
uv run --package modal-app modal deploy modal_app/src/modal_app/app.py
```

Both endpoints scale to zero. See `docs/COST.md` for the measured cost model.
