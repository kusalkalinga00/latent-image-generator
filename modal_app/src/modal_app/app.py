"""Modal GPU backend for Qwen-Image-2.1, running the 4-step Lightning LoRA.

This is the **model service only**. The web UI is a separate TanStack Start app on
Vercel that calls this over HTTPS. That split is deliberate: the browser never
talks to Modal, so no credential ever needs to reach a client, and this endpoint
stays behind proxy auth. It is also why there is no Gradio app here any more - a
UI living inside the GPU service ends up needing its own auth, its own secret, and
its own failure modes for no benefit.

**One model does both jobs.** The previous build ran two checkpoints -
Qwen-Image-Edit-2511 for edits and Qwen-Image-2512 for generation - because two
53.7 GiB checkpoints cannot share an 80 GB card. 2.1 is a single 7B model, 33.1 GiB
in total, that both generates and edits. That removes a class, a Volume, a cold
start, and the entire "asked for a generate, got an edit" failure mode, and it
halves the weight load (measured: 19.3 s, against 30-70 s before).

**It also removes matting.** The old checkpoints were RGB-only, so a "transparent
background" prompt made them *paint a grey checkerboard* - the visual idiom, not
an alpha channel - and the alpha had to be cut out afterwards by a separate CPU
step with two methods, a u2net fallback and its own failure modes. 2.1 emits RGBA
natively. The only post-processing left is clamping the 1-7/255 haze it leaves in
the background to zero, which is arithmetic on one channel.

Everything runs in Modal's cloud. No model weight ever touches a local machine:
the checkpoint goes into a Modal Volume once and every container after reads it
from there.

From the repo root:

    # cheap CPU check that the dependency set loads the pipeline's front end
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::check_env

    # one-off: pull the base weights + the 4-step LoRA into the Volume
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::download_weights

    # verify the deployed model actually runs, on a real GPU
    uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
        --prompt "a lighthouse on a cliff at dusk"

    uv run --package modal-app modal deploy modal_app/src/modal_app/app.py

Cost design. Billing is per GPU-second, so one thing matters: how long an H100 is
alive.

  * ``max_containers=1`` - one GPU at a time whatever the traffic. Not a rate
    limit; it is what stops a burst of concurrent requests billing N GPUs.
  * ``scaledown_window=60`` - release the GPU a minute after the last render.
    Holding one H100 warm for a month costs $2,848.
  * **4 steps instead of 40** - the biggest lever by far, and the reason a public
    app is viable on a $30/month credit. The Lightning LoRA is a distillation of
    the base model, published by LightX2V.

GPU memory snapshots are deliberately NOT used: Modal's docs state they "do not
speed up model loading from storage" and may worsen it, and initialization is
entirely storage-bound.
"""

from __future__ import annotations

import io
import json
import os
import re
import time
from decimal import Decimal
from typing import Any

import modal

APP_NAME = "image-editor"
MODEL_ID = "Qwen/Qwen-Image-2.1"
VOLUME_NAME = "qwen21-weights"
MODEL_CACHE = "/models/hf"

# Finished renders, kept just long enough for a client to come back for them.
#
# The failure this exists for: a phone locks while a render is in flight. iOS
# tears the connection down on suspend, so the browser's fetch rejects and the
# user gets a network error - while the GPU, which nobody told, finishes the job
# and bills for it. The result is written here under the job id the client chose
# before it sent anything, so the client can ask again on resume and collect the
# render it already paid for, instead of paying twice.
RESULTS_VOLUME_NAME = "image-editor-results"
RESULTS_PATH = "/results"
RESULTS_TTL_S = 45 * 60

# The 4-step distilled LoRA: 64 MiB, published for 2.1 specifically. It declares no
# licence of its own and inherits the base model's research licence - see the
# Licence section of the README before assuming anything about reuse.
LORA_REPO = "lightx2v/Qwen-Image-2.1-Lightning"
LORA_FILE = "pytorch_lora_weights.safetensors"

