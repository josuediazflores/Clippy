import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setup, upload, capture, app, device } from "./helpers";
import { Fault } from "../src/domain";
import { validate, sha256 } from "../src/contracts";
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
const process = (engine: ReturnType<typeof setup>["engine"]) =>
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

test("two snapshots preserve edits, deduplicate captures/moments, and reuse observations", (t) => {
  const { engine } = setup(t);
  const first = upload(engine, [capture(1), capture(2)]);
  const receipt = first.finish();
  assert.deepEqual(first.finish(), receipt);
  assert.equal(engine.getDay(app, dayId).inputRevision, 1);
  const ready = process(engine);
  validate("Day", ready);
  assert.equal(ready.recap?.moments.length, 2);
  const r = edit("edit_reflection", "A day worth remembering.");
  engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, () =>
    engine.saveEdit(app, "reflection", dayId, "reflection_main", r),
  );
  const c = edit("edit_correction", "A quiet break.");
  engine.mutate(app, "PUT", "/correction", c.operationId, c, 200, () =>
    engine.saveEdit(
      app,
      "correction",
      "moment_cap_sample_001",
      "correction_main",
      c,
    ),
  );
  upload(engine, [capture(2), capture(3)], {
    trigger: "nightly",
    key: "second",
  }).finish();
  const updated = process(engine);
  assert.equal(updated.recap?.moments.length, 3);
  assert.equal(new Set(updated.recap?.moments.map((m) => m.momentId)).size, 3);
  assert.equal(updated.reflections[0]?.text, r.text);
  assert.equal(updated.reflections[0]?.revision, 1);
  assert.equal(updated.corrections[0]?.text, c.text);
  assert.equal(updated.recap?.moments[0]?.title, c.text);
  assert.equal(Object.keys(engine.state.observations).length, 3);
  const prior = JSON.stringify(updated);
  process(engine);
  assert.equal(JSON.stringify(engine.getDay(app, dayId)), prior);
});

test("idempotency conflict and stale edit revision cannot overwrite user text", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1)]).finish();
  process(engine);
  const r = edit("edit_once", "Original");
  const save = () =>
    engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, () =>
      engine.saveEdit(app, "reflection", dayId, "reflection_main", r),
    );
  assert.deepEqual(save(), save());
  assert.throws(
    () =>
      engine.mutate(
        app,
        "PUT",
        "/reflection",
        r.operationId,
        { ...r, text: "Changed" },
        200,
        () => null,
      ),
    hasCode("CONFLICT"),
  );
  assert.throws(
    () =>
      engine.saveEdit(
        app,
        "reflection",
        dayId,
        "reflection_main",
        edit("edit_stale", "Lost update"),
      ),
    hasCode("REVISION_CONFLICT"),
  );
  assert.equal(engine.getDay(app, dayId).reflections[0]?.text, "Original");
});

test("missing upload survives persisted server restart and resumes without early acknowledgement", (t) => {
  const { engine, restart } = setup(t);
  const flow = upload(engine, [capture(1), capture(2)], {
    omit: "cap_sample_002",
  });
  assert.throws(flow.finish, hasCode("MISSING_OBJECTS"));
  assert.equal(engine.getDay(app, dayId).state, "empty");
  const resumed = restart(),
    c = capture(2),
    g = flow.grants[1]!;
  resumed.put(device, g.uploadId, c.bytes, {
    "if-none-match": "*",
    "x-clippy-sha256": c.value.sha256,
    "content-type": c.value.contentType,
  });
  const receipt = resumed.mutate(
    device,
    "POST",
    "/complete",
    "resume",
    flow.complete,
    200,
    () => resumed.complete(device, flow.snapshot.snapshotId, flow.complete),
  ).body;
  assert.equal(receipt.acceptedCaptureIds.length, 2);
  assert.equal(restart().getDay(app, dayId).state, "pending");
});

