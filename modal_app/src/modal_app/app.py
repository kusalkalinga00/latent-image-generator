"""Modal app hosting Qwen/Qwen-Image-Edit-2511 for personal use.

Everything here runs in Modal's cloud. No model weights ever touch the local
machine: the 57.7 GB checkpoint is pulled once into a Modal Volume and every
container after that reads it from there.

From the repo root:

    # 1. cheap CPU check that the image's dependency set can import the pipeline
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

    # 2. one-off: pull the weights into the Volume (~57.7 GB, free storage)
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

    # 3. deploy the Gradio UI + JSON endpoint
    uv run --package modal-app modal deploy modal_app/src/modal_app/app.py

Cost design, in one paragraph. Modal bills per GPU-second, so the only thing
that matters is how long an H100 is alive. Three decisions follow from that and
they are load-bearing:

  * ``max_containers=1`` - a personal tool must never bill two H100s at once.
  * ``scaledown_window=60`` - release the GPU a minute after the last edit
    rather than holding it. Holding one H100 warm for a month costs $2,848.
  * The Gradio UI runs on a **separate CPU-only** container that calls the GPU
    class over Modal's internal RPC. This is not tidiness: a browser holding an
    open Gradio tab would otherwise keep the H100 alive, and an idle H100 is
    $3.95/hr. On a CPU container the same idle tab costs cents.

GPU memory snapshots (``enable_gpu_snapshot``) are deliberately NOT used.
Modal's own docs say snapshots "do not speed up model loading from storage",
and for a 57.7 GB checkpoint initialization is entirely storage-bound - so the
snapshot would add overhead and save nothing.
"""

from __future__ import annotations

import io
from typing import Any

import modal

APP_NAME = "image-editor"
MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
VOLUME_NAME = "image-editor-weights"
MODEL_CACHE = "/models/hf"

# 2511 accepts multiple reference images; cap it so one call cannot balloon VRAM.
MAX_IMAGES = 3
MAX_STEPS = 60
DEFAULT_STEPS = 40

# Gradio UI credentials live in this Modal Secret, never in the repo.
AUTH_SECRET_NAME = "image-editor-auth"

app = modal.App(APP_NAME)
weights = modal.Volume.from_name(VOLUME_NAME, create_if_missing=True)


# --------------------------------------------------------------------------- #
# Images
# --------------------------------------------------------------------------- #

gpu_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("git")
    .uv_pip_install(
        "torch",
        # Not optional: the pipeline's Qwen2VL video/image processor imports
        # Torchvision, and without it the model fails to load. It is the wheel
        # that is easiest to forget because nothing at import time asks for it.
        "torchvision",
        # Qwen's README says "install the latest diffusers from git". That was
        # true on release day; 0.41.0 (2026-10-06) ships
        # QwenImageEditPlusPipeline, so a pinned release works and the build is
        # reproducible instead of tracking main.
        "diffusers==0.41.0",
        "transformers>=4.51.3",  # Qwen2.5-VL support, per Qwen's Quick Start
        "accelerate",
        "safetensors",
        "sentencepiece",
        "protobuf",
        "pillow",
        "huggingface_hub",
        "einops",
    )
    .env({"HF_HOME": MODEL_CACHE, "HF_HUB_DISABLE_TELEMETRY": "1"})
)

# The web layer holds no model and needs no torch - a light image keeps its cold
# start and its idle cost small.
web_image = (
    modal.Image.debian_slim(python_version="3.12")
    .uv_pip_install("fastapi[standard]", "gradio", "pillow")
)


def _ui_secrets() -> list[modal.Secret]:
    """Attach the UI password secret if it exists, without requiring it.

    This asks the API what exists rather than calling ``Secret.from_name`` and
    catching. ``from_name`` is lazy: it hands back an unresolved handle and only
    fails once Modal materialises it, which is too late to catch here and takes
    the whole module down with it - including `check_env` and `download_weights`,
    which need no secret at all. Measured the hard way.
    """
    try:
        existing = {s.name for s in modal.Secret.objects.list()}
    except Exception as exc:  # offline, or an API change
        print(f"[image-editor] could not list secrets ({exc}); assuming none.")
        return []

    if AUTH_SECRET_NAME in existing:
        return [modal.Secret.from_name(AUTH_SECRET_NAME)]

    print(
        f"[image-editor] secret {AUTH_SECRET_NAME!r} not found. The Gradio UI will serve\n"
        f"[image-editor] a setup page instead of an editor until you create it:\n"
        f"[image-editor]     modal secret create {AUTH_SECRET_NAME} "
        "GRADIO_USER=you GRADIO_PASSWORD=$(openssl rand -base64 24)"
    )
    return []