# The trained output buckets, at the scale this app actually serves. 2.1's card
# lists the 2048-px family; at ~1.5 MP the image still fills a phone's width and
# the PNG stays a couple of megabytes instead of six, which matters more on mobile
# data than the extra pixels do. Measured: 3.2-3.7 s and 44 GB peak VRAM.
#
# Every side is a multiple of 32. That is not a style choice: the pipeline works on
# a 32-px latent grid and *silently* snaps what it is given - asking for 1328 came
# back as 1312, so the reported size would disagree with the request and the aspect
# would drift off the intended ratio.
ASPECTS: dict[str, tuple[int, int]] = {
    "1:1": (1312, 1312),
    "3:2": (1536, 1024),
    "2:3": (1024, 1536),
    "4:3": (1408, 1056),
    "3:4": (1056, 1408),
    "16:9": (1664, 928),
    "9:16": (928, 1664),
}
DEFAULT_ASPECT = "1:1"

# 2.1 accepts up to ten reference images. Four is a deliberate app-level cap: the
# payload is base64 JSON, and ten phone photos is a lot of upload for pixels the
# model will not use.
MAX_IMAGES = 4

# The distillation is four steps; that is the whole point of the LoRA, and the UI
# offers no slider. ``steps`` stays in the request and is echoed back, but the
# render always runs the distilled schedule - a "40 steps" request would silently
# get 4 rather than pay for 40.
LIGHTNING_STEPS = 4
DEFAULT_STEPS = LIGHTNING_STEPS
# The distillation's own schedule: four sigmas, no terminal stretch.
LIGHTNING_SIGMAS = [1.0, 0.75, 0.5, 0.25]

# 2.1's alpha is real but not exact: the background comes back at about 1-7/255
# rather than 0. Invisible on screen, but it would tint a composited image, so
# everything under this is snapped to fully transparent.
ALPHA_CLAMP = 8

# How the model is asked for alpha. Qwen's card is explicit that this phrasing is
# the one it was trained on, and the pilot confirmed it: RGBA out, no checkerboard.
RGBA_PREFIX = "This is an RGBA image with transparency. "
RGBA_SUFFIX = " The image has alpha channel and the background is transparent."

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
        # 0.41.0 ships QwenImage21Pipeline, so a pinned release is reproducible.
        "diffusers==0.41.0",
        # Also invisible until load time: diffusers raises "PEFT backend is
        # required for load_lora_weights()" only when the LoRA is attached, so the
        # image builds and the pipeline constructs fine without it.
        "peft",
        "transformers>=5.17",  # 2.1's requirement, per its Quick Start
        "accelerate",
        "safetensors",
        "sentencepiece",
        "protobuf",
        "pillow",
        "huggingface_hub",
        "einops",
    )
    # Xet - HF's chunked transfer - stalled at 28.2 of 33 GiB here and never
    # resumed; plain HTTP transfers resume, retry and report progress instead.
    .env(
        {
            "HF_HOME": MODEL_CACHE,
            "HF_HUB_DISABLE_TELEMETRY": "1",
            "HF_HUB_DISABLE_XET": "1",
        }
    )
)

# The API layer holds no model, so it needs no torch: it decodes JSON, calls the
# GPU class, and encodes the result. A light image keeps its cold start and its
# idle cost near zero. Pillow is here for the alpha clamp, which is arithmetic on
# one channel and not worth a GPU second.
api_image = modal.Image.debian_slim(python_version="3.12").uv_pip_install(
    "fastapi[standard]", "pillow"
)

