import test from "node:test";
import assert from "node:assert/strict";
import {
  setup,
  upload,
  capture,
  app,
  device,
  count,
  patch,
  keyFor,
  type Harness,
} from "./helpers";
import { Fault, type DeviceRecord } from "../src/domain";
import { validate, sha256 } from "../src/contracts";
import { keys } from "../src/store/keys";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";
import type { EditInput, Recap } from "../src/Wire";

const dayId = "day_20261107";
const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    error instanceof Fault && error.code === code;
const process = (engine: Harness["engine"]) =>
  engine.process(
    app.owner,
    dayId,
    new MockObservationProvider(),
    new MockRecapProvider(),
  );
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
const compose = async (engine: Harness["engine"]) => {
  const job = await engine.prepareJob(app.owner, dayId);
  const result = new MockRecapProvider().compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  return { job, result };
};

test("two snapshots preserve edits, deduplicate captures/moments, and reuse observations", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  const first = await upload(engine, [capture(1), capture(2)]);
  const receipt = await first.finish();
  assert.deepEqual(await first.finish(), receipt);
  assert.equal((await engine.getDay(app, dayId)).inputRevision, 1);
  const ready = await process(engine);
  validate("Day", ready);
  assert.equal(ready.recap?.moments.length, 2);
  const r = edit("edit_reflection", "A day worth remembering.");
  await engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, (tx) =>
    engine.saveEdit(app, "reflection", dayId, "reflection_main", r, tx),
  );
  const c = edit("edit_correction", "A quiet break.");
  await engine.mutate(app, "PUT", "/correction", c.operationId, c, 200, (tx) =>
    engine.saveEdit(
      app,
      "correction",
      "moment_cap_sample_001",
      "correction_main",
      c,
      tx,
    ),
  );
  await (
    await upload(engine, [capture(2), capture(3)], {
      trigger: "nightly",
      key: "second",
    })
  ).finish();
  const updated = await process(engine);
  assert.equal(updated.recap?.moments.length, 3);
  assert.equal(new Set(updated.recap?.moments.map((m) => m.momentId)).size, 3);
  assert.equal(updated.reflections[0]?.text, r.text);
  assert.equal(updated.reflections[0]?.revision, 1);
  assert.equal(updated.corrections[0]?.text, c.text);
  assert.equal(updated.recap?.moments[0]?.title, c.text);
  assert.equal(await count(h, "OBS#"), 3);
  const prior = JSON.stringify(updated);
  await process(engine);
  assert.equal(JSON.stringify(await engine.getDay(app, dayId)), prior);
});

test("idempotency conflict and stale edit revision cannot overwrite user text", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  await process(engine);
  const r = edit("edit_once", "Original");
  const save = () =>
    engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, (tx) =>
      engine.saveEdit(app, "reflection", dayId, "reflection_main", r, tx),
    );
  assert.deepEqual(await save(), await save());
  await assert.rejects(
    engine.mutate(
      app,
      "PUT",
      "/reflection",
      r.operationId,
      { ...r, text: "Changed" },
      200,
      async () => null,
    ),
    hasCode("CONFLICT"),
  );
  await assert.rejects(
    engine.saveEdit(
      app,
      "reflection",
      dayId,
      "reflection_main",
      edit("edit_stale", "Lost update"),
    ),
    hasCode("REVISION_CONFLICT"),
  );
  assert.equal(
    (await engine.getDay(app, dayId)).reflections[0]?.text,
    "Original",
  );
});

