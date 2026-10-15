"""Modal GPU backend for Qwen-Image-Edit-2511, running the 4-step Lightning LoRA.

This is the **model service only**. The web UI is a separate TanStack Start app on
Vercel that calls this over HTTPS. That split is deliberate: the browser never
talks to Modal, so no credential ever needs to reach a client, and this endpoint
stays behind proxy auth. It is also why there is no Gradio app here any more - a
UI living inside the GPU service ends up needing its own auth, its own secret, and
its own failure modes for no benefit.

Everything runs in Modal's cloud. No model weight ever touches a local machine:
the checkpoint goes into a Modal Volume once and every container after reads it
from there.

From the repo root:

    # cheap CPU check that the dependency set loads the pipeline's front end
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

    # one-off: pull the base weights + the 4-step LoRA into the Volume
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

    # verify the distilled model actually runs, on a real GPU
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
        --prompt "make it snow" --image inputs/ref.png

    uv run --package modal-app modal deploy modal_app/src/modal_app/app.py

Cost design. Billing is per GPU-second, so one thing matters: how long an H100 is
alive.

  * ``max_containers=1`` - one GPU at a time whatever the traffic. Not a rate
    limit; it is what stops a burst of concurrent requests billing N GPUs.
  * ``scaledown_window=60`` - release the GPU a minute after the last edit.
    Holding one H100 warm for a month costs $2,848.
  * **4 steps instead of 40** - the biggest lever by far, and the reason a public
    app is viable on a $30/month credit. The Lightning LoRA is a distillation of
    the base model, published by LightX2V and linked from Qwen's own README.

GPU memory snapshots are deliberately NOT used: Modal's docs state they "do not
speed up model loading from storage" and may worsen it, and for a 53.76 GiB
checkpoint initialization is entirely storage-bound.
"""

from __future__ import annotations

import io
import math
from decimal import Decimal
from typing import Any

import modal

APP_NAME = "image-editor"
MODEL_ID = "Qwen/Qwen-Image-Edit-2511"
VOLUME_NAME = "image-editor-weights"
MODEL_CACHE = "/models/hf"

# The 4-step distilled LoRA: Apache-2.0, 0.85 GB, published for 2511 specifically
# (not the 2509 or text-to-image variants, which are different repos).
LORA_REPO = "lightx2v/Qwen-Image-Edit-2511-Lightning"
LORA_FILE = "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors"

# 2511 accepts multiple reference images; cap it so one call cannot balloon VRAM.
MAX_IMAGES = 3
MAX_STEPS = 60

LIGHTNING_STEPS = 4
STANDARD_STEPS = 40
DEFAULT_STEPS = LIGHTNING_STEPS
DEFAULT_CFG = 1.0  # guidance-free, which is how the distilled model was trained

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
        # Required, and required invisibly: the pipeline's Qwen2.5-VL processor
        # imports Torchvision lazily at load time, so the image builds happily
        # without it and the model then dies on the GPU.
        "torchvision",
        # Qwen's README says install diffusers from git. 0.41.0 ships
        # QwenImageEditPlusPipeline, so a pinned release is reproducible.
        "diffusers==0.41.0",
        # Also invisible until load time: diffusers raises "PEFT backend is
        # required for load_lora_weights()" only when the LoRA is attached, so the
        # image builds and the pipeline constructs fine without it.
        "peft",
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

# The API layer holds no model, so it needs no torch: it decodes JSON, calls the
# GPU class, and encodes the result. A light image keeps its cold start and its
# idle cost near zero.
api_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "fastapi[standard]"
)

# The distillation scheduler. This cannot be inferred from the LoRA file - it is a
# property of how the model was distilled, and loading the LoRA onto the pipeline's
# *default* scheduler is the mistake the Lightning repo documents as grid
# artifacts. Lifted from their generate_with_diffusers.py, where the comment reads
# "We use shift=3 in distillation".
LIGHTNING_SCHEDULER_CONFIG = {
    "base_image_seq_len": 256,
    "base_shift": math.log(3),
    "invert_sigmas": False,
    "max_image_seq_len": 8192,
    "max_shift": math.log(3),
    "num_train_timesteps": 1000,
    "shift": 1.0,
    "shift_terminal": None,
    "stochastic_sampling": False,
    "time_shift_type": "exponential",
    "use_beta_sigmas": False,
    "use_dynamic_shifting": True,
    "use_exponential_sigmas": False,
    "use_karras_sigmas": False,
}