# The distillation's scheduler. This cannot be inferred from the LoRA file - it is
# a property of how the model was distilled, and loading the LoRA onto the
# pipeline's *default* scheduler is the mistake the Lightning repo documents as
# grid artifacts. These are the values published with the 2.1 LoRA, and they are
# not the 2511 ones: base_shift 0.5 and max_shift 0.9, not log(3) for both.
LIGHTNING_SCHEDULER_CONFIG = {
    "num_train_timesteps": 1000,
    "use_dynamic_shifting": True,
    "time_shift_type": "exponential",
    "base_image_seq_len": 256,
    "max_image_seq_len": 8192,
    "base_shift": 0.5,
    "max_shift": 0.9,
    "shift_terminal": None,
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

    It also constructs the distillation scheduler for real. That is the only thing
    that validates LIGHTNING_SCHEDULER_CONFIG, which is otherwise first exercised
    on an H100.

    Returns a JSON *string* and coerces every field to a plain str/bool. Modal
    unpickles the return value in the **local** environment, which has no torch, so
    anything carrying a torch-defined class fails to deserialize with a misleading
    "the 'torch' module is not available in the local environment".
    """
    import diffusers
    import torch
    import torchvision
    import transformers
    from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline

    info: dict[str, Any] = {
        "torch": str(torch.__version__),
        "torchvision": str(torchvision.__version__),
        "diffusers": str(diffusers.__version__),
        "transformers": str(transformers.__version__),
        "has_qwen_image_21_pipeline": True,
        "pipeline": QwenImage21Pipeline.__name__,
        "aspects": sorted(ASPECTS),
    }

    # 2.1 keeps components in subfolders, so try the subfolder first and fall back
    # to the repo root. Which layout a Qwen release uses has changed between
    # versions, and a lookup that reports "Unrecognized processing class" against a
    # healthy model is a false alarm - worse than no check at all.
    from transformers import AutoProcessor

    for subfolder in ("processor", None):
        try:
            processor = (
                AutoProcessor.from_pretrained(
                    MODEL_ID, subfolder=subfolder, cache_dir=MODEL_CACHE
                )
                if subfolder
                else AutoProcessor.from_pretrained(MODEL_ID, cache_dir=MODEL_CACHE)
            )
            info["processor"] = type(processor).__name__
            info["processor_subfolder"] = subfolder or "<root>"
            info["processor_ok"] = True
            break
        except Exception as exc:  # noqa: BLE001 - reported, not raised
            info["processor"] = f"{type(exc).__name__}: {exc}"
            info["processor_ok"] = False

    try:
        import peft

        info["peft"] = str(peft.__version__)
        info["lora_backend_ok"] = True
    except Exception as exc:  # noqa: BLE001
        info["peft"] = f"{type(exc).__name__}: {exc}"
        info["lora_backend_ok"] = False

    try:
        scheduler = FlowMatchEulerDiscreteScheduler.from_config(
            LIGHTNING_SCHEDULER_CONFIG
        )
        info["lightning_scheduler"] = type(scheduler).__name__
        info["lightning_scheduler_ok"] = True
    except Exception as exc:  # noqa: BLE001
        info["lightning_scheduler"] = f"{type(exc).__name__}: {exc}"
        info["lightning_scheduler_ok"] = False

    try:
        # The LoRA must be fetchable, not merely present in the repo: it is what
        # makes 4 steps possible, and a missing file only surfaces at load time.
        from huggingface_hub import hf_hub_download

        path = hf_hub_download(
            repo_id=LORA_REPO, filename=LORA_FILE, cache_dir=MODEL_CACHE
        )
        info["lora_bytes"] = os.path.getsize(path)
        info["lora_ok"] = True
    except Exception as exc:  # noqa: BLE001
        info["lora"] = f"{type(exc).__name__}: {exc}"
        info["lora_ok"] = False

    print("[image-editor] env: " + json.dumps(info, indent=2))
    return json.dumps(info)


def _tree_bytes(root: str) -> tuple[int, int]:
    total = 0
    files = 0
    for base, _dirs, names in os.walk(root):
        for name in names:
            path = os.path.join(base, name)
            # An HF cache stores real bytes in blobs/ and links them into
            # snapshots/; counting symlinks too would roughly double the figure.
            if os.path.islink(path):
                continue
            try:
                total += os.path.getsize(path)
                files += 1
            except OSError:
                pass
    return total, files


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=5400, cpu=4)
def download_weights() -> str:
    """The base model (33.1 GiB) and its 4-step LoRA. Storage is free under 1 TiB."""
    from huggingface_hub import hf_hub_download, snapshot_download

    weights.reload()
    started = time.time()
    snapshot_download(MODEL_ID, cache_dir=MODEL_CACHE, max_workers=8)
    lora_path = hf_hub_download(
        repo_id=LORA_REPO, filename=LORA_FILE, cache_dir=MODEL_CACHE
    )
    total, files = _tree_bytes(MODEL_CACHE)
    # Without commit() the writes vanish when the container exits, and every cold
    # start silently re-downloads the whole thing.
    weights.commit()
    info = {
        "model": MODEL_ID,
        "lora": lora_path,
        "gib": round(total / 1024**3, 2),
        "files": files,
        "seconds": round(time.time() - started, 1),
    }
    print("[image-editor] downloaded: " + json.dumps(info))
    return json.dumps(info)


@app.function(image=gpu_image, volumes={"/models": weights}, timeout=900, cpu=2)
def volume_stats() -> str:
    """Report what is actually in the Volume. Measured, not assumed."""
    weights.reload()
    total, files = _tree_bytes(MODEL_CACHE)
    info = {"files": files, "bytes": total, "gib": round(total / 1024**3, 2)}
    print("[image-editor] volume: " + json.dumps(info))
    return json.dumps(info)


# --------------------------------------------------------------------------- #
# The model
# --------------------------------------------------------------------------- #


def _snap_alpha(png: bytes) -> bytes:
    """Clamp the faint background haze to fully transparent.

    2.1's background sits around 1-7/255 rather than 0: invisible on a screen, but
    a colour fringe once composited. Everything under ALPHA_CLAMP becomes 0, so the
    file a user downloads is a clean matte rather than an almost-clean one.
    """
    from PIL import Image

    image = Image.open(io.BytesIO(png))
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    alpha = image.getchannel("A").point(
        lambda value: 0 if value < ALPHA_CLAMP else value
    )
    image.putalpha(alpha)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _flatten(png: bytes) -> bytes:
    """Composite onto white when transparency was not asked for.

    The pipeline returns RGBA either way, and the UI draws a checkerboard wherever
    the result has alpha. Leaving it in would tell the user they got a cutout when
    the request never asked for one.
    """
    from PIL import Image

    image = Image.open(io.BytesIO(png))
    if image.mode != "RGBA":
        return png
    canvas = Image.new("RGB", image.size, (255, 255, 255))
    canvas.paste(image, mask=image.getchannel("A"))
    buffer = io.BytesIO()
    canvas.save(buffer, format="PNG")
    return buffer.getvalue()


def _useful_alpha(png: bytes) -> bool:
    from PIL import Image

    image = Image.open(io.BytesIO(png))
    if image.mode != "RGBA":
        return False
    low, _high = image.getchannel("A").getextrema()
    return low < 250


@app.cls(
    image=gpu_image,
    gpu="H100",
    volumes={"/models": weights},
    timeout=1200,
    scaledown_window=60,
    max_containers=1,
)
class Image21:
    """Generation and editing, in one container and one checkpoint."""

    @modal.enter()
    def load(self) -> None:
        import torch
        from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline
        from huggingface_hub import snapshot_download

        started = time.time()
        weights.reload()
        self.pipe = QwenImage21Pipeline.from_pretrained(
            MODEL_ID, cache_dir=MODEL_CACHE, torch_dtype=torch.bfloat16
        ).to("cuda")

        # Attach the LoRA last, onto a pipeline that already has the distillation
        # scheduler - the order the Lightning reference uses.
        lora_dir = snapshot_download(
            LORA_REPO, cache_dir=MODEL_CACHE, local_files_only=True
        )
        self.pipe.load_lora_weights(
            lora_dir, weight_name=LORA_FILE, adapter_name="lightning"
        )
        self.pipe.scheduler = FlowMatchEulerDiscreteScheduler.from_config(
            self.pipe.scheduler.config, **LIGHTNING_SCHEDULER_CONFIG
        )
        self.pipe.set_progress_bar_config(disable=True)

        # Logged so the cold-start share of a bill is visible rather than guessed.
        print(f"[image-editor] 2.1 + 4-step LoRA on GPU in {time.time() - started:.1f}s")

    @modal.method()
    def render(
        self,
        prompt: str,
        aspect: str = DEFAULT_ASPECT,
        images: list[str] | None = None,
        steps: int = LIGHTNING_STEPS,
        seed: int = 0,
        transparent: bool = False,
    ) -> dict[str, Any]:
        """Edit if images arrive, generate if not. One model, one code path."""
        import base64

        import torch
        from PIL import Image

        if not prompt.strip():
            raise ValueError("prompt must not be empty")
        if images and len(images) > MAX_IMAGES:
            raise ValueError(f"at most {MAX_IMAGES} images are supported")

        text = f"{RGBA_PREFIX}{prompt}{RGBA_SUFFIX}" if transparent else prompt

        kwargs: dict[str, Any] = {}
        if images:
            decoded = [
                Image.open(io.BytesIO(base64.b64decode(item))).convert("RGB")
                for item in images
            ]
            # An edit inherits the source's size: the UI never offers a shape
            # picker for edits, and resizing a photo would be an unasked-for edit.
            kwargs["image"] = decoded[0] if len(decoded) == 1 else decoded
        else:
            width, height = ASPECTS.get(aspect, ASPECTS[DEFAULT_ASPECT])
            kwargs["width"] = width
            kwargs["height"] = height

        started = time.time()
        with torch.inference_mode():
            result = self.pipe(
                prompt=text,
                num_inference_steps=LIGHTNING_STEPS,
                sigmas=LIGHTNING_SIGMAS,
                true_cfg_scale=1.0,
                use_kv_cache=False,
                generator=torch.Generator("cuda").manual_seed(int(seed) or 0),
                **kwargs,
            )
        elapsed = time.time() - started

        buffer = io.BytesIO()
        result.images[0].save(buffer, format="PNG")
        png = buffer.getvalue()
        # Read the alpha before flattening: this says whether the model gave us an
        # alpha channel, not whether the request asked for one.
        had_alpha = _useful_alpha(png)
        png = _snap_alpha(png) if transparent else _flatten(png)

        return {
            "png": png,
            # False when the model returned no usable alpha, so the client never
            # claims a transparency that is not there.
            "transparent": bool(transparent and had_alpha),
            "seconds": round(elapsed, 2),
            "steps": LIGHTNING_STEPS,
            "size": list(result.images[0].size),
        }


def _render(
    prompt: str,
    aspect: str,
    images: list[bytes],
    steps: int,
    seed: int,
    transparent: bool,
) -> dict[str, Any]:
    """The one place that calls the GPU, shared by the API and the smoke tests."""
    import base64

    return Image21().render.remote(
        prompt=prompt,
        aspect=aspect,
        images=[base64.b64encode(item).decode("ascii") for item in images] or None,
        steps=int(steps),
        seed=int(seed),
        transparent=bool(transparent),
    )


# --------------------------------------------------------------------------- #
# Credit left this month
# --------------------------------------------------------------------------- #

# Starter plan compute grant. The billing summary reports only the portion
# already applied, so the remainder is this grant minus that amount.
MONTHLY_CREDIT_USD = Decimal("30")
# Measured on this deployment: 33.1 GiB off the Volume, then a 4-step render at
# 1328px. Both are H100 seconds, which is all this estimate cares about.
COLD_LOAD_SECONDS = Decimal("19.3")
WARM_EDIT_SECONDS = Decimal("3.73")
# scaledown_window: the GPU stays up this long after the last render.
IDLE_SECONDS = Decimal("60")


def _adjustment(summary: Any, name: str) -> Decimal:
    for key, value in summary.adjustments.items():
        if str(key).lower() == name:
            return Decimal(value)
    return Decimal(0)


def estimate_edits(remaining: Decimal, h100_hour: Decimal) -> tuple[int, int]:
    """How many 4-step renders the remaining credit covers.

    A cold render pays the weight load, the render, and the idle minute before the
    GPU shuts down. Further renders in the same sitting pay only the render
    itself; the load and the trailing minute are paid once.
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
    """Remaining Starter credit, and the renders it still covers."""
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

RESULTS = modal.Volume.from_name(RESULTS_VOLUME_NAME, create_if_missing=True)


def _jobs_path(job_id: str) -> str:
    # The id arrives from a client, so it is never trusted as a path segment.
    return os.path.join(RESULTS_PATH, re.sub(r"[^A-Za-z0-9_-]", "", job_id)[:64] + ".json")


def _store_result(job_id: str, body: dict[str, Any]) -> None:
    """Keep a finished render for a client that lost its connection.

    Best-effort on purpose: a failure here must not turn a successful render into
    an error response. The worst case is the old behaviour, not a worse one.
    """
    if not job_id:
        return
    try:
        _prune_results()
        with open(_jobs_path(job_id), "w", encoding="utf-8") as handle:
            json.dump({**body, "at": time.time()}, handle)
        RESULTS.commit()
    except Exception as exc:
        print(f"[image-editor] could not store result: {type(exc).__name__}: {exc}")


def _prune_results() -> None:
    cutoff = time.time() - RESULTS_TTL_S
    for name in os.listdir(RESULTS_PATH):
        path = os.path.join(RESULTS_PATH, name)
        try:
            if os.path.getmtime(path) < cutoff:
                os.remove(path)
        except OSError:
            pass


@app.function(
    image=api_image, volumes={"/models": weights, RESULTS_PATH: RESULTS}, timeout=1200
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=True)
def api(payload: dict[str, Any]) -> dict[str, Any]:
    """Edit or generate endpoint.

    Proxy-auth protected, so the credential lives in the Vercel app's environment
    variables and never reaches a browser. Called server-to-server, so there is no
    CORS to configure and no client-side secret to leak.

        POST <url>
        Authorization: Bearer ***
        {"image_b64": ["..."], "prompt": "...", "steps": 4, "seed": 0}

    One endpoint, two jobs, decided by whether a photo came with the prompt: no
    image means generate, an image means edit. That keeps the web app from having
    to know which endpoint to call, and keeps the mode in one place.

    ``transparent: true`` now asks the model for an alpha channel it can actually
    produce, then clamps the near-zero background to true zero. The field in the
    response reports what happened rather than what was asked: if no usable alpha
    comes back, it is false and the image is returned intact.

    Images travel base64-encoded in both directions.
    """
    import base64

    prompt = (payload.get("prompt") or "").strip()
    if not prompt:
        return {"ok": False, "error": "prompt is required"}

    raw = payload.get("image_b64") or []
    if isinstance(raw, str):
        raw = [raw]
    raw = [item for item in raw if item]
    if len(raw) > MAX_IMAGES:
        return {"ok": False, "error": f"at most {MAX_IMAGES} images"}

    steps = payload.get("steps", DEFAULT_STEPS)
    seed = payload.get("seed", 0)
    transparent = bool(payload.get("transparent"))

    try:
        if raw:
            try:
                decoded = [base64.b64decode(item) for item in raw]
            except Exception as exc:
                return {"ok": False, "error": f"image_b64 is not valid base64: {exc}"}
            out = _render(prompt, DEFAULT_ASPECT, decoded, steps, seed, transparent)
            mode = "edit"
        else:
            aspect = str(payload.get("aspect") or DEFAULT_ASPECT)
            out = _render(prompt, aspect, [], steps, seed, transparent)
            mode = "generate"
    except Exception as exc:
        # Surface model failures as JSON rather than an opaque 500, so the web app
        # can show the user what actually went wrong.
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}

    body = {
        "ok": True,
        "mode": mode,
        # One model now, so this is the same string either way - but the field
        # stays: the client shows it, and it is how a result is attributed.
        "model": MODEL_ID,
        "transparent": out["transparent"],
        "image_b64": base64.b64encode(out["png"]).decode("ascii"),
        "seconds": out["seconds"],
        "steps": out["steps"],
        "size": out["size"],
    }

    # Written before returning, so a client whose connection died mid-flight can
    # collect this render on resume rather than triggering a second one.
    _store_result(str(payload.get("job_id") or ""), body)
    return body


