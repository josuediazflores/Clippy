import test from "node:test";
import assert from "node:assert/strict";
import {
  NotFound,
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import {
  ExecutionAlreadyExists,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  DynamoDBStreamEvent,
} from "aws-lambda";
import { S3Objects, S3Signer } from "../src/aws/s3";
import { StepFunctionsJobStarter } from "../src/aws/sfn";
import { safeLog } from "../src/aws/log";
import { actorFromClaims, createApiHandler } from "../src/lambda/api";
import {
  createDeviceHandler,
  type DeviceResponse,
  type DeviceRuleEvent,
} from "../src/lambda/device";
import { createDispatcher } from "../src/lambda/dispatcher";
import { Fault, type DeviceRecord } from "../src/domain";
import { keys } from "../src/store/keys";
import { sha256, validate } from "../src/contracts";
import { setup, capture, putHeaders, patch } from "./helpers";
import type * as W from "../src/Wire";

const offline = () =>
  new S3Client({
    region: "us-west-2",
    credentials: { accessKeyId: "AKIDLOCALTEST", secretAccessKey: "local" },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });

test("S3 PUT grants sign exact key, content type and If-None-Match with no checksum parameter", async () => {
  const signer = new S3Signer(offline(), "clippy-media-test");
  const expiresAt = new Date(Date.now() + 900_000).toISOString();
  const { putURL } = await signer.signPut({
    key: "u/owner-1/s/snap_1/upload_1",
    item: {
      kind: "capture",
      captureId: "cap_1",
      byteLength: 10,
      sha256: "a".repeat(64),
      contentType: "image/png",
    },
    expiresAt,
  });
  const url = new URL(putURL);
  assert.equal(url.protocol, "https:");
  assert.match(
    url.hostname,
    /^clippy-media-test\.s3\.us-west-2\.amazonaws\.com$/,
  );
  assert.equal(url.pathname, "/u/owner-1/s/snap_1/upload_1");
  assert.equal(
    url.searchParams.get("X-Amz-SignedHeaders"),
    "content-type;host;if-none-match",
  );
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  assert.ok(expires > 890 && expires <= 900);
  for (const name of url.searchParams.keys())
    assert.ok(!/checksum/i.test(name), `unexpected ${name}`);
  const read = new URL(
    await signer.signGet({
      key: "u/owner-1/s/snap_1/upload_1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  assert.ok(Number(read.searchParams.get("X-Amz-Expires")) <= 60);
  assert.equal(read.searchParams.get("response-cache-control"), "no-store");
});

test("S3 object adapter maps checksums, missing objects, ranges and bounded prefix deletion", async () => {
  const sent: unknown[] = [];
  const hex = sha256("bytes");
  const client = {
    send: async (command: unknown) => {
      sent.push(command);
      if (command instanceof HeadObjectCommand) {
        const key = command.input.Key;
        if (key === "u/o/missing")
          throw new NotFound({
            message: "missing",
            $metadata: { httpStatusCode: 404 },
          });
        return {
          ContentLength: 5,
          ChecksumSHA256: Buffer.from(hex, "hex").toString("base64"),
          ChecksumType: key === "u/o/multipart" ? "COMPOSITE" : "FULL_OBJECT",
        };
      }
      if (command instanceof GetObjectCommand)
        return {
          Body: {
            transformToByteArray: async () => new TextEncoder().encode("bytes"),
          },
        };
      if (command instanceof ListObjectsV2Command)
        return command.input.ContinuationToken
          ? { Contents: [{ Key: "u/o/2" }], IsTruncated: false }
          : {
              Contents: [{ Key: "u/o/1" }],
              IsTruncated: true,
              NextContinuationToken: "t",
            };
      if (command instanceof DeleteObjectsCommand) return { Errors: [] };
      throw new Error("unexpected command");
    },
  } as unknown as S3Client;
  const objects = new S3Objects(client, "bucket");
  assert.deepEqual(await objects.head("u/o/single"), {
    byteLength: 5,
    sha256: hex,
  });
  assert.deepEqual(await objects.head("u/o/multipart"), {
    byteLength: 5,
    sha256: undefined,
  });
  assert.equal(await objects.head("u/o/missing"), undefined);
  assert.deepEqual(
    await objects.read("u/o/single", 4),
    new TextEncoder().encode("bytes"),
  );
  const get = sent.find(
    (c) => c instanceof GetObjectCommand,
  ) as GetObjectCommand;
  assert.equal(get.input.Range, "bytes=0-4");
  await objects.removePrefix("u/owner-1/");
  const deletes = sent.filter(
    (c) => c instanceof DeleteObjectsCommand,
  ) as DeleteObjectsCommand[];
  assert.deepEqual(
    deletes.flatMap((d) => d.input.Delete!.Objects!.map((o) => o.Key)),
    ["u/o/1", "u/o/2"],
  );
  await assert.rejects(objects.removePrefix("u/"));
  await assert.rejects(objects.removePrefix(""));
});

test("Step Functions starter names executions by job ID, carries references only, tolerates repeats", async () => {
  const calls: StartExecutionCommand[] = [];
  let repeat = false;
  const client = {
    send: async (command: StartExecutionCommand) => {
      calls.push(command);
      if (repeat)
        throw new ExecutionAlreadyExists({ message: "exists", $metadata: {} });
      repeat = true;
      return {};
    },
  } as unknown as SFNClient;
  const starter = new StepFunctionsJobStarter(
    client,
    "arn:aws:states:us-west-2:000000000000:stateMachine:x",
  );
  const job = {
    jobId: "job_abc",
    owner: "owner-1",
    dayId: "day_20261107",
    inputRevision: 3,
  };
  await starter.start(job);
  await starter.start(job);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.input.name, "job_abc");
  assert.deepEqual(Object.keys(JSON.parse(calls[0]!.input.input!)).sort(), [
    "dayId",
    "inputRevision",
    "jobId",
    "owner",
    "schemaVersion",
  ]);
});

test("operational logs drop unsafe keys and redact URLs and tokens", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  safeLog("probe", {
    route: "GET /v1/days/{dayId}",
    url: "https://bucket.s3.amazonaws.com/u/x?X-Amz-Signature=abc",
    token: "Bearer eyJhbGciOiJSUzI1NiJ9.payload",
    "bad key": "x",
  });
  const record = JSON.parse(lines[0]!);
  assert.equal(record.route, "GET /v1/days/{dayId}");
  assert.equal(record.url, "[redacted]");
  assert.equal(record.token, "[redacted]");
  assert.equal(record["bad key"], undefined);
});

const auth = { clientId: "client_app", requiredScope: "clippy/journal" };
const access = (sub: string, extra: Record<string, unknown> = {}) => ({
  sub,
  token_use: "access",
  client_id: "client_app",
  scope: "openid clippy/journal",
  ...extra,
});
function apiEvent(
  method: string,
  path: string,
  claims: Record<string, unknown> | undefined,
  body?: unknown,
  key = "api_key",
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    version: "2.0",
    routeKey: `${method} ${path.replace(/\/(cap|day|moment|sync|deletion|dev|reflection|correction)_[a-z0-9_]+/g, "/{id}")}`,
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json", "idempotency-key": key },
    requestContext: {
      requestId: "Abc123=",
      http: {
        method,
        path,
        protocol: "HTTP/1.1",
        sourceIp: "203.0.113.1",
        userAgent: "test",
      },
      authorizer: claims ? { jwt: { claims, scopes: [] } } : undefined,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

test("API claims: only access tokens for this client and scope with a safe subject authorize", () => {
  assert.deepEqual(actorFromClaims(access("2f1c-uuid") as never, auth), {
    owner: "2f1c-uuid",
    deviceId: null,
  });
  for (const claims of [
    undefined,
    access("u1", { token_use: "id" }),
    access("u1", { client_id: "other" }),
    access("u1", { scope: "openid" }),
    access("USER#u1"),
    access(""),
  ])
    assert.throws(
      () => actorFromClaims(claims as never, auth),
      (e: unknown) => e instanceof Fault && e.status === 401,
    );
});

test("API Lambda isolates owners across every resource family and logs route templates only", async (t) => {
  const { engine, store } = await setup(t);
  // Bind the synthetic device to a Cognito-shaped owner for this test.
  const ownerA = "1d2c3b4a-0000-4000-8000-00000000000a";
  await patch<DeviceRecord>(store, keys.identity("dev_sample_001"), (d) => {
    d.owner = ownerA;
  });
  await store.transact([
    {
      op: "put",
      item: {
        ...keys.deviceRef(ownerA, "dev_sample_001"),
        v: 1,
        data: { deviceId: "dev_sample_001" },
      },
    },
  ]);
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => lines.push(line));
  const handler = createApiHandler(engine, auth);
  const a = access(ownerA),
    b = access("1d2c3b4a-0000-4000-8000-00000000000b");
  const ok = await handler(apiEvent("GET", "/v1/devices", a));
  assert.equal(ok.statusCode, 200);
  assert.equal(JSON.parse(ok.body as string).items.length, 1);
  const sync = await handler(
    apiEvent(
      "POST",
      "/v1/devices/dev_sample_001/sync-requests",
      a,
      { schemaVersion: 1, trigger: "manual" },
      "sync_a",
    ),
  );
  assert.equal(sync.statusCode, 202);
  const syncId = JSON.parse(sync.body as string).syncRequestId as string;
  for (const [method, path, body] of [
    ["GET", "/v1/devices/dev_sample_001"],
    [
      "POST",
      "/v1/devices/dev_sample_001/sync-requests",
      { schemaVersion: 1, trigger: "manual" },
    ],
    ["GET", `/v1/sync-requests/${syncId}`],
    ["POST", `/v1/sync-requests/${syncId}/cancel`],
    ["DELETE", "/v1/captures/cap_sample_001"],
    ["DELETE", "/v1/days/day_20261107"],
    ["POST", "/v1/captures/cap_sample_001/read-url"],
    [
      "PUT",
      "/v1/moments/moment_cap_sample_001/corrections/correction_x",
      {
        schemaVersion: 1,
        operationId: "api_key",
        expectedRevision: 0,
        text: "x",
        deleted: false,
      },
    ],
    [
      "PUT",
      "/v1/days/day_20261107/reflections/reflection_x",
      {
        schemaVersion: 1,
        operationId: "api_key",
        expectedRevision: 0,
        text: "x",
        deleted: false,
      },
    ],
  ] as Array<[string, string, unknown?]>) {
    const response = await handler(apiEvent(method, path, b, body));
    assert.equal(response.statusCode, 404, `${method} ${path}`);
    validate("Error", JSON.parse(response.body as string));
  }
  const unauthenticated = await handler(apiEvent("GET", "/v1/days", undefined));
  assert.equal(unauthenticated.statusCode, 401);
  const idToken = await handler(
    apiEvent("GET", "/v1/days", access(ownerA, { token_use: "id" })),
  );
  assert.equal(idToken.statusCode, 401);
  const device = await handler(apiEvent("POST", "/v1/device/snapshots", a, {}));
  assert.equal(device.statusCode, 501);
  const me = await handler(apiEvent("GET", "/v1/me", a));
  validate("Profile", JSON.parse(me.body as string));
  const logged = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "api.request");
  assert.ok(logged.length > 10);
  for (const entry of logged) {
    assert.ok(!JSON.stringify(entry).includes(ownerA));
    assert.ok(!JSON.stringify(entry).includes("dev_sample_001"));
    assert.ok(/^req_[a-z0-9]+$/.test(entry.requestId));
  }
});

test("IoT handler runs the upload protocol over MQTT envelopes and answers only the authenticated thing", async (t) => {
  const { engine, store } = await setup(t);
  const published: Array<{ topic: string; payload: DeviceResponse }> = [];
  const handler = createDeviceHandler(engine, {
    publish: async (topic, payload) => {
      published.push({ topic, payload });
    },
  });
  const base = {
    thingName: "dev_sample_001",
    clientId: "dev_sample_001",
    principal: "cert-1",
    schemaVersion: 1,
  };
  const call = async (event: Partial<DeviceRuleEvent>) => {
    await handler({ ...base, ...event } as DeviceRuleEvent);
    return published.at(-1)!;
  };
  const c = capture(1);
  const begin: W.BeginSync = {
    schemaVersion: 1,
    deviceId: "dev_sample_001",
    ownershipEpoch: 1,
    syncRequestId: null,
    trigger: "manual",
    startedAt: "2026-11-07T20:00:00Z",
    cutoffAt: "2026-11-07T20:00:00Z",
    sequenceStart: 1,
    sequenceEnd: 1,
    captureCount: 1,
    configurationRevision: 1,
  };
  const started = await call({
    requestId: "req_begin",
    type: "sync.begin",
    body: begin,
  });
  assert.equal(
    started.topic,
    "clippy/v1/devices/dev_sample_001/responses/req_begin",
  );
  assert.equal(started.payload.status, 201);
  const snapshot = started.payload.body as W.Snapshot;
  const replay = await call({
    requestId: "req_begin",
    type: "sync.begin",
    body: begin,
  });
  assert.deepEqual(replay.payload, started.payload);
  const grants = await call({
    requestId: "req_grants",
    type: "upload.grants",
    snapshotId: snapshot.snapshotId,
    body: {
      schemaVersion: 1,
      deviceId: "dev_sample_001",
      ownershipEpoch: 1,
      items: [
        {
          kind: "capture",
          captureId: c.value.captureId,
          byteLength: c.value.byteLength,
          sha256: c.value.sha256,
          contentType: "image/png",
        },
      ],
    },
  });
  assert.equal(grants.payload.status, 200);
  const grant = (grants.payload.body as W.UploadGrants).items[0]!;
  const device = { owner: "user_a", deviceId: "dev_sample_001" };
  await engine.put(device, grant.uploadId, c.bytes, putHeaders(c));
  const manifest = Buffer.from(
    JSON.stringify({
      ...snapshot,
      trigger: "manual",
      startedAt: begin.startedAt,
      cutoffAt: begin.cutoffAt,
      sequenceStart: 1,
      sequenceEnd: 1,
      captureCount: 1,
      captures: [{ ...c.value, uploadId: grant.uploadId }],
      gaps: [],
    }),
  );
  const mgrant = await call({
    requestId: "req_manifest",
    type: "upload.grants",
    snapshotId: snapshot.snapshotId,
    body: {
      schemaVersion: 1,
      deviceId: "dev_sample_001",
      ownershipEpoch: 1,
      items: [
        {
          kind: "manifest",
          captureId: null,
          byteLength: manifest.length,
          sha256: sha256(manifest),
          contentType: "application/json",
        },
      ],
    },
  });
  const manifestGrant = (mgrant.payload.body as W.UploadGrants).items[0]!;
  await engine.put(device, manifestGrant.uploadId, manifest, {
    "if-none-match": "*",
    "x-clippy-sha256": sha256(manifest),
    "content-type": "application/json",
  });
  const done = await call({
    requestId: "req_complete",
    type: "sync.complete",
    snapshotId: snapshot.snapshotId,
    body: {
      schemaVersion: 1,
      deviceId: "dev_sample_001",
      ownershipEpoch: 1,
      manifestUploadId: manifestGrant.uploadId,
      manifestSHA256: sha256(manifest),
    },
  });
  assert.equal(done.payload.status, 200);
  validate("Receipt", done.payload.body);

  // Identity comes from the rule, never from the payload.
  const forged = await call({
    thingName: "dev_sample_002",
    clientId: "dev_sample_002",
    requestId: "req_forged",
    type: "sync.complete",
    snapshotId: snapshot.snapshotId,
    body: {
      schemaVersion: 1,
      deviceId: "dev_sample_001",
      ownershipEpoch: 1,
      manifestUploadId: manifestGrant.uploadId,
      manifestSHA256: sha256(manifest),
    },
  });
  assert.equal(
    forged.topic,
    "clippy/v1/devices/dev_sample_002/responses/req_forged",
  );
  assert.ok([403, 404].includes(forged.payload.status));
  const mismatch = await call({
    clientId: "dev_sample_002",
    requestId: "req_mismatch",
    type: "sync.begin",
    body: begin,
  });
  assert.equal(mismatch.payload.status, 403);
  await patch<DeviceRecord>(store, keys.identity("dev_sample_001"), (d) => {
    d.certificateId = "cert-registered";
  });
  const wrongCert = await call({
    requestId: "req_cert",
    type: "sync.begin",
    body: begin,
  });
  assert.equal(wrongCert.payload.status, 403);
  const badType = await call({
    principal: "cert-registered",
    requestId: "req_type",
    type: "claim.prove",
    body: {},
  });
  assert.equal(badType.payload.status, 400);
  const badVersion = await call({
    principal: "cert-registered",
    schemaVersion: 2,
    requestId: "req_version",
    type: "sync.begin",
    body: begin,
  });
  assert.equal(badVersion.payload.status, 400);
  const count = published.length;
  await handler({
    ...base,
    requestId: "../../other",
    type: "sync.begin",
    body: begin,
  } as DeviceRuleEvent);
  assert.equal(
    published.length,
    count,
    "no publish without a valid request ID",
  );
});

test("stream dispatcher handles only outbox inserts and reports failures per record", async (t) => {
  const { engine } = await setup(t, { dispatch: "deferred" });
  const dispatched: string[] = [];
  const fake = Object.create(engine) as typeof engine;
  fake.dispatch = async (id: string) => {
    if (id === "ob_fail") throw new Error("boom");
    dispatched.push(id);
    return "dispatched";
  };
  const dispatcher = createDispatcher(fake);
  const record = (
    eventName: string,
    kind: string,
    id: string,
    seq: string,
  ) => ({
    eventName,
    dynamodb: {
      SequenceNumber: seq,
      NewImage: { kind: { S: kind }, d: { S: JSON.stringify({ id }) } },
    },
  });
  t.mock.method(console, "log", () => {});
  const result = await dispatcher({
    Records: [
      record("INSERT", "outbox", "ob_one", "1"),
      record("MODIFY", "outbox", "ob_two", "2"),
      record("INSERT", "other", "ob_three", "3"),
      record("INSERT", "outbox", "ob_fail", "4"),
    ],
  } as unknown as DynamoDBStreamEvent);
  assert.deepEqual(dispatched, ["ob_one"]);
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: "4" }]);
});
