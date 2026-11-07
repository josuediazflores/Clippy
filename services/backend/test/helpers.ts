import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { Engine, type Actor, type EngineOptions } from "../src/domain";
import { createLocalEngine } from "../src/local-engine";
import type { LocalObjectStore } from "../src/adapters/local-store";
import type { FileStore } from "../src/store/memory";
import type { Item, Key, Store } from "../src/store/store";
import { objectKey } from "../src/store/keys";
import { sha256 } from "../src/contracts";
import type * as W from "../src/Wire";

export const app: Actor = { owner: "user_a", deviceId: null };
export const device: Actor = { owner: "user_a", deviceId: "dev_sample_001" };
export interface Harness {
  engine: Engine;
  store: FileStore;
  objects: LocalObjectStore;
  directory: string;
  restart: () => Promise<Engine>;
}
export async function setup(
  t: TestContext,
  options: Partial<EngineOptions> = {},
): Promise<Harness> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clippy-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const created = await createLocalEngine(directory, options);
  return {
    ...created,
    directory,
    restart: async () => (await createLocalEngine(directory, options)).engine,
  };
}
/** Count stored items whose sort key starts with a prefix. */
export const count = (
  store: FileStore,
  prefix: string,
  table?: Item["table"],
) => store.all(table).filter((i) => i.sk.startsWith(prefix)).length;
/** Rewrite a stored record in place to simulate an external change. */
export async function patch<T>(
  store: Store,
  key: Key,
  change: (data: T) => void,
): Promise<void> {
  const item = (await store.get(key))!;
  const data = structuredClone(item.data) as T;
  change(data);
  await store.transact([
    {
      op: "put",
      item: { ...item, v: item.v + 1, data },
      condition: { version: item.v },
    },
  ]);
}
export const keyFor = (
  snapshotId: string,
  uploadId: string,
  owner = "user_a",
) => objectKey(owner, snapshotId, uploadId);

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
export const putHeaders = (c: { value: W.Capture }) => ({
  "if-none-match": "*",
  "x-clippy-sha256": c.value.sha256,
  "content-type": c.value.contentType,
});
export async function upload(
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
  const snapshot = (
    await engine.mutate(device, "POST", "/begin", key, begin, 201, (tx) =>
      engine.begin(device, begin, tx),
    )
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
  const grants = (
    await engine.mutate(
      device,
      "POST",
      "/grants",
      key,
      input,
      200,
      (tx) => engine.grants(device, snapshot.snapshotId, input, undefined, tx),
      engine.grantCodec(device),
    )
  ).body.items;
  for (const [index, c] of captures.entries())
    if (options.omit !== c.value.captureId)
      await engine.put(device, grants[index]!.uploadId, c.bytes, putHeaders(c));
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
  const manifestGrant = (
    await engine.mutate(
      device,
      "POST",
      "/manifest",
      key,
      manifestInput,
      200,
      (tx) =>
        engine.grants(
          device,
          snapshot.snapshotId,
          manifestInput,
          undefined,
          tx,
        ),
      engine.grantCodec(device),
    )
  ).body.items[0]!;
  await engine.put(device, manifestGrant.uploadId, bytes, {
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
  const finish = async (): Promise<W.Receipt> =>
    (
      await engine.mutate(
        device,
        "POST",
        "/complete",
        key,
        complete,
        200,
        (tx) => engine.complete(device, snapshot.snapshotId, complete, tx),
      )
    ).body;
  return { snapshot, grants, manifest, complete, finish, manifestGrant };
}