# --------------------------------------------------------------------------- #
# Setup / verification (CPU only, no GPU billing)
# --------------------------------------------------------------------------- #


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=900, cpu=2)
def check_env() -> str:
    """Prove the dependency set can load the pipeline's front end before paying for a GPU.

    It loads the **processor**, not just the modules, and that distinction cost a
    wasted H100 container to learn: importing a library does not exercise it, and
    torchvision was missing from an image that imported everything successfully.

    Returns a JSON *string* and coerces every field to a plain str/bool. Modal
    unpickles the return value in the **local** environment, which has no torch, so
    anything carrying a torch-defined class fails to deserialize with a misleading
    "the 'torch' module is not available in the local environment".
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
        "has_qwen_image_edit_plus": bool(
            hasattr(diffusers, "QwenImageEditPlusPipeline")
        ),
    }

    # subfolder="processor" is required. This repo keeps every component in its own
    # subfolder and has no root-level processing class, so a root-level lookup
    # reports "Unrecognized processing class" against a perfectly healthy model -
    # a false alarm, which is worse than no check at all.
    from transformers import AutoProcessor

    try:
        processor = AutoProcessor.from_pretrained(MODEL_ID, subfolder="processor")
        info["processor"] = type(processor).__name__
        info["processor_ok"] = True
    except Exception as exc:
        info["processor"] = f"{type(exc).__name__}: {exc}"
        info["processor_ok"] = False

    # Mirror the exact imports the Lightning path needs, and build the distillation
    # scheduler for real. Two separate missing-backend failures (torchvision, then
    # peft) both surfaced only at model-load time on a GPU; checking that the
    # imports resolve and the scheduler constructs turns the third one into a
    # couple of cents. Constructing the scheduler is what actually validates
    # LIGHTNING_SCHEDULER_CONFIG, which is otherwise only exercised on an H100.
    from diffusers import FlowMatchEulerDiscreteScheduler

    try:
        from diffusers.models import QwenImageTransformer2DModel  # noqa: F401

        info["lightning_imports_ok"] = True
    except Exception as exc:
        info["lightning_imports_ok"] = False
        info["lightning_imports_error"] = f"{type(exc).__name__}: {exc}"

    try:
        import peft

        info["peft"] = str(peft.__version__)
        info["lora_backend_ok"] = True
    except Exception as exc:
        info["peft"] = f"{type(exc).__name__}: {exc}"
        info["lora_backend_ok"] = False

    try:
        sched = FlowMatchEulerDiscreteScheduler.from_config(LIGHTNING_SCHEDULER_CONFIG)
        info["lightning_scheduler"] = type(sched).__name__
        info["lightning_scheduler_ok"] = True
    except Exception as exc:
        info["lightning_scheduler"] = f"{type(exc).__name__}: {exc}"
        info["lightning_scheduler_ok"] = False

    print("[image-editor] env: " + json.dumps(info, indent=2))
    return json.dumps(info)


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=5400, cpu=4)
def download_weights() -> str:
    """Pull the checkpoint and the LoRA into the Volume, once. Commits, so it persists."""
    import json
    import os
    import time

    from huggingface_hub import hf_hub_download, snapshot_download

    started = time.time()
    path = snapshot_download(MODEL_ID, max_workers=8)
    lora_path = hf_hub_download(repo_id=LORA_REPO, filename=LORA_FILE)

    total = 0
    for root, _dirs, names in os.walk(MODEL_CACHE):
        for name in names:
            full = os.path.join(root, name)
            # An HF cache stores real bytes in blobs/ and links them into
            # snapshots/; counting symlinks too would roughly double the figure.
            if os.path.islink(full):
                continue
            total += os.path.getsize(full)

    # Without commit() the writes vanish when the container exits, and every cold
    # start silently re-downloads the whole thing.
    weights.commit()

    info = {
        "model_path": path,
        "lora_path": lora_path,
        "bytes": total,
        "gib": round(total / 1024**3, 2),
        "seconds": round(time.time() - started, 1),
    }
    print("[image-editor] downloaded: " + json.dumps(info))
    return json.dumps(info)


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=900, cpu=2)
def volume_stats() -> str:
    """Report what is actually in the Volume. Measured, not assumed."""
    import json
    import os

    files = 0
    total = 0
    for root, _dirs, names in os.walk(MODEL_CACHE):
        for name in names:
            full = os.path.join(root, name)
            if os.path.islink(full):
                continue
            files += 1
            total += os.path.getsize(full)

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
        from diffusers import (
            FlowMatchEulerDiscreteScheduler,
            QwenImageEditPlusPipeline,
        )
        from diffusers.models import QwenImageTransformer2DModel
        from huggingface_hub import hf_hub_download

        started = time.time()

        # Same construction order as the Lightning reference script: build the
        # transformer, hand the pipeline the distillation scheduler, and attach the
        # LoRA last. Loading the LoRA onto a default-scheduler pipeline is exactly
        # the mistake their README documents as grid artifacts.
        transformer = QwenImageTransformer2DModel.from_pretrained(
            MODEL_ID, subfolder="transformer", torch_dtype=torch.bfloat16
        )
        scheduler = FlowMatchEulerDiscreteScheduler.from_config(
            LIGHTNING_SCHEDULER_CONFIG
        )
        self.pipe = QwenImageEditPlusPipeline.from_pretrained(
            MODEL_ID,
            transformer=transformer,
            scheduler=scheduler,
            torch_dtype=torch.bfloat16,
        )
        lora_path = hf_hub_download(repo_id=LORA_REPO, filename=LORA_FILE)
        self.pipe.load_lora_weights(lora_path)
        self.pipe.to("cuda")
        self.pipe.set_progress_bar_config(disable=True)

        # Logged so the cold-start share of a bill is visible rather than guessed.
        print(
            f"[image-editor] pipeline + 4-step LoRA on GPU in "
            f"{time.time() - started:.1f}s"
        )

    @modal.method()
    def edit(
        self,
        images: list[bytes],
        prompt: str,
        steps: int = DEFAULT_STEPS,
        cfg: float = DEFAULT_CFG,
        seed: int = 0,
    ) -> dict[str, Any]:
        """Edit one image, or compose several, from a natural-language instruction."""
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

        generator = torch.Generator(device="cuda").manual_seed(int(seed))
        kwargs: dict[str, Any] = {
            "image": pil,
            "prompt": prompt,
            "generator": generator,
            "true_cfg_scale": float(cfg),
            "negative_prompt": " ",  # what the edit models expect
            "num_inference_steps": steps,
        }
        # The Lightning reference passes no guidance_scale at all, while Qwen's
        # 40-step example passes 1.0. Follow whichever mode is in use rather than
        # assuming the two are interchangeable.
        if steps > LIGHTNING_STEPS:
            kwargs["guidance_scale"] = 1.0

        started = time.time()
        with torch.inference_mode():
            result = self.pipe(**kwargs)
        elapsed = time.time() - started

        buf = io.BytesIO()
        result.images[0].save(buf, format="PNG")
        return {
            "png": buf.getvalue(),
            "seconds": round(elapsed, 2),
            "steps": steps,
            "cfg": float(cfg),
            "input_images": len(pil),
            "size": list(result.images[0].size),
        }


def _editor() -> Any:
    """Resolve the deployed GPU class, from a web container or a local entrypoint."""
    return modal.Cls.from_name(APP_NAME, "Editor")


def _run_edit(
    images: list[bytes], prompt: str, steps: int, cfg: float, seed: int
) -> dict[str, Any]:
    """The one place that calls the GPU, shared by the API and the smoke test."""
    return _editor()().edit.remote(
        images=images, prompt=prompt, steps=int(steps), cfg=float(cfg), seed=int(seed)
    )


# --------------------------------------------------------------------------- #
# Credit left this month
# --------------------------------------------------------------------------- #

# Starter plan compute grant. The billing summary reports only the portion
# already applied, so the remainder is this grant minus that amount.
MONTHLY_CREDIT_USD = Decimal("30")
# Measured on an H100 for a 896x1184 image. See the README cost table.
COLD_LOAD_SECONDS = Decimal("31.7")
WARM_EDIT_SECONDS = Decimal("3.61")
# scaledown_window on Editor: the GPU stays up this long after the last edit.
IDLE_SECONDS = Decimal("60")


def _adjustment(summary: Any, name: str) -> Decimal:
    for key, value in summary.adjustments.items():
        if str(key).lower() == name:
            return Decimal(value)
    return Decimal(0)


def estimate_edits(remaining: Decimal, h100_hour: Decimal) -> tuple[int, int]:
    """How many 4-step edits the remaining credit covers.

    A cold edit pays the weight load, the edit, and the idle minute before the
    GPU shuts down. Further edits in the same sitting pay only the edit itself;
    the load and the trailing minute are paid once.
    """
    if remaining <= 0 or h100_hour <= 0:
        return 0, 0

    per_second = h100_hour / Decimal(3600)
    cold_cost = (COLD_LOAD_SECONDS + WARM_EDIT_SECONDS + IDLE_SECONDS) * per_second
    warm_cost = WARM_EDIT_SECONDS * per_second
    fixed_cost = (COLD_LOAD_SECONDS + IDLE_SECONDS) * per_second
    cold_edits = int(remaining // cold_cost) if cold_cost > 0 else 0
    warm_edits = (
        int((remaining - fixed_cost) // warm_cost)
        if warm_cost > 0 and remaining > fixed_cost
        else 0
    )
    return cold_edits, warm_edits


def credit_snapshot() -> dict[str, Any]:
    """Remaining Starter credit, and the edits it still covers."""
    workspace = modal.Workspace.from_context()
    summary = workspace.billing.summary()
    rates = workspace.billing.rates()
    applied = abs(_adjustment(summary, "credits"))
    billed = Decimal(summary.billed_cost)
    remaining = (
        Decimal(0)
        if billed > 0
        else max(Decimal(0), MONTHLY_CREDIT_USD - applied)
    )
    cold_edits, warm_edits = estimate_edits(
        remaining, Decimal(rates["gpu_hour_cost_h100"])
    )
    return {
        "ok": True,
        "allowance_usd": float(MONTHLY_CREDIT_USD),
        "remaining_usd": float(round(remaining, 2)),
        "cold_edits": cold_edits,
        "warm_edits": warm_edits,
    }


# --------------------------------------------------------------------------- #
# JSON API - called by the Vercel app's server, never by a browser
# --------------------------------------------------------------------------- #


@app.function(image=api_image, timeout=1200)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def api(payload: dict[str, Any]) -> dict[str, Any]:
    """Edit endpoint.

    Proxy-auth protected, so the credential lives in the Vercel app's environment
    variables and never reaches a browser. Called server-to-server, so there is no
    CORS to configure and no client-side secret to leak.

        POST <url>
        Authorization: Bearer <MODAL_TOKEN_ID>.<MODAL_TOKEN_SECRET>
        {"image_b64": "...", "prompt": "...", "steps": 4, "seed": 0}

    Images travel base64-encoded in both directions.
    """
    import base64

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}

    raw = payload.get("image_b64") or []
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

    try:
        out = _run_edit(
            decoded,
            prompt,
            payload.get("steps", DEFAULT_STEPS),
            payload.get("cfg", DEFAULT_CFG),
            payload.get("seed", 0),
        )
    except Exception as exc:
        # Surface model failures as JSON rather than an opaque 500, so the web app
        # can show the user what actually went wrong.
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    return {
        "ok": True,
        "image_b64": base64.b64encode(out["png"]).decode("ascii"),
        "seconds": out["seconds"],
        "steps": out["steps"],
        "size": out["size"],
    }


@app.function(image=api_image, timeout=60)
@modal.fastapi_endpoint(method="GET", requires_proxy_auth=True)
def usage() -> dict[str, Any]:
    """This month's remaining credit. CPU only — it never starts a GPU."""
    try:
        return credit_snapshot()
    except Exception as exc:
        print(f"[image-editor] credit snapshot failed: {type(exc).__name__}: {exc}")
        return {"ok": False, "error": "Credit balance is unavailable."}


@app.local_entrypoint()
def smoke(
    prompt: str = "Make the scene at night with warm street lights",
    image: str = "",
) -> None:
    """One real edit on the deployed GPU class. No HTTP and no auth in the way.

        uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke \
            --prompt "make it snow" --image inputs/ref.png
    """
    import pathlib

    if image:
        image_path = pathlib.Path(image)
    else:
        candidates = (
            sorted(p for p in pathlib.Path("inputs").glob("*") if p.is_file())
            if pathlib.Path("inputs").exists()
            else []
        )
        if not candidates:
            raise SystemExit("No image given and nothing under ./inputs - pass --image.")
        image_path = candidates[0]

    if not image_path.is_file():
        raise SystemExit(f"not a file: {image_path}")

    out = _run_edit([image_path.read_bytes()], prompt, DEFAULT_STEPS, DEFAULT_CFG, 0)

    out_dir = pathlib.Path("outputs")
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"smoke-{image_path.stem}.png"
    target.write_bytes(out["png"])
    print(
        f"edited {image_path} -> {target} in {out['seconds']}s "
        f"({out['steps']} steps, {out['size'][0]}x{out['size'][1]})"
    )