test("conditional PUT, wrong size/hash and corrupted stored object are rejected", (t) => {
  const { engine } = setup(t),
    c = capture(1);
  const flow = upload(engine, [c], { omit: c.value.captureId });
  const g = flow.grants[0]!;
  const headers = {
    "if-none-match": "*",
    "x-clippy-sha256": c.value.sha256,
    "content-type": c.value.contentType,
  };
  assert.throws(
    () => engine.put(device, g.uploadId, c.bytes.subarray(1), headers),
    hasCode("SIZE_MISMATCH"),
  );
  const bad = Buffer.from(c.bytes);
  bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
  assert.throws(
    () => engine.put(device, g.uploadId, bad, headers),
    hasCode("CHECKSUM_MISMATCH"),
  );
  engine.put(device, g.uploadId, c.bytes, headers);
  assert.throws(
    () => engine.put(device, g.uploadId, c.bytes, headers),
    hasCode("PRECONDITION_FAILED"),
  );
  engine.objects.remove(g.uploadId);
  engine.objects.put(g.uploadId, bad);
  assert.throws(flow.finish, hasCode("CHECKSUM_MISMATCH"));
  assert.equal(engine.getDay(app, dayId).state, "empty");
});

test("malformed manifest never partially admits an otherwise valid capture", (t) => {
  const { engine } = setup(t);
  const flow = upload(engine, [capture(1), capture(2)], {
    manifestChange: (m) => {
      m.captures[1]!.captureId = m.captures[0]!.captureId;
    },
  });
  assert.throws(flow.finish, hasCode("INVALID_MANIFEST"));
  assert.equal(Object.keys(engine.state.captures).length, 0);
});

test("changed immutable metadata on a later snapshot is a conflict", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1)]).finish();
  const altered = capture(1, "2026-11-07T08:59:00Z");
  const flow = upload(engine, [altered], { key: "changed" });
  assert.throws(flow.finish, hasCode("CONFLICT"));
  assert.equal(engine.getDay(app, dayId).inputRevision, 1);
});

test("device scope, stale epoch and revocation protect completion", (t) => {
  const { engine } = setup(t);
  const flow = upload(engine, [capture(1)]);
  assert.throws(
    () =>
      engine.complete(
        { owner: "user_b", deviceId: "dev_sample_002" },
        flow.snapshot.snapshotId,
        flow.complete,
      ),
    hasCode("NOT_FOUND"),
  );
  assert.throws(
    () =>
      engine.complete(
        { ...device, deviceId: "dev_unknown" },
        flow.snapshot.snapshotId,
        flow.complete,
      ),
    hasCode("FORBIDDEN"),
  );
  engine.state.devices[device.deviceId!]!.identity.ownershipEpoch = 2;
  assert.throws(flow.finish, hasCode("STALE_EPOCH"));
  engine.state.devices[device.deviceId!]!.identity.ownershipEpoch = 1;
  engine.state.devices[device.deviceId!]!.identity.claimState = "revoked";
  assert.throws(flow.finish, hasCode("NOT_FOUND"));
});

test("stale recap publication and invented source evidence are rejected", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1)]).finish();
  const old = engine.prepareJob(app.owner, dayId);
  const result = new MockRecapProvider().compose(
    old.day,
    old.captures.map((c) => new MockObservationProvider().observe(c)),
    old.captures,
  );
  upload(engine, [capture(2)], { key: "new_snapshot" }).finish();
  assert.throws(() => engine.publish(old, result), hasCode("SUPERSEDED"));
  const job = engine.prepareJob(app.owner, dayId),
    provider = new MockRecapProvider();
  const forged = provider.compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  forged.moments[0]!.evidence[0]!.id = "cap_invented";
  assert.throws(() => engine.publish(job, forged), hasCode("INVALID_REQUEST"));
  const ready = process(engine);
  assert.equal(ready.recap?.moments.length, 2);
});

test("partial and failure states remain meaningful and failure permits finite retry", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1), capture(2)]).finish();
  assert.throws(
    () =>
      engine.process(
        app.owner,
        dayId,
        new MockObservationProvider(),
        new MockRecapProvider(),
        true,
      ),
    hasCode("INTERNAL_ERROR"),
  );
  assert.equal(engine.getDay(app, dayId).state, "failure");
  const partial = engine.process(
    app.owner,
    dayId,
    new MockObservationProvider(new Set(["cap_sample_002"])),
    new MockRecapProvider(),
  );
  assert.equal(partial.state, "partial");
  assert.equal(partial.recap?.coverage.missing, 1);
  assert.equal(partial.recap?.coverage.observed, 1);
});

