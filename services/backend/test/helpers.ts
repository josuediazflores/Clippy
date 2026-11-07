import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  Engine,
  initialState,
  type LocalState,
  type Actor,
} from "../src/domain";
import {
  LocalJournalStore,
  LocalObjectStore,
} from "../src/adapters/local-store";
import { sha256 } from "../src/contracts";
import type * as W from "../src/Wire";

export const app: Actor = { owner: "user_a", deviceId: null };
export const device: Actor = { owner: "user_a", deviceId: "dev_sample_001" };
export function setup(t: TestContext): {
  engine: Engine;
  directory: string;
  restart: () => Engine;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clippy-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const restart = (): Engine =>
    new Engine(
      new LocalJournalStore<LocalState>(
        path.join(directory, "state.json"),
        initialState,
      ),
      new LocalObjectStore(path.join(directory, "objects")),
    );
  return { engine: restart(), directory, restart };
}
export function capture(
  sequence: number,
  at?: string,
): { value: W.Capture; bytes: Buffer } {
  const bytes = fs.readFileSync(
    `fixtures/media/capture_${((sequence - 1) % 3) + 1}.png`,
  );
  return {
    bytes,
    value: {
      schemaVersion: 1,
      captureId: `cap_sample_${String(sequence).padStart(3, "0")}`,
      deviceId: "dev_sample_001",
      ownershipEpoch: 1,
      sequence,
      capturedAt:
        at ??
        `2026-11-07T${String(8 + (sequence % 12)).padStart(2, "0")}:00:00Z`,
      timeZone: "UTC",
      utcOffsetSeconds: 0,
      clockQuality: "synchronized",
      byteLength: bytes.length,
      sha256: sha256(bytes),
      contentType: "image/png",
      location: null,
    },
  };
}
export function upload(
  engine: Engine,
  captures: ReturnType<typeof capture>[],
  options: {
    key?: string;
    trigger?: "manual" | "nightly";
    omit?: string;
    manifestChange?: (manifest: W.Manifest) => void;
  } = {},
) {
  const key = options.key ?? `test_${captures[0]!.value.sequence}`;
  const entries = captures.map((c) => c.value);
  const begin: W.BeginSync = {
    schemaVersion: 1,
    deviceId: device.deviceId!,
    ownershipEpoch: 1,
    syncRequestId: null,
    trigger: options.trigger ?? "manual",
    startedAt: "2026-11-07T20:00:00Z",
    cutoffAt: "2026-11-07T20:00:00Z",
    sequenceStart: Math.min(...entries.map((c) => c.sequence)),
    sequenceEnd: Math.max(...entries.map((c) => c.sequence)),
    captureCount: entries.length,
    configurationRevision: 1,
  };
  const snapshot = engine.mutate(
    device,
    "POST",
    "/begin",
    key,
    begin,
    201,
    () => engine.begin(device, begin),
  ).body;
  const input: W.GrantRequest = {
    schemaVersion: 1,
    deviceId: device.deviceId!,
    ownershipEpoch: 1,
    items: entries.map((c) => ({
      kind: "capture",
      captureId: c.captureId,
      byteLength: c.byteLength,
      sha256: c.sha256,
      contentType: c.contentType,
    })),
  };
  const grants = engine.mutate(device, "POST", "/grants", key, input, 200, () =>
    engine.grants(device, snapshot.snapshotId, input, "http://127.0.0.1:8787"),
  ).body.items;
  for (const [index, c] of captures.entries())
    if (options.omit !== c.value.captureId) {
      const g = grants[index]!;
      engine.put(device, g.uploadId, c.bytes, {
        "if-none-match": "*",
        "x-clippy-sha256": c.value.sha256,
        "content-type": c.value.contentType,
      });
    }
  const manifest: W.Manifest = {
    ...snapshot,
    trigger: begin.trigger,
    startedAt: begin.startedAt,
    cutoffAt: begin.cutoffAt,
    sequenceStart: begin.sequenceStart,
    sequenceEnd: begin.sequenceEnd,
    captureCount: entries.length,
    captures: entries.map((c, i) => ({ ...c, uploadId: grants[i]!.uploadId })),
    gaps: [],
  };
  options.manifestChange?.(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestInput: W.GrantRequest = {
    schemaVersion: 1,
    deviceId: device.deviceId!,
    ownershipEpoch: 1,
    items: [
      {
        kind: "manifest",
        captureId: null,
        byteLength: bytes.length,
        sha256: sha256(bytes),
        contentType: "application/json",
      },
    ],
  };
  const manifestGrant = engine.mutate(
    device,
    "POST",
    "/manifest",
    key,
    manifestInput,
    200,
    () =>
      engine.grants(
        device,
        snapshot.snapshotId,
        manifestInput,
        "http://127.0.0.1:8787",
      ),
  ).body.items[0]!;
  engine.put(device, manifestGrant.uploadId, bytes, {
    "if-none-match": "*",
    "x-clippy-sha256": sha256(bytes),
    "content-type": "application/json",
  });
  const complete: W.CompleteSync = {
    schemaVersion: 1,
    deviceId: device.deviceId!,
    ownershipEpoch: 1,
    manifestUploadId: manifestGrant.uploadId,
    manifestSHA256: sha256(bytes),
  };
  const finish = (): W.Receipt =>
    engine.mutate(device, "POST", "/complete", key, complete, 200, () =>
      engine.complete(device, snapshot.snapshotId, complete),
    ).body;
  return { snapshot, grants, manifest, complete, finish, manifestGrant };
}