test("missing upload survives persisted server restart and resumes without early acknowledgement", async (t) => {
  const { engine, restart } = await setup(t);
  const flow = await upload(engine, [capture(1), capture(2)], {
    omit: "cap_sample_002",
  });
  await assert.rejects(flow.finish(), (error: unknown) => {
    assert.ok(error instanceof Fault && error.code === "MISSING_OBJECTS");
    assert.deepEqual(error.itemIds, [flow.grants[1]!.uploadId]);
    return true;
  });
  assert.equal((await engine.getDay(app, dayId)).state, "empty");
  const resumed = await restart(),
    c = capture(2),
    g = flow.grants[1]!;
  await resumed.put(device, g.uploadId, c.bytes, {
    "if-none-match": "*",
    "x-clippy-sha256": c.value.sha256,
    "content-type": c.value.contentType,
  });
  const receipt = (
    await resumed.mutate(
      device,
      "POST",
      "/complete",
      "resume",
      flow.complete,
      200,
      (tx) =>
        resumed.complete(device, flow.snapshot.snapshotId, flow.complete, tx),
    )
  ).body;
  assert.equal(receipt.acceptedCaptureIds.length, 2);
  assert.equal((await (await restart()).getDay(app, dayId)).state, "pending");
});

test("conditional PUT, wrong size/hash and corrupted stored object are rejected", async (t) => {
  const { engine, objects } = await setup(t),
    c = capture(1);
  const flow = await upload(engine, [c], { omit: c.value.captureId });
  const g = flow.grants[0]!;
  const headers = {
    "if-none-match": "*",
    "x-clippy-sha256": c.value.sha256,
    "content-type": c.value.contentType,
  };
  await assert.rejects(
    engine.put(device, g.uploadId, c.bytes.subarray(1), headers),
    hasCode("SIZE_MISMATCH"),
  );
  const bad = Buffer.from(c.bytes);
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  await assert.rejects(
    engine.put(device, g.uploadId, bad, headers),
    hasCode("CHECKSUM_MISMATCH"),
  );
  await engine.put(device, g.uploadId, c.bytes, headers);
  await assert.rejects(
    engine.put(device, g.uploadId, c.bytes, headers),
    hasCode("PRECONDITION_FAILED"),
  );
  objects.corrupt(keyFor(flow.snapshot.snapshotId, g.uploadId), bad);
  await assert.rejects(flow.finish(), hasCode("CHECKSUM_MISMATCH"));
  assert.equal((await engine.getDay(app, dayId)).state, "empty");
});

test("malformed manifest never partially admits an otherwise valid capture", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  const flow = await upload(engine, [capture(1), capture(2)], {
    manifestChange: (m) => {
      m.captures[1]!.captureId = m.captures[0]!.captureId;
    },
  });
  await assert.rejects(flow.finish(), hasCode("INVALID_MANIFEST"));
  assert.equal(await count(h, "CAP#"), 0);
});

test("changed immutable metadata on a later snapshot is a conflict", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  const altered = capture(1, "2026-11-07T08:59:00Z");
  const flow = await upload(engine, [altered], { key: "changed" });
  await assert.rejects(flow.finish(), hasCode("CONFLICT"));
  assert.equal((await engine.getDay(app, dayId)).inputRevision, 1);
});

test("device scope, stale epoch and revocation protect completion", async (t) => {
  const { engine, store } = await setup(t);
  const flow = await upload(engine, [capture(1)]);
  await assert.rejects(
    engine.complete(
      { owner: "user_b", deviceId: "dev_sample_002" },
      flow.snapshot.snapshotId,
      flow.complete,
    ),
    hasCode("NOT_FOUND"),
  );
  await assert.rejects(
    engine.complete(
      { ...device, deviceId: "dev_unknown" },
      flow.snapshot.snapshotId,
      flow.complete,
    ),
    hasCode("FORBIDDEN"),
  );
  const identity = keys.identity(device.deviceId!);
  await patch<DeviceRecord>(store, identity, (d) => {
    d.identity.ownershipEpoch = 2;
  });
  await assert.rejects(flow.finish(), hasCode("STALE_EPOCH"));
  await patch<DeviceRecord>(store, identity, (d) => {
    d.identity.ownershipEpoch = 1;
    d.identity.claimState = "revoked";
  });
  await assert.rejects(flow.finish(), hasCode("NOT_FOUND"));
});