# --------------------------------------------------------------------------- #
# Setup / verification functions (CPU-only, no GPU billing)
# --------------------------------------------------------------------------- #


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=900, cpu=2)
def check_env() -> str:
    """Prove the dependency set can load the pipeline's front end, before paying for a GPU.

    An image build is slow and an H100 container is expensive; this runs the risky
    part of initialization on a CPU container for fractions of a cent.

    It loads the **processor**, not just the modules, and that distinction cost a
    wasted H100 container to learn. The first version only imported diffusers,
    transformers and torch and reported everything healthy - while the real load
    died on

        ImportError: Qwen2VLVideoProcessor requires the Torchvision library

    because the processor pulls torchvision in lazily, at model-load time, on a
    GPU. Importing a library does not exercise it. The processor is small (config
    and tokenizer, not the 40 GB transformer) so loading it here is cheap, and the
    Volume is mounted so it is a cache hit rather than a download.

    Returns a JSON *string*, and coerces every field to a plain str/bool. Modal
    unpickles the return value in the **local** environment, which has no torch,
    so handing back anything carrying a torch-defined class fails with a
    misleading "the 'torch' module is not available in the local environment".
    """
    import json

    import diffusers
    import torch
    import torchvision
    import transformers

    info = {
        "torch": str(torch.__version__),
        "torchvision": str(torchvision.__version__),
        "diffusers": str(diffusers.__version__),
        "transformers": str(transformers.__version__),
        "has_qwen_image_edit_plus": bool(hasattr(diffusers, "QwenImageEditPlusPipeline")),
        "cuda_available_on_cpu_container": bool(torch.cuda.is_available()),
    }

    # subfolder="processor" is required, and getting that wrong produces a
    # *false alarm* rather than a miss: this repo keeps every component in its own
    # subfolder and has no root-level processing class, so
    # AutoProcessor.from_pretrained(MODEL_ID) reports "Unrecognized processing
    # class in Qwen/Qwen-Image-Edit-2511" against a perfectly good model. A check
    # that cries wolf is worse than no check, so the subfolder is asserted against
    # model_index.json's declared component, `Qwen2VLProcessor` - which is also the
    # class that needs torchvision and started all this.
    from transformers import AutoProcessor

    try:
        processor = AutoProcessor.from_pretrained(MODEL_ID, subfolder="processor")
        info["processor"] = type(processor).__name__
        info["processor_is_qwen2vl"] = type(processor).__name__.startswith("Qwen2VL")
        info["processor_ok"] = True
    except Exception as exc:
        info["processor"] = f"{type(exc).__name__}: {exc}"
        info["processor_ok"] = False

    print("[image-editor] env: " + json.dumps(info, indent=2))
    return json.dumps(info)


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=5400, cpu=4)
def download_weights() -> dict[str, Any]:
    """Pull the checkpoint into the Volume once. Subsequent boots hit the cache."""
    import os
    import time

    from huggingface_hub import snapshot_download

    started = time.time()
    path = snapshot_download(MODEL_ID, max_workers=8)

    total = 0
    for root, _dirs, files in os.walk(MODEL_CACHE):
        for name in files:
            fp = os.path.join(root, name)
            if os.path.isfile(fp) and not os.path.islink(fp):
                total += os.path.getsize(fp)

    # commit() is what makes the download durable - without it the Volume's
    # writes vanish when the container exits and every cold start re-downloads.
    weights.commit()

    return {
        "path": path,
        "bytes": total,
        "gib": round(total / 1024**3, 2),
        "seconds": round(time.time() - started, 1),
    }


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=900, cpu=2)
def volume_stats() -> str:
    """Report what is actually in the Volume. Measured, not assumed.

    `modal run` does not echo a Function's return value, so a size reported only
    through the return path is invisible. Returns JSON and prints it.
    """
    import json
    import os

    files = 0
    total = 0
    for root, _dirs, names in os.walk(MODEL_CACHE):
        for name in names:
            path = os.path.join(root, name)
            # HF caches store real bytes in blobs/ and link them into snapshots/;
            # counting symlinks too would roughly double the reported size.
            if os.path.islink(path):
                continue
            files += 1
            total += os.path.getsize(path)

    info = {"files": files, "bytes": total, "gib": round(total / 1024**3, 2)}
    print("[image-editor] volume: " + json.dumps(info))
    return json.dumps(info)


# --------------------------------------------------------------------------- #
# The model
# --------------------------------------------------------------------------- #


