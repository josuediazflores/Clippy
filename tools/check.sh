#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD/device"
uv run python tools/generate_models.py --check
uv run python tools/validate_contracts.py
npm run check:contracts
npm run build
npm test
npm run lint
npm run format:check
uv run ruff check device tools/*.py
uv run python -m unittest discover -s device/tests -v
swift test --package-path apps/ios/Core
npm run synth