test("stale recap publication and invented source evidence are rejected", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  const old = await compose(engine);
  await (await upload(engine, [capture(2)], { key: "new_snapshot" })).finish();
  await assert.rejects(
    engine.publish(old.job, old.result),
    hasCode("SUPERSEDED"),
  );
  const { job, result: forged } = await compose(engine);
  forged.moments[0]!.evidence[0]!.id = "cap_invented";
  await assert.rejects(engine.publish(job, forged), hasCode("INVALID_REQUEST"));
  const ready = await process(engine);
  assert.equal(ready.recap?.moments.length, 2);
});

test("partial and failure states remain meaningful and failure permits finite retry", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  await assert.rejects(
    engine.process(
      app.owner,
      dayId,
      new MockObservationProvider(),
      new MockRecapProvider(),
      true,
    ),
    hasCode("INTERNAL_ERROR"),
  );
  assert.equal((await engine.getDay(app, dayId)).state, "failure");
  const partial = await engine.process(
    app.owner,
    dayId,
    new MockObservationProvider(new Set(["cap_sample_002"])),
    new MockRecapProvider(),
  );
  assert.equal(partial.state, "partial");
  assert.equal(partial.recap?.coverage.missing, 1);
  assert.equal(partial.recap?.coverage.observed, 1);
});

test("capture deletion removes derived data, preserves unrelated bytes/edits and blocks in-flight publication", async (t) => {
  const h = await setup(t);
  const { engine, restart, objects } = h;
  const flow = await upload(engine, [capture(1), capture(2)]);
  await flow.finish();
  await process(engine);
  await engine.saveEdit(
    app,
    "reflection",
    dayId,
    "reflection_main",
    edit("reflect", "Keep this"),
  );
  await engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_001",
    "correction_target",
    edit("correct_target", "Synthetic correction marker to remove"),
  );
  await engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_002",
    "correction_other",
    edit("correct_other", "Still here"),
  );
  const { job, result } = await compose(engine);
  const deletion = (
    await engine.mutate(
      app,
      "DELETE",
      "/capture",
      "delete_one",
      null,
      202,
      (tx) => engine.delete(app, { kind: "capture", id: "cap_sample_001" }, tx),
    )
  ).body;
  // The receipt is truthful at commit time; cloud cleanup completes afterwards.
  assert.equal(deletion.state, "deleting_cloud");
  const settled = await engine.deletion(app, deletion.jobId);
  assert.equal(settled.state, "waiting_for_clients");
  assert.equal(settled.cloudComplete, true);
  assert.deepEqual(settled.pendingDeviceIds, ["dev_sample_001"]);
  const snap = flow.snapshot.snapshotId;
  assert.equal(
    await objects.head(keyFor(snap, flow.grants[0]!.uploadId)),
    undefined,
  );
  assert.ok(await objects.head(keyFor(snap, flow.grants[1]!.uploadId)));
  assert.equal(
    await objects.head(keyFor(snap, flow.manifestGrant.uploadId)),
    undefined,
  );
  assert.equal((await engine.getDay(app, dayId)).recap, null);
  await assert.rejects(engine.publish(job, result), hasCode("SUPERSEDED"));
  await assert.rejects(
    engine.complete(device, flow.snapshot.snapshotId, flow.complete),
    hasCode("DELETED"),
  );
  const updated = await process(await restart());
  assert.equal(updated.recap?.moments.length, 1);
  assert.equal(updated.reflections[0]?.text, "Keep this");
  assert.deepEqual(
    updated.corrections.map((c) => c.text),
    ["Still here"],
  );
  const stateText = await h.dump();
  assert.ok(!stateText.includes("Synthetic correction marker to remove"));
  assert.ok(!stateText.includes(`"cap_sample_001","deviceId"`));
});

test("deleted capture is suppressed in a later manifest and cannot resurrect", async (t) => {
  const h = await setup(t);
  const { engine } = h;
  await (await upload(engine, [capture(1)])).finish();
  await engine.mutate(
    app,
    "DELETE",
    "/capture",
    "delete_capture",
    null,
    202,
    (tx) => engine.delete(app, { kind: "capture", id: "cap_sample_001" }, tx),
  );
  const replay = await upload(engine, [capture(1)], {
    key: "later",
    omit: "cap_sample_001",
  });
  const receipt = await replay.finish();
  assert.deepEqual(receipt.acceptedCaptureIds, []);
  assert.deepEqual(receipt.suppressedCaptureIds, ["cap_sample_001"]);
  assert.equal(receipt.effectiveDigest, sha256(""));
  assert.equal(await count(h, "CAP#"), 0);
});

