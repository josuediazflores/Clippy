#!/bin/bash
# Deploys the development Runtime stack with every live setting. Never run automatically.
# Leaving out any flag silently disables the device rule or dispatcher or reverts to mock models.
#   AWS_PROFILE=... bash tools/deploy-dev.sh [diff]
set -euo pipefail
cd "$(dirname "$0")/../infra"
export AWS_REGION=us-east-1
flags=(
  -c clippy:deviceRuleEnabled=true
  -c clippy:dispatcherEnabled=true
  -c clippy:pipelineConfig=config/pipeline-dev.json
  -c clippy:region=us-east-1
)
if [ "${1:-}" = "diff" ]; then
  npx cdk diff ClippyRuntime-dev "${flags[@]}"
else
  npx cdk deploy ClippyRuntime-dev "${flags[@]}"
fi
