import test from "node:test";
import assert from "node:assert/strict";
import { storeConformance } from "./store-conformance";
import { MemoryStore } from "../src/store/memory";
import {
  setup,
  upload,
  capture,
  app,
  device,
  count,
  keyFor,
  type Harness,
} from "./helpers";
import { Fault, jobIdFor, type OutboxRecord } from "../src/domain";
import { createRouter } from "../src/router";
import { validate } from "../src/contracts";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";
import type { JobStarter } from "../src/ports";
import type { EditInput } from "../src/Wire";

storeConformance("memory", async () => new MemoryStore());

const dayId = "day_20261107";
const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Fault && error.code === code;
const edit = (
  operationId: string,
  text: string,
  expectedRevision = 0,
): EditInput => ({
  schemaVersion: 1,
  operationId,
  expectedRevision,
  text,
  deleted: false,
});
class RecordingStarter implements JobStarter {
  started: Array<{ jobId: string; dayId: string; inputRevision: number }> = [];
  async start(input: { jobId: string; dayId: string; inputRevision: number }) {
    this.started.push({ ...input });
  }
}
const pending = async (h: Harness) =>
  (await h.all("operations"))
    .filter((i) => i.sk === "OUTBOX" && i.opk)
    .map((i) => i.data as OutboxRecord)
    .sort((a, b) => (a.inputRevision ?? 0) - (b.inputRevision ?? 0));

test("crash after snapshot acceptance leaves a durable receipt and recovery completes the projection", async (t) => {
  const h = await setup(t, { dispatch: "deferred" });
  const { engine, restart } = h;
  const flow = await upload(engine, [capture(1), capture(2)]);
  const receipt = await flow.finish();
  // Deferred dispatch models a Lambda that stopped after the database commit.
  assert.equal(receipt.acceptedCaptureIds.length, 2);
  assert.equal((await engine.getDay(app, dayId)).state, "empty");
  assert.deepEqual(
    (await pending(h)).map((o) => o.kind),
    ["snapshot.accepted"],
  );
  const recovered = await restart();
  const first = await recovered.recover();
  assert.equal(first.dispatched, 1);
  assert.equal((await recovered.getDay(app, dayId)).state, "pending");
  assert.equal(await count(h, "CAP#"), 2);
  assert.deepEqual(
    (await pending(h)).map((o) => o.kind),
    ["day.process"],
  );
  // Replaying the same snapshot work is a no-op.
  await recovered.materialize(flow.snapshot.snapshotId);
  assert.equal((await recovered.getDay(app, dayId)).inputRevision, 1);
});

test("a crash between capture projection and the day revision bump is repaired exactly once", async (t) => {
  const h = await setup(t, { dispatch: "deferred" });
  const { engine } = h;
  const flow = await upload(engine, [capture(1), capture(2)]);
  await flow.finish();
  let crash = true;
  if (!h.memory) return t.skip("fault injection needs the memory store");
  const store = h.memory;
  store.hooks.afterTransact = (writes) => {
    if (
      crash &&
      writes.some((w) => w.op === "put" && w.item.sk.startsWith("APPLIED#"))
    ) {
      crash = false;
      throw new Error("Simulated process exit after day commit");
    }
  };
  await assert.rejects(
    engine.recover().then((r) => {
      if (r.failed.length) throw new Error(r.failed[0]!.error);
    }),
  );
  store.hooks = {};
  assert.equal((await engine.getDay(app, dayId)).inputRevision, 1);
  const again = await engine.recover();
  assert.deepEqual(again.failed, []);
  assert.equal((await engine.getDay(app, dayId)).inputRevision, 1);
  assert.equal(
    (await h.all("operations")).find((i) => i.sk === "SNAP")?.data &&
      (
        (await h.all("operations")).find((i) => i.sk === "SNAP")!.data as {
          materialized: boolean;
        }
      ).materialized,
    true,
  );
  void flow;
});

test("a failed commit before the outbox write admits nothing", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  const flow = await upload(engine, [capture(1)]);
  if (!h.memory) return t.skip("fault injection needs the memory store");
  const store = h.memory;
  store.hooks.beforeTransact = (writes) => {
    if (writes.some((w) => w.op === "put" && w.item.sk === "OUTBOX"))
      throw new Error("Simulated database outage");
  };
  await assert.rejects(flow.finish(), /Simulated database outage/);
  store.hooks = {};
  assert.equal((await pending(h)).length, 0);
  assert.equal((await engine.getDay(app, dayId)).state, "empty");
  const receipt = await flow.finish();
  assert.equal(receipt.acceptedCaptureIds.length, 1);
});

