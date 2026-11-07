import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeConformance } from "./store-conformance";
import { createLocalTables, dynamoLocalClient } from "./dynamo-local";
import { capture, upload, app, device } from "./helpers";
import { Engine, Fault } from "../src/domain";
import {
  LocalGrantSigner,
  LocalObjectStore,
} from "../src/adapters/local-store";
import { seedSynthetic } from "../src/seed";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";

const client = dynamoLocalClient();
const dayId = "day_20261107";

if (!client) {
  test(
    "DynamoDB Local suite",
    { skip: "set CLIPPY_DYNAMODB_ENDPOINT (npm run test:dynamodb)" },
    () => {},
  );
} else {
  const dropped: Array<() => Promise<void>> = [];
  test.after(async () => {
    for (const drop of dropped) await drop();
  });
  storeConformance("dynamodb-local", async () => {
    const created = await createLocalTables(client);
    dropped.push(created.drop);
    return created.store;
  });

  const engineOn = async (
    t: import("node:test").TestContext,
    dispatch: "inline" | "deferred",
  ) => {
    const created = await createLocalTables(client);
    dropped.push(created.drop);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clippy-ddb-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    await seedSynthetic(created.store);
    return new Engine({
      store: created.store,
      objects: new LocalObjectStore(directory),
      signer: new LocalGrantSigner(),
      dispatch,
    });
  };

  test("dynamodb-local: capture-to-recap flow with edits, second snapshot and deletion", async (t) => {
    const engine = await engineOn(t, "inline");
    const first = await upload(engine, [capture(1), capture(2)]);
    const receipt = await first.finish();
    assert.deepEqual(await first.finish(), receipt);
    assert.equal((await engine.getDay(app, dayId)).state, "pending");
    const ready = await engine.process(
      app.owner,
      dayId,
      new MockObservationProvider(),
      new MockRecapProvider(),
    );
    assert.equal(ready.recap?.moments.length, 2);
    await engine.saveEdit(app, "reflection", dayId, "reflection_main", {
      schemaVersion: 1,
      operationId: "r1",
      expectedRevision: 0,
      text: "Kept",
      deleted: false,
    });
    await (
      await upload(engine, [capture(2), capture(3)], {
        key: "second",
        trigger: "nightly",
      })
    ).finish();
    const updated = await engine.process(
      app.owner,
      dayId,
      new MockObservationProvider(),
      new MockRecapProvider(),
    );
    assert.equal(updated.recap?.moments.length, 3);
    assert.equal(updated.reflections[0]?.text, "Kept");
    const page = await engine.days(app, new URLSearchParams("limit=1"));
    assert.equal(page.items[0]?.dayId, dayId);
    const deletion = await engine.delete(app, {
      kind: "capture",
      id: "cap_sample_001",
    });
    assert.equal(
      (await engine.deletion(app, deletion.jobId)).state,
      "waiting_for_clients",
    );
    const after = await engine.process(
      app.owner,
      dayId,
      new MockObservationProvider(),
      new MockRecapProvider(),
    );
    assert.equal(after.recap?.moments.length, 2);
    await assert.rejects(
      engine.getDay({ owner: "user_b", deviceId: null }, dayId).then((d) => {
        if (d.recap) throw new Error("cross-owner leak");
        throw new Fault(404, "NOT_FOUND");
      }),
      (e: unknown) => e instanceof Fault,
    );
    void device;
  });

  test("dynamodb-local: deferred acceptance and recovery survive a lost dispatch", async (t) => {
    const engine = await engineOn(t, "deferred");
    await (await upload(engine, [capture(1)])).finish();
    assert.equal((await engine.getDay(app, dayId)).state, "empty");
    const result = await engine.recover();
    assert.equal(result.dispatched, 1);
    assert.equal((await engine.getDay(app, dayId)).state, "pending");
  });

  test("dynamodb-local: concurrent edits resolve to exactly one revision", async (t) => {
    const engine = await engineOn(t, "inline");
    await (await upload(engine, [capture(1)])).finish();
    const edit = (op: string) => ({
      schemaVersion: 1 as const,
      operationId: op,
      expectedRevision: 0,
      text: op,
      deleted: false,
    });
    const results = await Promise.allSettled(
      ["a", "b", "c", "d"].map((op) =>
        engine.saveEdit(
          app,
          "reflection",
          dayId,
          "reflection_main",
          edit("edit_" + op),
        ),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await engine.getDay(app, dayId)).reflections[0]?.revision, 1);
  });
}
