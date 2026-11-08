import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { Fault, type DeviceRecord } from "../src/domain";
import {
  createDeviceHandler,
  type DeviceResponse,
  type DeviceRuleEvent,
} from "../src/lambda/device";
import { keys } from "../src/store/keys";
import type { Store } from "../src/store/store";
import type * as W from "../src/Wire";
import { setup } from "./helpers";

const DEVICE = "dev_clippy_009";
const SECRET = "clm_" + "a1".repeat(16);
const userA = { owner: "user_a", deviceId: null };
const userB = { owner: "user_b", deviceId: null };

/** What tools/provision-device writes: unclaimed, certificate bound, only the secret's hash stored. */
async function provision(store: Store): Promise<void> {
  const record: DeviceRecord = {
    owner: "",
    identity: {
      schemaVersion: 1,
      deviceId: DEVICE,
      ownershipEpoch: 1,
      protocolVersion: 1,
      firmwareVersion: "pi-agent-1",
      claimState: "unclaimed",
      configurationRevision: 1,
      appliedRevision: 1,
    },
    certificateId: "cert-9",
    claimSecretHash: crypto.createHash("sha256").update(SECRET).digest("hex"),
  };
  await store.transact([
    {
      op: "put",
      item: { ...keys.identity(DEVICE), v: 1, data: record },
      condition: { absent: true },
    },
  ]);
}

const claim = (challengeId: string): W.ClaimInput => ({
  schemaVersion: 1,
  deviceId: DEVICE,
  challengeId,
});
const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    assert.ok(error instanceof Fault, String(error));
    return error.code;
  }
};

test("printed QR claim binds the first owner once and reveals nothing for wrong secrets", async (t) => {
  const { engine, store } = await setup(t);
  await provision(store);

  assert.equal(
    await code(engine.claimDevice(userA, claim("clm_" + "b2".repeat(16)))),
    "NOT_FOUND",
  );
  assert.equal(
    await code(
      engine.claimDevice(userA, {
        ...claim(SECRET),
        deviceId: "dev_unknown_1",
      }),
    ),
    "NOT_FOUND",
  );

  const first = await engine.claimDevice(userA, claim(SECRET));
  assert.equal(first.state, "confirmed");
  assert.equal(first.deviceId, DEVICE);

  // Same owner re-scanning is idempotent; anyone else is told it is taken.
  assert.equal(
    (await engine.claimDevice(userA, claim(SECRET))).state,
    "confirmed",
  );
  assert.equal(
    await code(engine.claimDevice(userB, claim(SECRET))),
    "CONFLICT",
  );

  const stored = (await store.get(keys.identity(DEVICE)))?.data as DeviceRecord;
  assert.equal(stored.owner, "user_a");
  assert.equal(stored.identity.claimState, "owned");
  assert.equal(stored.claimSecretHash, null, "the secret is single-use");
  assert.equal(
    stored.certificateId,
    "cert-9",
    "the provisioned certificate stays bound",
  );

  const listed = await engine.devices(userA, new URLSearchParams());
  assert.ok(
    listed.items.some((d) => d.deviceId === DEVICE && d.claimState === "owned"),
  );
  assert.equal(await code(engine.device(userB, DEVICE)), "NOT_FOUND");
});

test("an unclaimed device is refused until claimed, then can read its own status", async (t) => {
  const { engine, store } = await setup(t);
  await provision(store);
  const published: DeviceResponse[] = [];
  const handler = createDeviceHandler(engine, {
    publish: async (_topic, payload) => void published.push(payload),
  });
  const status = async (requestId: string, principal = "cert-9") => {
    await handler({
      thingName: DEVICE,
      clientId: DEVICE,
      principal,
      schemaVersion: 1,
      requestId,
      type: "device.status",
    } as DeviceRuleEvent);
    return published.at(-1)!;
  };

  assert.equal(
    (await status("req_status_1")).status,
    403,
    "unpaired devices get no data",
  );
  await engine.claimDevice(userA, claim(SECRET));

  const owned = await status("req_status_2");
  assert.equal(owned.status, 200);
  const detail = owned.body as W.DeviceDetail;
  assert.equal(detail.identity.claimState, "owned");
  assert.equal(detail.identity.ownershipEpoch, 1);
  assert.equal(detail.activeSync, null);

  // A different certificate for the same thing name is still refused.
  assert.equal((await status("req_status_3", "cert-other")).status, 403);

  // The app's Sync now becomes visible to the device through the same poll.
  const requested = await engine.mutate(
    userA,
    "POST",
    `/v1/devices/${DEVICE}/sync-requests`,
    "op_sync_1",
    { schemaVersion: 1, trigger: "manual" },
    202,
    (tx) => engine.requestSync(userA, DEVICE, tx),
  );
  assert.equal((requested.body as W.SyncRequest).state, "waiting_for_device");
  const pending = (await status("req_status_4")).body as W.DeviceDetail;
  assert.equal(
    pending.activeSync?.syncRequestId,
    (requested.body as W.SyncRequest).syncRequestId,
  );
});
