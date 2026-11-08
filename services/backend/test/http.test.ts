import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLocalServer } from "../src/http";
import { setup, upload, capture, app, device, count, patch } from "./helpers";
import { keys } from "../src/store/keys";
import { validate } from "../src/contracts";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";

async function serve(engine: Awaited<ReturnType<typeof setup>>["engine"]) {
  const server = createLocalServer(engine);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No TCP address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function runPython(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "python", "-m", "clippy_device.sync", ...args],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONPATH: path.resolve("device") },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(Error(stderr)),
    );
  });
}

test("HTTP denies missing/unknown credentials and cross-user access in every local resource family", async (t) => {
  const { engine } = await setup(t);
  const flow = await upload(engine, [capture(1)]);
  await flow.finish();
  await engine.process(
    app.owner,
    "day_20261107",
    new MockObservationProvider(),
    new MockRecapProvider(),
  );
  const { server, url } = await serve(engine);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const denied = await fetch(url + "/v1/devices");
  assert.equal(denied.status, 401);
  validate("Error", await denied.json());
  assert.equal(
    (
      await fetch(url + "/v1/devices", {
        headers: { Authorization: "Bearer invented-device" },
      })
    ).status,
    401,
  );
  const cases: Array<[string, string, unknown?]> = [
    ["GET", "/v1/devices/dev_sample_001"],
    ["GET", "/v1/sync-requests/" + flow.snapshot.syncRequestId],
    [
      "POST",
      "/v1/devices/dev_sample_001/sync-requests",
      { schemaVersion: 1, trigger: "manual" },
    ],
    [
      "PUT",
      "/v1/days/day_20261107/reflections/reflection_other",
      {
        schemaVersion: 1,
        operationId: "cross_owner",
        expectedRevision: 0,
        text: "No",
        deleted: false,
      },
    ],
    [
      "PUT",
      "/v1/moments/moment_cap_sample_001/corrections/correction_other",
      {
        schemaVersion: 1,
        operationId: "cross_owner",
        expectedRevision: 0,
        text: "No",
        deleted: false,
      },
    ],
    ["DELETE", "/v1/captures/cap_sample_001"],
    ["DELETE", "/v1/days/day_20261107"],
    ["POST", "/v1/captures/cap_sample_001/read-url"],
  ];
  for (const [method, route, payload] of cases) {
    const response = await fetch(url + route, {
      method,
      headers: {
        Authorization: "Bearer local-user-b",
        "Content-Type": "application/json",
        "Idempotency-Key": "cross_owner",
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    assert.equal(response.status, 404, route);
    validate("Error", await response.json());
  }
  const other = (await (
    await fetch(url + "/v1/days/day_20261107", {
      headers: { Authorization: "Bearer local-user-b" },
    })
  ).json()) as { state: string; recap: unknown };
  assert.equal(other.state, "empty");
  assert.equal(other.recap, null);
  for (const route of [
    `/v1/device/snapshots/${flow.snapshot.snapshotId}/complete`,
    `/v1/device/snapshots/${flow.snapshot.snapshotId}/grants`,
  ]) {
    const response = await fetch(url + route, {
      method: "POST",
      headers: {
        Authorization: "Bearer local-device-b",
        "Content-Type": "application/json",
        "Idempotency-Key": "cross_device",
      },
      body: JSON.stringify(flow.complete),
    });
    assert.equal(response.status, 404);
  }
  const bytes = capture(1).bytes;
  assert.equal(
    (
      await fetch(url + "/local/uploads/" + flow.grants[0]!.uploadId, {
        method: "PUT",
        headers: { Authorization: "Bearer local-device-b" },
        body: new Uint8Array(bytes),
      })
    ).status,
    404,
  );
  const deletion = (
    await engine.mutate(
      app,
      "DELETE",
      "/capture",
      "delete_http",
      null,
      202,
      (tx) => engine.delete(app, { kind: "capture", id: "cap_sample_001" }, tx),
    )
  ).body;
  assert.equal(
    (
      await fetch(url + "/v1/deletion-jobs/" + deletion.jobId, {
        headers: { Authorization: "Bearer local-user-b" },
      })
    ).status,
    404,
  );
  const version = await fetch(
    url + "/v1/devices/dev_sample_002/sync-requests",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer local-user-b",
        "Content-Type": "application/json",
        "Idempotency-Key": "version_test",
      },
      body: JSON.stringify({ schemaVersion: 2, trigger: "manual" }),
    },
  );
  assert.equal(version.status, 400);
});

test("Python processes restart at four upload checkpoints and receive exactly one durable snapshot", async (t) => {
  const stops = [
    "put-before-checkpoint",
    "first-upload",
    "manifest",
    "receipt-before-checkpoint",
  ];
  for (const [index, stop] of stops.entries()) {
    const h = await setup(t);
    const { engine, directory, restart } = h;
    let hosted = await serve(engine);
    t.after(() => {
      hosted.server.closeAllConnections();
      hosted.server.close();
    });
    const args = [
      "--url",
      hosted.url,
      "--queue",
      path.join(directory, "queue"),
      "--start",
      String(index * 2 + 1),
      "--count",
      "2",
    ];
    await runPython([...args, "--stop-after", stop]);
    const pending = JSON.parse(
      fs.readFileSync(path.join(directory, "queue/checkpoint.json"), "utf8"),
    ) as { acknowledged: boolean };
    assert.equal(pending.acknowledged, false);
    await new Promise<void>((resolve) => hosted.server.close(() => resolve()));
    const resumed = await restart();
    hosted = await serve(resumed);
    args[1] = hosted.url;
    try {
      await runPython(args);
      await runPython(args);
      const checkpoint = JSON.parse(
        fs.readFileSync(path.join(directory, "queue/checkpoint.json"), "utf8"),
      ) as { acknowledged: boolean };
      assert.equal(checkpoint.acknowledged, true);
      assert.equal(await count(h, "CAP#"), 2);
      assert.equal(
        (await h.all("operations")).filter(
          (i) => i.sk === "SNAP" && (i.data as { receipt: unknown }).receipt,
        ).length,
        1,
      );
      assert.equal(
        (await resumed.getDay(app, "day_20261107")).inputRevision,
        1,
      );
      assert.equal(
        fs
          .readdirSync(path.join(directory, "queue"))
          .filter((f) => f.endsWith(".png")).length,
        2,
        "unacknowledged/local photos are retained",
      );
    } finally {
      await new Promise<void>((resolve) =>
        hosted.server.close(() => resolve()),
      );
    }
  }
});

test("expired grants renew the same upload identity without trusting an existing-object 412", async (t) => {
  const { engine, store } = await setup(t);
  const flow = await upload(engine, [capture(1)], { omit: "cap_sample_001" }),
    g = flow.grants[0]!;
  await patch<{ expiresAt: string }>(store, keys.grant(g.uploadId), (grant) => {
    grant.expiresAt = "2026-11-07T19:00:00Z";
  });
  await assert.rejects(
    engine.put(device, g.uploadId, capture(1).bytes, {
      "if-none-match": "*",
      "x-clippy-sha256": capture(1).value.sha256,
      "content-type": "image/png",
    }),
    /EXPIRED/,
  );
  const item = (
    (await store.get(keys.grant(g.uploadId)))!.data as {
      item: import("../src/Wire").GrantItem;
    }
  ).item;
  const renewed = await engine.grants(
    device,
    flow.snapshot.snapshotId,
    {
      schemaVersion: 1,
      deviceId: device.deviceId!,
      ownershipEpoch: 1,
      items: [item],
    },
    "http://127.0.0.1:8787",
  );
  assert.equal(renewed.items[0]!.uploadId, g.uploadId);
  assert.ok(renewed.items[0]!.expiresAt > "2026-11-07T19:00:00Z");
  await engine.put(device, g.uploadId, capture(1).bytes, {
    "if-none-match": "*",
    "x-clippy-sha256": capture(1).value.sha256,
    "content-type": "image/png",
  });
});