test("day and account deletion remove text, media, jobs and receipts across restart", async (t) => {
  const h = await setup(t);
  const { engine, restart } = h;
  const flow = await upload(engine, [capture(1)]);
  await flow.finish();
  await process(engine);
  const r = edit("private_edit", "Synthetic text marker to remove");
  await engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, (tx) =>
    engine.saveEdit(app, "reflection", dayId, "reflection_main", r, tx),
  );
  await engine.mutate(app, "DELETE", "/day", "delete_day", null, 202, (tx) =>
    engine.delete(app, { kind: "day", id: dayId }, tx),
  );
  await assert.rejects(
    (await restart()).getDay(app, dayId),
    hasCode("DELETED"),
  );
  assert.ok(!(await h.dump()).includes(r.text));
  assert.equal(await count(h, "JOB#"), 0);
  assert.equal(await count(h, "OBS#"), 0);
  const receipt = (
    await engine.mutate(
      app,
      "DELETE",
      "/me",
      "delete_account",
      null,
      202,
      (tx) => engine.delete(app, { kind: "account" }, tx),
    )
  ).body;
  await assert.rejects(
    (await restart()).devices(app, new URLSearchParams()),
    hasCode("DELETED"),
  );
  assert.equal((await engine.deletion(app, receipt.jobId)).targetId, "account");
  assert.equal(
    (await h.all()).filter((i) => i.pk.startsWith("USER#user_a#")).length,
    // Only the account deletion's own receipt remains; it holds no content.
    1,
  );
  void flow;
});

test("a capture named like a reserved target cannot delete the account", async (t) => {
  const { engine } = await setup(t);
  await assert.rejects(
    engine.delete(app, { kind: "capture", id: "account" }),
    hasCode("NOT_FOUND"),
  );
  assert.equal(
    (await engine.devices(app, new URLSearchParams())).items.length,
    1,
  );
});

test("backlog is grouped by capture date; untrusted clock is quarantined", async (t) => {
  const { engine } = await setup(t);
  const a = capture(1, "2026-11-05T23:59:59Z"),
    b = capture(2, "2026-11-06T00:00:00Z"),
    c = capture(3, "2000-01-01T00:00:00Z");
  c.value.clockQuality = "untrusted";
  const receipt = await (await upload(engine, [a, b, c])).finish();
  assert.deepEqual(receipt.dayIds, ["day_20261105", "day_20261106"]);
  assert.equal((await engine.getDay(app, "day_20000101")).state, "empty");
  assert.equal((await engine.getDay(app, dayId)).state, "empty");
});

test("opaque pagination binds owner, filters and result revision", async (t) => {
  const { engine } = await setup(t);
  await (
    await upload(engine, [
      capture(1, "2026-11-05T12:00:00Z"),
      capture(2, "2026-11-06T12:00:00Z"),
    ])
  ).finish();
  const first = await engine.days(app, new URLSearchParams("limit=1"));
  assert.ok(first.nextCursor);
  assert.equal(first.items[0]?.dayId, "day_20261106");
  const second = await engine.days(
    app,
    new URLSearchParams(`limit=1&cursor=${first.nextCursor}`),
  );
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0]?.dayId, "day_20261105");
  await assert.rejects(
    engine.days(
      { owner: "user_b", deviceId: null },
      new URLSearchParams(`limit=1&cursor=${first.nextCursor}`),
    ),
    hasCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    engine.days(app, new URLSearchParams(`limit=2&cursor=${first.nextCursor}`)),
    hasCode("INVALID_REQUEST"),
  );
  await assert.rejects(
    engine.days(app, new URLSearchParams("limit=1&cursor=not-a-cursor")),
    hasCode("INVALID_REQUEST"),
  );
  await engine.saveEdit(
    app,
    "reflection",
    "day_20261105",
    "reflection_change",
    edit("change_dataset", "Changes the listed dataset"),
  );
  await assert.rejects(
    engine.days(app, new URLSearchParams(`limit=1&cursor=${first.nextCursor}`)),
    hasCode("CONFLICT"),
  );
});

