import type { DeviceRecord } from "./domain";
import { FIXED_NOW } from "./domain";
import { keys } from "./store/keys";
import type { Store } from "./store/store";
import type * as W from "./Wire";

/** Synthetic owners and devices for local adapters only. P07 replaces this with real claims. */
export const SYNTHETIC_DEVICES: ReadonlyArray<[string, string]> = [
  ["dev_sample_001", "user_a"],
  ["dev_sample_002", "user_b"],
];

export async function seedSynthetic(store: Store): Promise<void> {
  for (const [deviceId, owner] of SYNTHETIC_DEVICES) {
    if (await store.get(keys.identity(deviceId))) continue;
    const identity: W.DeviceIdentity = {
      schemaVersion: 1,
      deviceId,
      ownershipEpoch: 1,
      protocolVersion: 1,
      firmwareVersion: "simulator-1",
      claimState: "owned",
      configurationRevision: 1,
      appliedRevision: 1,
    };
    const state: W.DeviceState = {
      schemaVersion: 1,
      deviceId,
      ownershipEpoch: 1,
      captureState: "paused",
      batteryPercent: null,
      charging: null,
      queuedCaptures: null,
      queuedBytes: null,
      connectivity: "unknown",
      clockQuality: "synchronized",
      appliedRevision: 1,
      observedAt: FIXED_NOW,
    };
    const record: DeviceRecord = { owner, identity, certificateId: null };
    await store.transact([
      {
        op: "put",
        item: { ...keys.identity(deviceId), v: 1, data: record },
        condition: { absent: true },
      },
      {
        op: "put",
        item: { ...keys.deviceState(deviceId), v: 1, data: state },
        condition: { absent: true },
      },
      {
        op: "put",
        item: { ...keys.deviceRef(owner, deviceId), v: 1, data: { deviceId } },
        condition: { absent: true },
      },
    ]);
  }
}