test("recovery starts each current day revision once and skips superseded revisions", async (t) => {
  const starter = new RecordingStarter();
  const h = await setup(t, { jobs: starter });
  const { engine } = h;
  await (await upload(engine, [capture(1)])).finish();
  await (await upload(engine, [capture(2)], { key: "second" })).finish();
  assert.deepEqual(
    (await pending(h)).map((o) => [o.kind, o.inputRevision]),
    [
      ["day.process", 1],
      ["day.process", 2],
    ],
  );
  const result = await engine.recover();
  assert.equal(result.dispatched, 2);
  assert.deepEqual(starter.started, [
    {
      jobId: jobIdFor("user_a", dayId, 2, "mock_1"),
      owner: "user_a",
      dayId,
      inputRevision: 2,
    },
  ]);
  assert.equal((await engine.recover()).dispatched, 0);
  assert.equal(starter.started.length, 1);
});

test("corrections and capture deletion enqueue reprocessing; reflections do not", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  await (await upload(engine, [capture(1), capture(2)])).finish();
  await engine.process(
    app.owner,
    dayId,
    new MockObservationProvider(),
    new MockRecapProvider(),
  );
  const reprocess = async () =>
    (await pending(h)).filter((o) => o.kind === "day.process").length;
  const before = await reprocess();
  // A committed publication also leaves exactly one notification entry.
  assert.equal(
    (await pending(h)).filter((o) => o.kind === "recap.published").length,
    1,
  );
  await engine.saveEdit(
    app,
    "reflection",
    dayId,
    "reflection_main",
    edit("r1", "Text"),
  );
  assert.equal(await reprocess(), before);
  await engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_001",
    "c1",
    edit("c1", "Fix"),
  );
  assert.equal(await reprocess(), before + 1);
  await engine.delete(app, { kind: "capture", id: "cap_sample_002" });
  assert.equal(await reprocess(), before + 2);
});

test("deferred deletion tombstones immediately and removes content when dispatched", async (t) => {
  const h = await setup(t, { dispatch: "deferred" });
  const { engine } = h;
  await (await upload(engine, [capture(1)])).finish();
  await engine.recover();
  await engine.process(
    app.owner,
    dayId,
    new MockObservationProvider(),
    new MockRecapProvider(),
  );
  await engine.saveEdit(
    app,
    "reflection",
    dayId,
    "reflection_main",
    edit("r1", "Synthetic deferred marker"),
  );
  const job = await engine.delete(app, { kind: "day", id: dayId });
  assert.equal(job.state, "deleting_cloud");
  await assert.rejects(engine.getDay(app, dayId), hasCode("DELETED"));
  assert.equal((await engine.days(app, new URLSearchParams())).items.length, 0);
  assert.ok((await h.dump()).includes("Synthetic deferred marker"));
  await engine.recover();
  assert.ok(!(await h.dump()).includes("Synthetic deferred marker"));
  assert.equal(
    (await engine.deletion(app, job.jobId)).state,
    "waiting_for_clients",
  );
});

test("concurrent edits with the same expected revision: one wins, one sees REVISION_CONFLICT", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  const results = await Promise.allSettled([
    engine.saveEdit(
      app,
      "reflection",
      dayId,
      "reflection_main",
      edit("a", "First"),
    ),
    engine.saveEdit(
      app,
      "reflection",
      dayId,
      "reflection_main",
      edit("b", "Second"),
    ),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find(
    (r) => r.status === "rejected",
  ) as PromiseRejectedResult;
  assert.ok(hasCode("REVISION_CONFLICT")(rejected.reason));
  assert.equal((await engine.getDay(app, dayId)).reflections.length, 1);
});

test("concurrent sync taps coalesce into one request", async (t) => {
  const { engine } = await setup(t);
  const [a, b] = await Promise.all([
    engine.requestSync(app, device.deviceId!),
    engine.requestSync(app, device.deviceId!),
  ]);
  assert.equal(a.syncRequestId, b.syncRequestId);
});

test("concurrent publication of a superseded job cannot overwrite a newer revision", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  const job = await engine.prepareJob(app.owner, dayId);
  const result = new MockRecapProvider().compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  await Promise.all([
    engine.saveEdit(
      app,
      "correction",
      "moment_cap_sample_001",
      "c1",
      edit("c1", "Newer"),
    ),
    engine.publish(job, result).catch((e) => e),
  ]);
  const day = await engine.getDay(app, dayId);
  assert.equal(day.inputRevision, 2);
  if (day.recap)
    assert.equal(
      day.recap.inputRevision,
      1,
      "only the frozen revision is published",
    );
  assert.equal(day.state, "pending");
});