test("capture deletion removes derived data, preserves unrelated bytes/edits and blocks in-flight publication", (t) => {
  const { engine, restart } = setup(t);
  const flow = upload(engine, [capture(1), capture(2)]);
  flow.finish();
  process(engine);
  engine.saveEdit(
    app,
    "reflection",
    dayId,
    "reflection_main",
    edit("reflect", "Keep this"),
  );
  engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_002",
    "correction_other",
    edit("correct_other", "Still here"),
  );
  const job = engine.prepareJob(app.owner, dayId),
    result = new MockRecapProvider().compose(
      job.day,
      job.captures.map((c) => new MockObservationProvider().observe(c)),
      job.captures,
    );
  const deletion = engine.mutate(
    app,
    "DELETE",
    "/capture",
    "delete_one",
    null,
    202,
    () => engine.delete(app, "cap_sample_001"),
  ).body;
  assert.equal(deletion.state, "waiting_for_clients");
  assert.equal(deletion.cloudComplete, true);
  assert.equal(engine.objects.get(flow.grants[0]!.uploadId), undefined);
  assert.ok(engine.objects.get(flow.grants[1]!.uploadId));
  assert.equal(engine.objects.get(flow.manifestGrant.uploadId), undefined);
  assert.equal(engine.getDay(app, dayId).recap, null);
  assert.throws(() => engine.publish(job, result), hasCode("SUPERSEDED"));
  assert.throws(
    () => engine.complete(device, flow.snapshot.snapshotId, flow.complete),
    hasCode("DELETED"),
  );
  const updated = process(restart());
  assert.equal(updated.recap?.moments.length, 1);
  assert.equal(updated.reflections[0]?.text, "Keep this");
  assert.equal(updated.corrections[0]?.text, "Still here");
  const stateText = JSON.stringify(engine.state);
  assert.ok(!stateText.includes("Original sensitive marker"));
});

test("deleted capture is suppressed in a later manifest and cannot resurrect", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1)]).finish();
  engine.mutate(app, "DELETE", "/capture", "delete_capture", null, 202, () =>
    engine.delete(app, "cap_sample_001"),
  );
  const replay = upload(engine, [capture(1)], {
    key: "later",
    omit: "cap_sample_001",
  });
  const receipt = replay.finish();
  assert.deepEqual(receipt.acceptedCaptureIds, []);
  assert.deepEqual(receipt.suppressedCaptureIds, ["cap_sample_001"]);
  assert.equal(receipt.effectiveDigest, sha256(""));
  assert.equal(Object.keys(engine.state.captures).length, 0);
});

test("day and account deletion remove text, media, jobs and receipts across restart", (t) => {
  const { engine, restart, directory } = setup(t);
  upload(engine, [capture(1)]).finish();
  process(engine);
  const r = edit("private_edit", "Synthetic text marker to remove");
  engine.mutate(app, "PUT", "/reflection", r.operationId, r, 200, () =>
    engine.saveEdit(app, "reflection", dayId, "reflection_main", r),
  );
  engine.mutate(app, "DELETE", "/day", "delete_day", null, 202, () =>
    engine.delete(app, dayId),
  );
  assert.throws(() => restart().getDay(app, dayId), hasCode("DELETED"));
  assert.ok(
    !fs.readFileSync(directory + "/state.json", "utf8").includes(r.text),
  );
  assert.equal(Object.keys(engine.state.jobs).length, 0);
  const receipt = engine.mutate(
    app,
    "DELETE",
    "/me",
    "delete_account",
    null,
    202,
    () => engine.delete(app, "account"),
  ).body;
  assert.throws(
    () => restart().devices(app, new URLSearchParams()),
    hasCode("DELETED"),
  );
  assert.equal(engine.deletion(app, receipt.jobId).targetId, "account");
});

test("backlog is grouped by capture date; untrusted clock is quarantined", (t) => {
  const { engine } = setup(t);
  const a = capture(1, "2026-11-05T23:59:59Z"),
    b = capture(2, "2026-11-06T00:00:00Z"),
    c = capture(3, "2000-01-01T00:00:00Z");
  c.value.clockQuality = "untrusted";
  const receipt = upload(engine, [a, b, c]).finish();
  assert.deepEqual(receipt.dayIds, ["day_20261105", "day_20261106"]);
  assert.equal(engine.getDay(app, "day_20000101").state, "empty");
  assert.equal(engine.getDay(app, dayId).state, "empty");
});