@app.cls(
    image=gpu_image,
    gpu="H100",
    volumes={"/models": weights},
    timeout=1200,
    scaledown_window=60,
    max_containers=1,
)
class Editor:
    @modal.enter()
    def load(self) -> None:
        import time

        import torch
        from diffusers import QwenImageEditPlusPipeline

        started = time.time()
        self.pipe = QwenImageEditPlusPipeline.from_pretrained(
            MODEL_ID, torch_dtype=torch.bfloat16
        )
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)
        # Logged so the cold-start share of a bill is visible rather than guessed.
        print(f"[image-editor] pipeline on GPU in {time.time() - started:.1f}s")

    @modal.method()
    def edit(
        self,
        images: list[bytes],
        prompt: str,
        steps: int = DEFAULT_STEPS,
        cfg: float = 4.0,
        seed: int = 0,
    ) -> dict[str, Any]:
        """Edit one image (or compose several) with a natural-language prompt."""
        import time

        import torch
        from PIL import Image

        if not images:
            raise ValueError("at least one image is required")
        if len(images) > MAX_IMAGES:
            raise ValueError(f"at most {MAX_IMAGES} images are supported")
        if not prompt.strip():
            raise ValueError("prompt must not be empty")

        steps = max(1, min(int(steps), MAX_STEPS))
        pil: list[Image.Image] = []
        for raw in images:
            img = Image.open(io.BytesIO(raw))
            img.load()
            pil.append(img.convert("RGB"))

        # Parameter set matches Qwen's official 2511 example exactly
        # (true_cfg_scale 4.0, negative_prompt " ", guidance_scale 1.0).
        generator = torch.Generator(device="cuda").manual_seed(int(seed))

        started = time.time()
        with torch.inference_mode():
            result = self.pipe(
                image=pil,
                prompt=prompt,
                generator=generator,
                true_cfg_scale=float(cfg),
                negative_prompt=" ",
                num_inference_steps=steps,
                guidance_scale=1.0,
                num_images_per_prompt=1,
            )
        elapsed = time.time() - started

        buf = io.BytesIO()
        result.images[0].save(buf, format="PNG")
        return {
            "png": buf.getvalue(),
            "seconds": round(elapsed, 2),
            "steps": steps,
            "input_images": len(pil),
            "size": list(result.images[0].size),
        }


def _editor() -> Any:
    """Resolve the deployed GPU class (from a web container or a local entrypoint)."""
    return modal.Cls.from_name(APP_NAME, "Editor")


def _run_edit(
    images: list[bytes], prompt: str, steps: int, cfg: float, seed: int
) -> dict[str, Any]:
    """The one place that calls the GPU. Used by the UI, the API and the smoke test.

    All three share it so a change to the model's calling convention cannot land
    in one path and miss the others.
    """
    return _editor()().edit.remote(
        images=images, prompt=prompt, steps=int(steps), cfg=float(cfg), seed=int(seed)
    )


# --------------------------------------------------------------------------- #
# Gradio UI (CPU container, calls the GPU class over RPC)
# --------------------------------------------------------------------------- #


@app.function(
    image=web_image,
    secrets=_ui_secrets(),
    timeout=1200,
    scaledown_window=300,
    max_containers=2,
)
@modal.concurrent(max_inputs=8)
@modal.asgi_app()
def ui() -> Any:
    import os

    import gradio as gr
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse
    from gradio.routes import mount_gradio_app
    from PIL import Image

    user = os.environ.get("GRADIO_USER")
    password = os.environ.get("GRADIO_PASSWORD")

    # Fail closed. An unauthenticated endpoint backed by an H100 is an open
    # invitation to spend someone else's credit, so a missing secret serves an
    # explanation rather than an editor.
    if not (user and password):
        return _misconfigured_app()

    def run_edit(image, prompt, steps, cfg, seed, progress=gr.Progress()):
        if image is None:
            raise gr.Error("Upload an image first.")
        if not (prompt or "").strip():
            raise gr.Error("Describe the edit you want.")

        def encode(im):
            buf = io.BytesIO()
            im.convert("RGB").save(buf, format="PNG")
            return buf.getvalue()

        payload = image if isinstance(image, list) else [image]
        progress(0.05, desc="Booting the editor (cold start loads 57.7 GB)...")

        out = _run_edit([encode(im) for im in payload], prompt, steps, cfg, seed)
        progress(1.0, desc="Done")
        return Image.open(io.BytesIO(out["png"])), (
            f"{out['seconds']}s · {out['steps']} steps · {out['size'][0]}x{out['size'][1]}"
        )

    with gr.Blocks(title="image-editor") as demo:
        gr.Markdown(
            "## image-editor\n"
            "Qwen-Image-Edit-2511 on Modal. Runs on demand and shuts down after "
            "a minute idle, so the first edit after a pause waits for a cold start."
        )
        with gr.Row():
            with gr.Column():
                inputs = gr.File(
                    label=f"Reference image(s) - up to {MAX_IMAGES}",
                    file_count="multiple",
                    type="pil",
                )
                prompt = gr.Textbox(
                    label="Edit instruction",
                    placeholder="Make the sky a dramatic sunset and keep the subject unchanged",
                    lines=3,
                )
                with gr.Row():
                    steps = gr.Slider(4, MAX_STEPS, value=DEFAULT_STEPS, step=1, label="Steps")
                    cfg = gr.Slider(1.0, 8.0, value=4.0, step=0.5, label="true_cfg_scale")
                seed = gr.Number(value=0, label="Seed", precision=0)
                go = gr.Button("Edit", variant="primary")
            with gr.Column():
                output = gr.Image(label="Result", type="pil")
                meta = gr.Markdown()

        go.click(run_edit, [inputs, prompt, steps, cfg, seed], [output, meta])
        prompt.submit(run_edit, [inputs, prompt, steps, cfg, seed], [output, meta])

    return mount_gradio_app(
        app=FastAPI(),
        blocks=demo,
        path="/",
        auth=(user, password),
        auth_message="image-editor is private.",
    )