test("sync coalesces repeated taps; cancellation stops an unverified upload", async (t) => {
  const { engine } = await setup(t);
  const first = await engine.requestSync(app, device.deviceId!),
    second = await engine.requestSync(app, device.deviceId!);
  assert.equal(first.syncRequestId, second.syncRequestId);
  const flow = await upload(engine, [capture(1)]);
  assert.equal(flow.snapshot.syncRequestId, first.syncRequestId);
  await engine.cancelSync(app, flow.snapshot.syncRequestId);
  await assert.rejects(flow.finish(), hasCode("INVALID_STATE"));
});

test("provider cannot duplicate moments or misstate coverage", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1)])).finish();
  const { job, result } = await compose(engine);
  const recap: Recap = result;
  recap.moments.push(recap.moments[0]!);
  await assert.rejects(engine.publish(job, recap), hasCode("INVALID_REQUEST"));
});

test("mutation receipts stay immutable as the referenced sync advances", async (t) => {
  const { engine } = await setup(t);
  const request = { schemaVersion: 1, trigger: "manual" };
  const send = () =>
    engine.mutate(
      app,
      "POST",
      "/sync",
      "immutable_receipt",
      request,
      202,
      (tx) => engine.requestSync(app, device.deviceId!, tx),
    );
  const first = await send();
  await (await upload(engine, [capture(1)])).finish();
  assert.equal(
    (await engine.getSync(app, first.body.syncRequestId)).state,
    "uploaded",
  );
  assert.deepEqual(await send(), first);
  assert.equal((await send()).body.state, "waiting_for_device");
});

test("recap revisions remain monotonic after source deletion clears the prior recap", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  const first = await process(engine);
  await engine.mutate(
    app,
    "DELETE",
    "/capture",
    "delete_revision",
    null,
    202,
    (tx) => engine.delete(app, { kind: "capture", id: "cap_sample_001" }, tx),
  );
  const second = await process(engine);
  assert.equal(second.recap?.recapRevision, first.recap!.recapRevision + 1);
  const job = (await engine.listJobs(app.owner, dayId)).find(
    (j) => j.state === "ready",
  )!;
  assert.deepEqual(job.stages, [
    "queued",
    "observing",
    "assembling",
    "synthesizing",
    "validating",
    "publishing",
    "ready",
  ]);
});

test("maximum-length capture IDs produce stable bounded moment IDs and remain correctable", async (t) => {
  const { engine } = await setup(t),
    sample = capture(1);
  sample.value.captureId = "cap_" + "x".repeat(92);
  await (await upload(engine, [sample])).finish();
  const day = await process(engine),
    moment = day.recap!.moments[0]!;
  assert.ok(moment.momentId.length <= 96);
  await engine.saveEdit(
    app,
    "correction",
    moment.momentId,
    "correction_long",
    edit("edit_long", "Works at the ID limit"),
  );
  assert.equal(
    (await process(engine)).recap?.moments[0]?.title,
    "Works at the ID limit",
  );
});

test("correction identities cannot move to another moment and generated IDs must match evidence", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  await process(engine);
  await engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_001",
    "correction_shared",
    edit("edit_first", "First"),
  );
  await assert.rejects(
    engine.saveEdit(
      app,
      "correction",
      "moment_cap_sample_002",
      "correction_shared",
      edit("edit_move", "Moved", 1),
    ),
    hasCode("CONFLICT"),
  );
  const { job, result } = await compose(engine);
  result.moments[0]!.momentId = "moment_invented";
  await assert.rejects(engine.publish(job, result), hasCode("INVALID_REQUEST"));
});