@app.function(image=api_image, volumes={RESULTS_PATH: RESULTS}, timeout=60)
@modal.fastapi_endpoint(method="GET", requires_proxy_auth=True)
def result(job_id: str = "") -> dict[str, Any]:
    """Collect a render by job id.

    ``{"ok": true, "pending": true}`` means the render is not finished yet - the
    client should keep waiting rather than start a second one. ``expired`` lets
    the client say something honest instead of retrying into a result that will
    never arrive.
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "", job_id)[:64]
    if not safe:
        return {"ok": False, "error": "job_id is required"}

    try:
        RESULTS.reload()
        path = _jobs_path(safe)
        if not os.path.exists(path):
            return {"ok": True, "pending": True}
        with open(path, encoding="utf-8") as handle:
            body = json.load(handle)
        if time.time() - float(body.pop("at", 0)) > RESULTS_TTL_S:
            return {"ok": False, "expired": True, "error": "This result has expired."}
        return {**body, "ok": True}
    except Exception as exc:
        print(f"[image-editor] result lookup failed: {type(exc).__name__}: {exc}")
        return {"ok": False, "error": "Could not look that result up."}


@app.function(image=api_image, timeout=60)
@modal.fastapi_endpoint(method="GET", requires_proxy_auth=True)
def usage() -> dict[str, Any]:
    """This month's remaining credit. CPU only — it never starts a GPU."""
    try:
        return credit_snapshot()
    except Exception as exc:
        print(f"[image-editor] credit snapshot failed: {type(exc).__name__}: {exc}")
        return {"ok": False, "error": "Credit balance is unavailable."}