def _misconfigured_app() -> Any:
    from fastapi import FastAPI
    from fastapi.responses import HTMLResponse

    page = FastAPI()

    @page.get("/", response_class=HTMLResponse)
    def _explain() -> str:
        return (
            "<html><body style='font-family:ui-sans-serif;max-width:44rem;margin:4rem auto'>"
            "<h2>image-editor is not configured yet</h2>"
            "<p>The Gradio UI needs a password before it will serve, so that an "
            "H100-backed endpoint is never open to the internet.</p>"
            f"<p>Create the secret, then redeploy:</p>"
            f"<pre>modal secret create {AUTH_SECRET_NAME} "
            "GRADIO_USER=you GRADIO_PASSWORD=$(openssl rand -base64 24)</pre>"
            "</body></html>"
        )

    return page


# --------------------------------------------------------------------------- #
# JSON API (proxy-token protected)
# --------------------------------------------------------------------------- #


@app.function(image=web_image, timeout=1200)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def api(payload: dict[str, Any]) -> dict[str, Any]:
    """JSON edit endpoint.

    Auth is Modal proxy tokens, so no secret lives in this codebase. Curl it with:

        curl -X POST <url> \\
          -H "Authorization: Bearer $MODAL_TOKEN_ID.$MODAL_TOKEN_SECRET" \\
          -H 'Content-Type: application/json' \\
          -d '{"image_b64": "...", "prompt": "make it night"}'

    Images travel base64-encoded in both directions.
    """
    import base64

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}

    raw = payload.get("image_b64") or payload.get("images_b64") or []
    if isinstance(raw, str):
        raw = [raw]
    if not raw:
        return {"ok": False, "error": "image_b64 is required"}
    if len(raw) > MAX_IMAGES:
        return {"ok": False, "error": f"at most {MAX_IMAGES} images"}

    try:
        decoded = [base64.b64decode(item) for item in raw]
    except Exception as exc:
        return {"ok": False, "error": f"image_b64 is not valid base64: {exc}"}

    out = _run_edit(
        decoded,
        prompt,
        payload.get("steps", DEFAULT_STEPS),
        payload.get("cfg", 4.0),
        payload.get("seed", 0),
    )
    return {
        "ok": True,
        "image_b64": base64.b64encode(out["png"]).decode("ascii"),
        "seconds": out["seconds"],
        "steps": out["steps"],
        "size": out["size"],
    }


@app.local_entrypoint()
def smoke(
    prompt: str = "Turn the sky into a dramatic sunset, keep everything else unchanged",
    image: str = "",
) -> None:
    """One real edit on the deployed GPU class. No HTTP and no auth in the way.

    The point is to exercise the expensive path (weight load -> GPU -> edit)
    without the web layer, so a failure here is unambiguously the model's:

        uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
            --prompt "make it snow" --image inputs/ref.jpg
    """
    import pathlib

    if image:
        image_path = pathlib.Path(image)
    else:
        candidates = sorted(
            p for p in pathlib.Path("inputs").glob("*") if p.is_file()
        ) if pathlib.Path("inputs").exists() else []
        if not candidates:
            raise SystemExit(
                "No image given and nothing under ./inputs - pass --image <path>."
            )
        image_path = candidates[0]

    if not image_path.is_file():
        raise SystemExit(f"not a file: {image_path}")

    out = _run_edit(
        [image_path.read_bytes()], prompt, DEFAULT_STEPS, 4.0, 0
    )

    out_dir = pathlib.Path("outputs")
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"smoke-{image_path.stem}.png"
    target.write_bytes(out["png"])
    print(
        f"edited {image_path} -> {target} in {out['seconds']}s "
        f"({out['steps']} steps, {out['size'][0]}x{out['size'][1]})"
    )
