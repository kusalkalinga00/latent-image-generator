"""Turn an RGB render into RGBA by removing its background.

The diffusion model cannot produce alpha: it paints pixels, and when asked for a
"transparent background" it draws a grey checkerboard, which is the visual idiom
it learned. So transparency has to be produced here, after the fact.

Two methods, in order:

1. **Geometric key** - flood fill inwards from the border while the colour stays
   close to the border colour, then accept the result only if it looks like a
   background (a plausible share of the frame, and connected to the edges). For
   flat illustration on a flat field this is exact: hard edges, every detail kept,
   no fringe. It is also the case people ask for transparency most often.

2. **Model matte** - rembg's u2net, for photographs and busy backgrounds where a
   key has nothing to hold on to. Its mask is soft, so the alpha is pushed through
   a curve afterwards: an interior at 254 is technically translucent and shows as
   a washed-out subject over a light page, and 255/0 with a one-pixel ramp is what
   an icon needs.

Both paths finish with the same cleanup: erode a pixel to swallow the halo the
checkerboard leaves at the subject's outline, then feather half a pixel so the
edge is not stair-stepped.
"""

from __future__ import annotations

import io
from collections import deque

import numpy as np
from PIL import Image, ImageFilter

# A pixel is background if it is within this distance of the border colour (RGB,
# 0-255). Generous enough for a checkerboard's two tones, tight enough to stop at
# a saturated subject.
KEY_TOLERANCE = 46
# Below this, the key found nothing worth removing; above it, it ate the subject.
KEY_MIN_SHARE = 0.04
KEY_MAX_SHARE = 0.93


def cutout(png: bytes) -> bytes:
    """Return an RGBA PNG with the background removed."""
    source = Image.open(io.BytesIO(png)).convert("RGB")
    rgb = np.asarray(source).astype(np.int16)

    alpha = _key_alpha(rgb)
    if alpha is None:
        alpha = _model_alpha(source)

    cleaned = _clean(alpha)
    out = source.convert("RGBA")
    out.putalpha(cleaned)

    buf = io.BytesIO()
    out.save(buf, format="PNG")
    return buf.getvalue()


# --------------------------------------------------------------------------- #
# 1. geometric key
# --------------------------------------------------------------------------- #


def _edge_colours(rgb: np.ndarray) -> np.ndarray:
    """The distinct colours on the frame's border.

    A single median is not enough: a checkerboard has two tones, and taking the
    median picks one of them, so the fill stops dead at every square of the other.
    Sampling points around the edge and keeping the ones that differ gives both.
    """
    height, width = rgb.shape[:2]
    points = [
        rgb[0, 0], rgb[0, width // 2], rgb[0, -1],
        rgb[height // 2, 0], rgb[height // 2, -1],
        rgb[-1, 0], rgb[-1, width // 2], rgb[-1, -1],
    ]
    colours: list[np.ndarray] = []
    for point in points:
        if not any(np.abs(point - seen).max() < 24 for seen in colours):
            colours.append(point)
    return np.array(colours)


def _key_alpha(rgb: np.ndarray) -> np.ndarray | None:
    """Flood fill the background inwards from the edges. None if it does not fit."""
    height, width = rgb.shape[:2]
    references = _edge_colours(rgb)

    # Chebyshev distance to the nearest border colour: cheap, and a good match for
    # "same flat field" on either a white page or a two-tone checker.
    candidate = np.zeros((height, width), dtype=bool)
    for reference in references:
        candidate |= np.abs(rgb - reference).max(axis=2) <= KEY_TOLERANCE

    background = np.zeros((height, width), dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def push(y: int, x: int) -> None:
        if candidate[y, x] and not background[y, x]:
            background[y, x] = True
            queue.append((y, x))

    for x in range(width):
        push(0, x)
        push(height - 1, x)
    for y in range(height):
        push(y, 0)
        push(y, width - 1)

    while queue:
        y, x = queue.popleft()
        if y > 0:
            push(y - 1, x)
        if y < height - 1:
            push(y + 1, x)
        if x > 0:
            push(y, x - 1)
        if x < width - 1:
            push(y, x + 1)

    share = background.mean()
    if not (KEY_MIN_SHARE <= share <= KEY_MAX_SHARE):
        return None

    # The wall of the fill is one pixel of anti-aliasing; feathering comes later.
    return np.where(background, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- #
# 2. model matte
# --------------------------------------------------------------------------- #

_SESSION: dict[str, object] = {}


def _model_alpha(source: Image.Image) -> np.ndarray:
    from rembg import new_session, remove

    session = _SESSION.get("u2net")
    if session is None:
        session = new_session("u2net")
        _SESSION["u2net"] = session

    mask = remove(source, session=session, only_mask=True)
    alpha = np.asarray(mask.convert("L")).astype(np.float32)

    # Push the soft interior to solid and the far background to clear, keeping a
    # narrow ramp in between. values are 0-255.
    low, high = 12.0, 96.0
    alpha = np.clip((alpha - low) / (high - low), 0.0, 1.0) * 255.0
    return alpha.astype(np.uint8)


# --------------------------------------------------------------------------- #
# cleanup
# --------------------------------------------------------------------------- #


def _clean(alpha: np.ndarray) -> Image.Image:
    layer = Image.fromarray(alpha, "L")
    # Erode, to cut the halo the checkerboard blends into the outline.
    layer = layer.filter(ImageFilter.MinFilter(3))
    # Feather, so the edge does not read as a staircase on a high-DPI screen.
    return layer.filter(ImageFilter.GaussianBlur(0.6))
