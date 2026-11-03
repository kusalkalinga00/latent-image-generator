#!/usr/bin/env python3
"""Client for the deployed image-editor JSON API.

Needs three environment variables:

    IMAGE_EDITOR_API_URL        printed by `modal deploy`
    MODAL_PROXY_TOKEN_ID        a Modal PROXY token (dashboard -> Settings)
    MODAL_PROXY_TOKEN_SECRET

Those names are deliberate: MODAL_TOKEN_ID / MODAL_TOKEN_SECRET are the Modal
CLI's own auth variables, and a wk-/ws- proxy token exported under them breaks
the CLI with "Token ID is malformed".

With an image it edits; with none it generates:

    uv run scripts/edit.py --image inputs/ref.png --prompt "make it snow"
    uv run scripts/edit.py --image a.png --image b.png --prompt "put them in a cafe"
    uv run scripts/edit.py --prompt "a lighthouse on a cliff at dusk" --aspect 1:1
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

MAX_IMAGES = 3
ASPECTS = ("1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16")


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"error: {name} is not set")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Edit an image, or generate one, via the deployed API."
    )
    parser.add_argument(
        "--image",
        action="append",
        default=[],
        help="reference image (up to 3). Omit to generate from the prompt alone.",
    )
    parser.add_argument("--prompt", required=True, help="what to change, or what to make")
    parser.add_argument(
        "--aspect",
        default="1:1",
        choices=ASPECTS,
        help="shape when generating; ignored when editing (default 1:1)",
    )
    parser.add_argument("--out", default="", help="output path (default outputs/<name>.png)")
    parser.add_argument("--steps", type=int, default=4, help="4 is the distilled default")
    parser.add_argument("--cfg", type=float, default=1.0, help="1.0 = guidance-free")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=900.0)
    args = parser.parse_args()

    if len(args.image) > MAX_IMAGES:
        sys.exit(f"error: at most {MAX_IMAGES} images, got {len(args.image)}")

    paths = [pathlib.Path(p) for p in args.image]
    for path in paths:
        if not path.is_file():
            sys.exit(f"error: not a file: {path}")

    payload = {
        "prompt": args.prompt,
        "image_b64": [base64.b64encode(p.read_bytes()).decode("ascii") for p in paths],
        "steps": args.steps,
        "cfg": args.cfg,
        "seed": args.seed,
    }
    # The endpoint routes on this: no images means generate.
    if not paths:
        payload["aspect"] = args.aspect

    url = _require("IMAGE_EDITOR_API_URL")
    token = (
        f"{_require('MODAL_PROXY_TOKEN_ID')}.{_require('MODAL_PROXY_TOKEN_SECRET')}"
    )

    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            # Modal proxy auth accepts the id.secret pair as a bearer token.
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )

    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=args.timeout) as response:
            body = json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        hint = " (proxy token wrong?)" if exc.code in (401, 403) else ""
        sys.exit(f"error: HTTP {exc.code}{hint}: {detail}")
    except urllib.error.URLError as exc:
        sys.exit(f"error: could not reach {url}: {exc.reason}")

    wall = time.time() - started
    if not body.get("ok"):
        sys.exit(f"error: {body.get('error')}")

    if args.out:
        target = pathlib.Path(args.out)
    else:
        stem = paths[0].stem + "-edited" if paths else "generated"
        target = pathlib.Path("outputs") / f"{stem}.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(body["image_b64"]))

    print(
        f"wrote {target}\n"
        f"  job        : {body.get('mode', 'edit')}\n"
        f"  model      : {body.get('model', 'unknown')}\n"
        f"  model time : {body['seconds']}s ({body['steps']} steps)\n"
        f"  wall time  : {wall:.1f}s  (includes cold start if the GPU was asleep)\n"
        f"  size       : {body['size'][0]}x{body['size'][1]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
