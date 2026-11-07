#!/bin/bash
# Finite DynamoDB Local test run: starts a loopback-only container, runs the suite, always removes it.
set -euo pipefail
cd "$(dirname "$0")/.."
# Isolation: a developer profile or SSO session must never be used by local tests.
for name in $(env | sed -n 's/^\(AWS_[A-Z_]*\)=.*/\1/p'); do unset "$name"; done
export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true
image="amazon/dynamodb-local:3.3.2"
name="clippy-dynamodb-local-$$"
port="${CLIPPY_DYNAMODB_PORT:-8000}"
docker run --rm -d --name "$name" -p "127.0.0.1:${port}:8000" "$image" -jar DynamoDBLocal.jar -inMemory >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:${port}" && break
  sleep 1
done
export CLIPPY_DYNAMODB_ENDPOINT="http://127.0.0.1:${port}"
# Adapter-specific suite, then the shared engine suites re-run on DynamoDB Local.
npx tsx --test --test-timeout=60000 services/backend/test/dynamodb.test.ts
CLIPPY_TEST_STORE=dynamodb npx tsx --test --test-timeout=60000 \
  services/backend/test/flow.test.ts services/backend/test/http.test.ts services/backend/test/p04.test.ts \
  services/processing/test/pipeline.test.ts services/processing/test/tasks.test.ts
# The synthesized Lambda bundle, not the source, against the same emulator.
npm run synth --silent
npx tsx infra/test/bundle-smoke.ts