test("opaque pagination binds owner, filters and result revision", (t) => {
  const { engine } = setup(t);
  upload(engine, [
    capture(1, "2026-11-05T12:00:00Z"),
    capture(2, "2026-11-06T12:00:00Z"),
  ]).finish();
  const first = engine.days(app, new URLSearchParams("limit=1"));
  assert.ok(first.nextCursor);
  assert.equal(
    engine.days(app, new URLSearchParams(`limit=1&cursor=${first.nextCursor}`))
      .items.length,
    1,
  );
  assert.throws(
    () =>
      engine.days(
        { owner: "user_b", deviceId: null },
        new URLSearchParams(`limit=1&cursor=${first.nextCursor}`),
      ),
    hasCode("INVALID_REQUEST"),
  );
  assert.throws(
    () =>
      engine.days(
        app,
        new URLSearchParams(`limit=2&cursor=${first.nextCursor}`),
      ),
    hasCode("INVALID_REQUEST"),
  );
  engine.state.days["user_a/day_20261105"]!.inputRevision++;
  assert.throws(
    () =>
      engine.days(
        app,
        new URLSearchParams(`limit=1&cursor=${first.nextCursor}`),
      ),
    hasCode("CONFLICT"),
  );
});

test("sync coalesces repeated taps; cancellation stops an unverified upload", (t) => {
  const { engine } = setup(t);
  const first = engine.requestSync(app, device.deviceId!),
    second = engine.requestSync(app, device.deviceId!);
  assert.equal(first.syncRequestId, second.syncRequestId);
  const flow = upload(engine, [capture(1)]);
  engine.cancelSync(app, flow.snapshot.syncRequestId);
  assert.throws(flow.finish, hasCode("INVALID_STATE"));
});

test("provider cannot duplicate moments or misstate coverage", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1)]).finish();
  const job = engine.prepareJob(app.owner, dayId);
  const result: Recap = new MockRecapProvider().compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  result.moments.push(result.moments[0]!);
  assert.throws(() => engine.publish(job, result), hasCode("INVALID_REQUEST"));
});

test("mutation receipts stay immutable as the referenced sync advances", (t) => {
  const { engine } = setup(t);
  const request = { schemaVersion: 1, trigger: "manual" };
  const send = () =>
    engine.mutate(app, "POST", "/sync", "immutable_receipt", request, 202, () =>
      engine.requestSync(app, device.deviceId!),
    );
  const first = send();
  upload(engine, [capture(1)]).finish();
  assert.equal(engine.getSync(app, first.body.syncRequestId).state, "uploaded");
  assert.deepEqual(send(), first);
  assert.equal(send().body.state, "waiting_for_device");
});

test("recap revisions remain monotonic after source deletion clears the prior recap", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1), capture(2)]).finish();
  const first = process(engine);
  engine.mutate(app, "DELETE", "/capture", "delete_revision", null, 202, () =>
    engine.delete(app, "cap_sample_001"),
  );
  const second = process(engine);
  assert.equal(second.recap?.recapRevision, first.recap!.recapRevision + 1);
  const job = Object.values(engine.state.jobs).find(
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

test("maximum-length capture IDs produce stable bounded moment IDs and remain correctable", (t) => {
  const { engine } = setup(t),
    sample = capture(1);
  sample.value.captureId = "cap_" + "x".repeat(92);
  upload(engine, [sample]).finish();
  const day = process(engine),
    moment = day.recap!.moments[0]!;
  assert.ok(moment.momentId.length <= 96);
  engine.saveEdit(
    app,
    "correction",
    moment.momentId,
    "correction_long",
    edit("edit_long", "Works at the ID limit"),
  );
  assert.equal(
    process(engine).recap?.moments[0]?.title,
    "Works at the ID limit",
  );
});

test("correction identities cannot move to another moment and generated IDs must match evidence", (t) => {
  const { engine } = setup(t);
  upload(engine, [capture(1), capture(2)]).finish();
  process(engine);
  engine.saveEdit(
    app,
    "correction",
    "moment_cap_sample_001",
    "correction_shared",
    edit("edit_first", "First"),
  );
  assert.throws(
    () =>
      engine.saveEdit(
        app,
        "correction",
        "moment_cap_sample_002",
        "correction_shared",
        edit("edit_move", "Moved", 1),
      ),
    hasCode("CONFLICT"),
  );
  const job = engine.prepareJob(app.owner, dayId);
  const result = new MockRecapProvider().compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  result.moments[0]!.momentId = "moment_invented";
  assert.throws(() => engine.publish(job, result), hasCode("INVALID_REQUEST"));
});
