#!/bin/bash
# Finite DynamoDB Local test run: starts a loopback-only container, runs the suite, always removes it.
set -euo pipefail
cd "$(dirname "$0")/.."
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
  services/backend/test/flow.test.ts services/backend/test/http.test.ts services/backend/test/p04.test.ts