test("profile defaults, revision-checked preferences and UTC-only journal boundary", async (t) => {
  const { engine } = await setup(t);
  const profile = await engine.profile(app);
  validate("Profile", profile);
  assert.equal(profile.revision, 1);
  const updated = await engine.preferences(app, {
    schemaVersion: 1,
    expectedRevision: 1,
    journalTimeZone: "UTC",
    retentionDays: 3,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.retentionDays, 3);
  await assert.rejects(
    engine.preferences(app, {
      schemaVersion: 1,
      expectedRevision: 1,
      journalTimeZone: "UTC",
      retentionDays: 5,
    }),
    (e: unknown) =>
      e instanceof Fault &&
      e.code === "REVISION_CONFLICT" &&
      e.currentRevision === 2,
  );
  await assert.rejects(
    engine.preferences(app, {
      schemaVersion: 1,
      expectedRevision: 2,
      journalTimeZone: "America/Los_Angeles",
      retentionDays: 5,
    }),
    hasCode("INVALID_REQUEST"),
  );
  assert.equal(
    (await engine.profile({ owner: "user_b", deviceId: null })).revision,
    1,
  );
});

test("read grants check ownership and tombstones; receipts never store the signed URL", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  await (await upload(engine, [capture(1)])).finish();
  const route = createRouter(engine, { local: true });
  const call = (owner: string, key: string) =>
    route({
      method: "POST",
      path: "/v1/captures/cap_sample_001/read-url",
      query: new URLSearchParams(),
      headers: { "idempotency-key": key },
      body: new Uint8Array(),
      actor: { owner, deviceId: null },
      origin: "http://127.0.0.1:1",
    });
  const granted = await call("user_a", "read_one");
  assert.equal(granted.status, 200);
  validate("ReadGrant", granted.body);
  const body = granted.body as { readURL: string; expiresAt: string };
  assert.equal(body.expiresAt, "2026-11-07T20:01:00Z");
  const stored = (await h.all("operations"))
    .filter((i) => i.pk.endsWith("#RECEIPTS"))
    .map((i) => JSON.stringify(i.data));
  assert.ok(stored.every((text) => !text.includes(body.readURL)));
  assert.deepEqual((await call("user_a", "read_one")).body, granted.body);
  assert.equal((await call("user_b", "read_two")).status, 404);
  await engine.delete(app, { kind: "capture", id: "cap_sample_001" });
  assert.notEqual((await call("user_a", "read_one")).status, 200);
});

test("AWS router mode exposes no device, upload or processing routes", async (t) => {
  const { engine } = await setup(t);
  const route = createRouter(engine, { local: false });
  for (const [method, path] of [
    ["POST", "/v1/device/snapshots"],
    ["PUT", "/local/uploads/upload_x"],
    ["POST", "/local/process"],
  ] as const) {
    const result = await route({
      method,
      path,
      query: new URLSearchParams(),
      headers: { "idempotency-key": "probe" },
      body: new TextEncoder().encode("{}"),
      actor: { owner: "user_a", deviceId: null },
    });
    assert.ok(
      [403, 501].includes(result.status),
      `${method} ${path} -> ${result.status}`,
    );
  }
});

test("snapshot verification reports every missing object", async (t) => {
  const { engine, objects } = await setup(t);
  const flow = await upload(engine, [capture(1), capture(2), capture(3)], {
    omit: "cap_sample_002",
  });
  await objects.remove([
    keyFor(flow.snapshot.snapshotId, flow.grants[2]!.uploadId),
  ]);
  await assert.rejects(flow.finish(), (error: unknown) => {
    assert.ok(error instanceof Fault && error.code === "MISSING_OBJECTS");
    assert.equal(error.retryable, true);
    assert.deepEqual(error.itemIds, [
      flow.grants[1]!.uploadId,
      flow.grants[2]!.uploadId,
    ]);
    return true;
  });
});
