#!/usr/bin/env bash
# Everything CI checks, in one command.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "== web =="
(
  cd web
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm lint
  pnpm check
  pnpm test
  pnpm build
)

echo "== python =="
uv sync --all-packages --group dev --frozen
uv run ruff check modal_app scripts
uv run pytest
