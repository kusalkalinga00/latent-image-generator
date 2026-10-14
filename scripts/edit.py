#!/usr/bin/env python3
"""Client for the deployed image-editor JSON API.

Needs three environment variables:

    IMAGE_EDITOR_API_URL   printed by `modal deploy`
    MODAL_TOKEN_ID         a Modal proxy token (Modal dashboard -> Settings)
    MODAL_TOKEN_SECRET

Then:

    uv run scripts/edit.py --image inputs/ref.png --prompt "make it snow"
    uv run scripts/edit.py --image a.png --image b.png --prompt "put them in a cafe"
    uv run scripts/edit.py --image ref.png --prompt "..." --steps 20 --seed 7

Proxy tokens are the same ID/secret pair Modal uses for its own API, so no
application-level secret exists in this repo or in the deployed app.
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


def _require(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        sys.exit(f"error: {name} is not set")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Edit an image via the deployed API.")
    parser.add_argument("--image", action="append", required=True, help="reference image (up to 3)")
    parser.add_argument("--prompt", required=True, help="what to change")
    parser.add_argument("--out", default="", help="output path (default outputs/<stem>-edited.png)")
    parser.add_argument("--steps", type=int, default=40)
    parser.add_argument("--cfg", type=float, default=4.0)
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

    url = _require("IMAGE_EDITOR_API_URL")
    token = f'{_require("MODAL_TOKEN_ID")}.{_require("MODAL_TOKEN_SECRET")}'

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
        sys.exit(f"error: HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}")
    except urllib.error.URLError as exc:
        sys.exit(f"error: could not reach {url}: {exc.reason}")

    wall = time.time() - started
    if not body.get("ok"):
        sys.exit(f"error: {body.get('error')}")

    target = pathlib.Path(args.out) if args.out else pathlib.Path("outputs") / f"{paths[0].stem}-edited.png"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(base64.b64decode(body["image_b64"]))

    print(
        f"wrote {target}\n"
        f"  model time : {body['seconds']}s ({body['steps']} steps)\n"
        f"  wall time  : {wall:.1f}s  (includes cold start if the GPU was asleep)\n"
        f"  size       : {body['size'][0]}x{body['size'][1]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
