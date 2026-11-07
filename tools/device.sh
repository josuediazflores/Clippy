#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH="$PWD/device"
uv run python -m clippy_device.simulator "$@"