# --------------------------------------------------------------------------- #
# Local entry points
# --------------------------------------------------------------------------- #


@app.local_entrypoint()
def smoke_generate(
    prompt: str = "A lighthouse on a cliff at dusk, long exposure, cinematic",
    aspect: str = DEFAULT_ASPECT,
    transparent: bool = False,
) -> None:
    """One real generation on the deployed GPU class. No HTTP, no auth in the way.

        uv run --package modal-app modal run modal_app/src/modal_app/app.py::smoke_generate \
            --prompt "a red fox in snow" --aspect 1:1
    """
    import pathlib

    started = time.time()
    out = _render(prompt, aspect, [], DEFAULT_STEPS, 0, transparent)

    out_dir = pathlib.Path("outputs")
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"generate-{int(time.time())}.png"
    target.write_bytes(out["png"])
    print(
        f"generated {target} in {out['seconds']}s "
        f"({out['steps']} steps, {out['size'][0]}x{out['size'][1]}, {aspect}), "
        f"alpha={out['transparent']}, {time.time() - started:.1f}s wall"
    )


@app.local_entrypoint()
def selftest(image: str = "inputs/ref.png") -> None:
    """Every path in one container: generate, generate + alpha, edit.

    Three renders, one cold start. This is the check that a change to the request
    shape, the LoRA or the alpha handling did not break one branch while the others
    kept working - the smoke entry points each exercise only one.

        uv run --package modal-app modal run modal_app/src/modal_app/app.py::selftest
    """
    import pathlib

    out_dir = pathlib.Path("outputs")
    out_dir.mkdir(exist_ok=True)
    source = pathlib.Path(image).read_bytes()

    runs = [
        ("generate-wide", "a red fox in fresh snow, cinematic", "16:9", [], False),
        ("generate-alpha", "a cute cartoon dragon sticker", "1:1", [], True),
        ("edit", "turn the background into a sunset beach", DEFAULT_ASPECT, [source], False),
    ]
    for name, prompt, aspect, images, transparent in runs:
        out = _render(prompt, aspect, images, DEFAULT_STEPS, 1, transparent)
        target = out_dir / f"selftest-{name}.png"
        target.write_bytes(out["png"])
        print(
            f"{name}: {out['seconds']}s {out['size']} alpha={out['transparent']} "
            f"-> {target} ({len(out['png']) // 1024} KB)"
        )


@app.local_entrypoint()
def smoke(
    prompt: str = "Make the scene at night with warm street lights",
    image: str = "",
    transparent: bool = True,
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

    out = _render(
        prompt, DEFAULT_ASPECT, [image_path.read_bytes()], DEFAULT_STEPS, 0, transparent
    )

    out_dir = pathlib.Path("outputs")
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"smoke-{image_path.stem}.png"
    target.write_bytes(out["png"])
    print(
        f"edited {image_path} -> {target} in {out['seconds']}s "
        f"({out['steps']} steps, {out['size'][0]}x{out['size'][1]}), "
        f"alpha={out['transparent']}"
    )
