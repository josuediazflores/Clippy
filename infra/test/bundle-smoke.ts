import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  createLocalTables,
  dynamoLocalClient,
} from "../../services/backend/test/dynamo-local";

/**
 * Loads the synthesized API Lambda bundle (not the TypeScript source) and drives it against
 * DynamoDB Local with synthetic claims. Requires `npm run synth` first and a loopback
 * CLIPPY_DYNAMODB_ENDPOINT; tools/test-dynamodb.sh runs it.
 */
async function main(): Promise<void> {
  const client = dynamoLocalClient();
  if (!client) throw new Error("CLIPPY_DYNAMODB_ENDPOINT is required");
  // Resolve the API bundle referenced by the current template, not stale assets.
  const out = path.resolve(".local/cdk.out");
  const template = JSON.parse(
    fs.readFileSync(path.join(out, "ClippyRuntime-dev.template.json"), "utf8"),
  ) as {
    Resources: Record<
      string,
      { Type: string; Properties: { Code?: { S3Key?: string } } }
    >;
  };
  const api = Object.entries(template.Resources).find(
    ([id, r]) =>
      r.Type === "AWS::Lambda::Function" && id.startsWith("ApiFunction"),
  );
  const hash = String(api?.[1].Properties.Code?.S3Key ?? "").replace(
    /\.zip$/,
    "",
  );
  const bundle = path.join(out, `asset.${hash}`, "index.js");
  assert.ok(hash && fs.existsSync(bundle), "API bundle from current synth");
  const { names, drop } = await createLocalTables(client);
  // Never let a developer profile or SSO session reach the bundled SDK.
  for (const name of Object.keys(process.env))
    if (/^AWS_/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    AWS_CONFIG_FILE: "/dev/null",
    AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
    AWS_EC2_METADATA_DISABLED: "true",
    CLIPPY_TABLE_ACCOUNTS: names.accounts,
    CLIPPY_TABLE_DEVICES: names.devices,
    CLIPPY_TABLE_JOURNAL: names.journal,
    CLIPPY_TABLE_OPERATIONS: names.operations,
    CLIPPY_MEDIA_BUCKET: "unused-in-smoke",
    CLIPPY_COGNITO_CLIENT_ID: "client_app",
    CLIPPY_REQUIRED_SCOPE: "clippy/journal",
    AWS_REGION: "us-west-2",
    AWS_ACCESS_KEY_ID: "local",
    AWS_SECRET_ACCESS_KEY: "local",
    AWS_ENDPOINT_URL_DYNAMODB: process.env.CLIPPY_DYNAMODB_ENDPOINT,
    // Any other service call must fail closed on loopback rather than reach AWS.
    AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  });
  const logs: string[] = [];
  const original = console.log;
  console.log = (line: string) => logs.push(String(line));
  try {
    const { handler } = createRequire(__filename)(bundle) as {
      handler: (e: unknown) => Promise<{ statusCode: number; body: string }>;
    };
    const event = (
      method: string,
      p: string,
      body?: unknown,
      tokenUse = "access",
      key = "smoke_key",
    ) => ({
      version: "2.0",
      routeKey: `${method} ${p}`,
      rawPath: p,
      rawQueryString: "",
      headers: { "idempotency-key": key },
      requestContext: {
        requestId: "smoke1",
        http: { method },
        authorizer: {
          jwt: {
            claims: {
              sub: "0000aaaa-0000-4000-8000-000000000001",
              token_use: tokenUse,
              client_id: "client_app",
              scope: "clippy/journal",
            },
          },
        },
      },
      body: body ? JSON.stringify(body) : undefined,
      isBase64Encoded: false,
    });
    const call = async (...args: Parameters<typeof event>) => {
      const r = await handler(event(...args));
      return { status: r.statusCode, body: JSON.parse(r.body || "null") };
    };
    const me = await call("GET", "/v1/me");
    assert.equal(me.status, 200, JSON.stringify(me.body));
    assert.equal(me.body.revision, 1);
    const updated = await call("PATCH", "/v1/me/preferences", {
      schemaVersion: 1,
      expectedRevision: 1,
      journalTimeZone: "UTC",
      retentionDays: 3,
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal((await call("GET", "/v1/me")).body.retentionDays, 3);
    assert.equal((await call("GET", "/v1/days")).status, 200);
    assert.equal(
      (await call("GET", "/v1/days/day_20261107")).body.state,
      "empty",
    );
    assert.equal((await call("GET", "/v1/me", undefined, "id")).status, 401);
    assert.equal(
      (await call("DELETE", "/v1/me", undefined, "access", "smoke_delete"))
        .status,
      202,
    );
    assert.equal((await call("GET", "/v1/me")).status, 410);
  } finally {
    console.log = original;
    for (const line of logs.filter((l) => l.includes("unexpected_error")))
      console.error(line);
    await drop();
  }
  const unexpected = logs.filter((l) => l.includes("unexpected_error"));
  assert.deepEqual(unexpected, [], unexpected.join("\n"));
  console.log(
    "Bundle smoke passed: synthesized API Lambda bundle on DynamoDB Local.",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
