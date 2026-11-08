import crypto from "node:crypto";
import { momentID } from "./identity";
import type * as W from "./Wire";
import type {
  GrantSigner,
  JobStarter,
  Notifier,
  ObjectStore,
  ObservationProvider,
  RecapProvider,
  WritableObjectStore,
} from "./ports";
import { canonical, decode, digest, sha256, validate } from "./contracts";
import { keys, objectKey, ownerObjectPrefix } from "./store/keys";
import { queryAll, type Key, type Store } from "./store/store";
import { Tx, withRetries } from "./store/tx";

export class Fault extends Error {
  constructor(
    public readonly status: number,
    public readonly code: W.APIError["error"]["code"],
    public readonly retryable = false,
    public readonly currentRevision?: number,
    public readonly itemIds?: string[],
  ) {
    super(code);
  }
}
export interface Actor {
  readonly owner: string;
  readonly deviceId: string | null;
}

// Stored records. None of these is a wire type; wire values are nested inside them.
export interface DeviceRecord {
  owner: string;
  identity: W.DeviceIdentity;
  /** IoT certificate bound at provisioning (P07). When set, device requests must match it. */
  certificateId: string | null;
  /**
   * SHA-256 (hex) of the one-time claim secret printed in the device's QR (D50). Present only
   * while the device is unclaimed; cleared when an owner claims it.
   */
  claimSecretHash?: string | null;
}
interface SyncRecord {
  owner: string;
  value: W.SyncRequest;
}
interface AcceptedCapture {
  capture: W.Capture;
  uploadId: string;
  dayId: string | null;
}
export interface SnapshotRecord {
  owner: string;
  begin: W.BeginSync;
  value: W.Snapshot;
  state: "uploading" | "accepted" | "invalidated";
  receipt: W.Receipt | null;
  manifestUploadId: string | null;
  /** Captures that were new at acceptance; materialized into the journal afterwards. */
  accepted: AcceptedCapture[];
  suppressedUploadIds: string[];
  materialized: boolean;
  conflicts: string[];
}
interface GrantRecord {
  owner: string;
  deviceId: string;
  epoch: number;
  snapshotId: string;
  item: W.GrantItem;
  expiresAt: string;
  objectKey: string;
}
interface CaptureRecord {
  value: W.Capture;
  uploadId: string;
  objectKey: string;
  dayId: string | null;
  snapshotId: string;
}
interface MomentRecord {
  captureId: string;
  dayId: string | null;
}
type DayFields = Omit<W.Day, "recap" | "corrections" | "reflections">;
interface DayMeta {
  day: DayFields;
  /** Monotonic even when deletion clears the current recap. */
  recapRevisionCounter: number;
  recapRevision: number | null;
  /** Changes on every day write; pagination binds cursors to it. */
  contentRevision: number;
}
interface EditRecord<T> {
  value: T;
  order: number;
}
interface ReceiptRecord {
  digest: string;
  status: number;
  body: unknown;
}
interface CursorRecord {
  scope: string;
  offset: number;
  revision: string;
}
export type DeletionTarget =
  | { kind: "account" }
  | { kind: "day"; id: string }
  | { kind: "capture"; id: string };
interface DeletionRecord {
  owner: string;
  value: W.DeletionJob;
  target: DeletionTarget;
  createdAt: string;
  receiptSk: string | null;
}
export type OutboxKind =
  | "snapshot.accepted"
  | "day.process"
  | "deletion.requested"
  | "recap.published";
export interface OutboxRecord {
  id: string;
  kind: OutboxKind;
  owner: string;
  ref: string;
  inputRevision: number | null;
  createdAt: string;
  dispatchedAt: string | null;
  outcome: string | null;
}
export interface JobUsage {
  observationCalls: number;
  cachedObservations: number;
  failedObservations: number;
  synthesisCalls: number;
  placeLookups?: number;
  inputTokens: number;
  outputTokens: number;
}
export interface Job {
  id: string;
  owner: string;
  day: W.Day;
  captures: W.Capture[];
  state: string;
  revision: number;
  stages: string[];
  nextRecapRevision: number;
  pipeline: string;
  usage: JobUsage | null;
  failureCode: string | null;
}
/** Model output that fails validation. The name is the Step Functions retry match key. */
export class InvalidProviderOutput extends Error {
  override readonly name = "ProviderInvalidOutput";
  constructor(readonly what: string) {
    super(`Invalid provider output: ${what}`);
  }
}
/** Stores receipts without secrets (signed URLs) and restores them on replay. */
export interface ReceiptCodec<T> {
  store(body: T): unknown;
  load(stored: unknown): Promise<T>;
}

export const FIXED_NOW = "2026-11-07T20:00:00Z";
export const RECEIPT_TTL_SECONDS = 31 * 86400;
const TERMINAL_SYNC = ["uploaded", "cancelled", "failed_terminal"];
const TERMINAL_JOB = [
  "ready",
  "partial",
  "superseded",
  "cancelled_by_deletion",
  "failed_terminal",
];
const ACCOUNT = { kind: "account" } as const;
const tomb = (owner: string, target: DeletionTarget): Key =>
  keys.tombstone(
    owner,
    target.kind === "account"
      ? "ACCOUNT"
      : `${target.kind.toUpperCase()}#${target.id}`,
  );
/**
 * Journal day of a capture: its local calendar date from the device-reported offset (D52).
 * UTC captures map to their UTC date exactly as before.
 */
export const localDayId = (capture: W.Capture): string =>
  "day_" +
  new Date(Date.parse(capture.capturedAt) + capture.utcOffsetSeconds * 1000)
    .toISOString()
    .slice(0, 10)
    .replaceAll("-", "");
const isZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
/** UTC offset (ms) of an IANA zone at an instant. */
const zoneOffset = (zone: string, at: number): number => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const v = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return (
    Date.UTC(
      v("year"),
      v("month") - 1,
      v("day"),
      v("hour"),
      v("minute"),
      v("second"),
    ) -
    Math.floor(at / 1000) * 1000
  );
};
/** The instant of local midnight in `zone` for the calendar date at UTC midnight `utcDate`. */
const zonedMidnight = (utcDate: number, zone: string): string => {
  let at = utcDate - zoneOffset(zone, utcDate);
  at = utcDate - zoneOffset(zone, at); // second pass settles DST transitions
  return new Date(at).toISOString().replace(".000Z", "Z");
};
export const jobIdFor = (
  owner: string,
  dayId: string,
  inputRevision: number,
  pipeline: string,
): string =>
  "job_" +
  sha256([owner, dayId, String(inputRevision), pipeline].join("\n")).slice(
    0,
    40,
  );
export const uploadIdFor = (
  snapshotId: string,
  kind: W.GrantItem["kind"],
  captureId: string | null,
): string =>
  "upload_" +
  sha256([snapshotId, kind, captureId ?? ""].join("\n")).slice(0, 40);
const outboxIdFor = (...parts: Array<string | number>): string =>
  "ob_" + sha256(parts.join("\n")).slice(0, 40);
const randomId = (prefix: string): string =>
  `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
const epochSeconds = (instant: string): number =>
  Math.floor(Date.parse(instant) / 1000);

async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await fn(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export interface EngineOptions {
  store: Store;
  objects: ObjectStore;
  signer: GrantSigner;
  now?: () => string;
  ids?: (prefix: string) => string;
  /** inline: run outbox work right after commit (local). deferred: a stream dispatcher runs it (AWS). */
  dispatch?: "inline" | "deferred";
  jobs?: JobStarter | null;
  /** Generic recap-ready push (P10). Absent until notifications are implemented. */
  notifier?: Notifier | null;
  pipeline?: string;
  /** Called with safe metadata only (IDs, codes, counts). */
  log?: (event: string, fields: Record<string, string | number>) => void;
}

export class Engine {
  readonly store: Store;
  readonly objects: ObjectStore;
  readonly signer: GrantSigner;
  readonly now: () => string;
  readonly pipeline: string;
  private readonly ids: (prefix: string) => string;
  private readonly dispatchMode: "inline" | "deferred";
  private readonly jobs: JobStarter | null;
  private readonly notifier: Notifier | null;
  private readonly log: NonNullable<EngineOptions["log"]>;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.objects = options.objects;
    this.signer = options.signer;
    this.now = options.now ?? (() => FIXED_NOW);
    this.ids = options.ids ?? randomId;
    this.dispatchMode = options.dispatch ?? "inline";
    this.jobs = options.jobs ?? null;
    this.notifier = options.notifier ?? null;
    this.pipeline = options.pipeline ?? "mock_1";
    this.log = options.log ?? (() => {});
  }

  expiry(seconds: number): string {
    return new Date(Date.parse(this.now()) + seconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  }

  /** Runs a unit with bounded optimistic-concurrency retries. */
  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withRetries(
      4,
      async () => {
        const tx = new Tx(this.store);
        const result = await fn(tx);
        await tx.commit();
        return result;
      },
      () => new Fault(409, "CONFLICT", true),
    );
  }
  private unit<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx ? fn(tx) : this.run(fn);
  }

  // Authorization ------------------------------------------------------------

  private async assertLive(
    tx: Tx,
    owner: string,
    target?: DeletionTarget,
  ): Promise<void> {
    const found = await tx.getMany([
      tomb(owner, ACCOUNT),
      ...(target ? [tomb(owner, target)] : []),
    ]);
    if (found.some(Boolean)) throw new Fault(410, "DELETED");
    await tx.guard(tomb(owner, ACCOUNT));
  }
  async authorizeDevice(
    actor: Actor,
    deviceId: string,
    epoch?: number,
    tx?: Tx,
  ): Promise<DeviceRecord> {
    return this.unit(tx, async (t) => {
      await this.assertLive(t, actor.owner);
      const device = await t.get<DeviceRecord>(keys.identity(deviceId));
      if (
        !device ||
        device.owner !== actor.owner ||
        device.identity.claimState !== "owned"
      )
        throw new Fault(404, "NOT_FOUND");
      if (actor.deviceId && actor.deviceId !== deviceId)
        throw new Fault(403, "FORBIDDEN");
      if (epoch !== undefined && device.identity.ownershipEpoch !== epoch)
        throw new Fault(403, "STALE_EPOCH");
      await t.guard(keys.identity(deviceId));
      return device;
    });
  }
  private async deviceActor(
    tx: Tx,
    actor: Actor,
    deviceId: string,
    epoch: number,
  ): Promise<DeviceRecord> {
    if (!actor.deviceId || actor.deviceId !== deviceId)
      throw new Fault(403, "FORBIDDEN");
    return this.authorizeDevice(actor, deviceId, epoch, tx);
  }
  private async appActor(tx: Tx, actor: Actor): Promise<void> {
    await this.assertLive(tx, actor.owner);
    if (actor.deviceId) throw new Fault(403, "FORBIDDEN");
  }
  private async snapshot(
    tx: Tx,
    actor: Actor,
    id: string,
  ): Promise<SnapshotRecord> {
    const snapshot = await tx.get<SnapshotRecord>(keys.snapshot(id));
    if (!snapshot || snapshot.owner !== actor.owner)
      throw new Fault(404, "NOT_FOUND");
    await this.deviceActor(
      tx,
      actor,
      snapshot.value.deviceId,
      snapshot.value.ownershipEpoch,
    );
    if (snapshot.state === "invalidated") throw new Fault(410, "DELETED");
    return snapshot;
  }

  // Idempotent mutations -----------------------------------------------------

  async mutate<T>(
    actor: Actor,
    method: string,
    route: string,
    operation: string,
    payload: unknown,
    status: number,
    fn: (tx: Tx) => Promise<T>,
    codec?: ReceiptCodec<T>,
  ): Promise<{ status: number; body: T }> {
    try {
      validate("Id", operation);
    } catch {
      throw new Fault(400, "INVALID_REQUEST");
    }
    const scope = [
      actor.owner,
      actor.deviceId ?? "app",
      method,
      route,
      operation,
    ].join("|");
    const receiptKey = keys.receipt(actor.owner, sha256(scope));
    const hash = digest(payload);
    const result = await this.run(async (tx) => {
      await this.assertLive(tx, actor.owner);
      const prior = await tx.get<ReceiptRecord>(receiptKey);
      if (prior) {
        if (prior.digest !== hash) throw new Fault(409, "CONFLICT");
        return { status: prior.status, stored: prior.body, replay: true };
      }
      tx.receiptKey = receiptKey;
      const body = structuredClone(await fn(tx));
      const stored = codec ? codec.store(body) : body;
      tx.put<ReceiptRecord>(
        receiptKey,
        { digest: hash, status, body: stored },
        { ttl: epochSeconds(this.now()) + RECEIPT_TTL_SECONDS },
      );
      return { status, stored: body as unknown, replay: false };
    });
    const body =
      result.replay && codec
        ? await codec.load(result.stored)
        : (structuredClone(result.stored) as T);
    return { status: result.status, body };
  }

  // Sync requests ------------------------------------------------------------

  async requestSync(
    actor: Actor,
    deviceId: string,
    tx?: Tx,
  ): Promise<W.SyncRequest> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      await this.authorizeDevice(actor, deviceId, undefined, t);
      const active = await this.activeSync(deviceId, t);
      if (active) return active;
      return (await this.createSync(t, actor.owner, deviceId, "manual")).value;
    });
  }
  async activeSync(
    deviceId: string,
    tx?: Tx,
  ): Promise<W.SyncRequest | undefined> {
    return this.unit(tx, async (t) => {
      const pointer = await t.get<{ syncRequestId: string }>(
        keys.activeSync(deviceId),
      );
      if (!pointer) return undefined;
      const sync = await t.get<SyncRecord>(keys.sync(pointer.syncRequestId));
      const s = sync?.value;
      return s &&
        !TERMINAL_SYNC.includes(s.state) &&
        (s.state !== "waiting_for_device" || s.expiresAt > this.now())
        ? s
        : undefined;
    });
  }
  private async createSync(
    tx: Tx,
    owner: string,
    deviceId: string,
    trigger: "manual" | "nightly",
  ): Promise<SyncRecord> {
    const device = (await tx.get<DeviceRecord>(keys.identity(deviceId)))!;
    await tx.get(keys.activeSync(deviceId));
    const record: SyncRecord = {
      owner,
      value: {
        schemaVersion: 1,
        syncRequestId: this.ids("sync"),
        deviceId,
        ownershipEpoch: device.identity.ownershipEpoch,
        trigger,
        state: "waiting_for_device",
        revision: 1,
        createdAt: this.now(),
        expiresAt: this.expiry(300),
      },
    };
    tx.put(keys.sync(record.value.syncRequestId), record);
    tx.put(keys.activeSync(deviceId), {
      syncRequestId: record.value.syncRequestId,
    });
    return record;
  }
  async getSync(actor: Actor, id: string, tx?: Tx): Promise<W.SyncRequest> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      const sync = await t.get<SyncRecord>(keys.sync(id));
      if (!sync || sync.owner !== actor.owner)
        throw new Fault(404, "NOT_FOUND");
      await this.authorizeDevice(actor, sync.value.deviceId, undefined, t);
      return sync.value;
    });
  }
  async cancelSync(actor: Actor, id: string, tx?: Tx): Promise<W.SyncRequest> {
    return this.unit(tx, async (t) => {
      const current = await this.getSync(actor, id, t);
      if (current.state === "uploaded" || current.state === "cancelled")
        return current;
      const record = (await t.get<SyncRecord>(keys.sync(id)))!;
      this.transitionSync(record, "cancel_requested");
      this.transitionSync(record, "cancelled");
      t.put(keys.sync(id), record);
      return record.value;
    });
  }
  private transitionSync(record: SyncRecord, to: W.SyncRequest["state"]): void {
    const s = record.value;
    try {
      validate("Transition", {
        schemaVersion: 1,
        machine: "sync",
        from: s.state,
        to,
        revision: s.revision,
        expectedRevision: s.revision,
      });
    } catch {
      throw new Fault(409, "INVALID_STATE");
    }
    s.state = to;
    s.revision++;
  }

  // Device upload protocol ---------------------------------------------------

  async begin(actor: Actor, input: W.BeginSync, tx?: Tx): Promise<W.Snapshot> {
    return this.unit(tx, async (t) => {
      const device = await this.deviceActor(
        t,
        actor,
        input.deviceId,
        input.ownershipEpoch,
      );
      if (
        input.configurationRevision !== device.identity.appliedRevision ||
        input.sequenceEnd < input.sequenceStart ||
        input.sequenceEnd - input.sequenceStart >= 10000 ||
        input.startedAt > input.cutoffAt
      )
        throw new Fault(400, "INVALID_REQUEST");
      let sync: SyncRecord | undefined;
      if (input.syncRequestId) {
        sync = await t.get<SyncRecord>(keys.sync(input.syncRequestId));
        if (
          !sync ||
          sync.owner !== actor.owner ||
          sync.value.deviceId !== input.deviceId
        )
          throw new Fault(404, "NOT_FOUND");
      } else {
        const active = await this.activeSync(input.deviceId, t);
        sync = active
          ? await t.get<SyncRecord>(keys.sync(active.syncRequestId))
          : undefined;
      }
      if (
        sync &&
        (sync.value.state !== "waiting_for_device" ||
          sync.value.trigger !== input.trigger)
      )
        throw new Fault(409, "CONFLICT");
      if (sync && sync.value.expiresAt <= this.now())
        throw new Fault(410, "EXPIRED");
      sync ??= await this.createSync(
        t,
        actor.owner,
        input.deviceId,
        input.trigger,
      );
      this.transitionSync(sync, "preparing");
      const value: W.Snapshot = {
        schemaVersion: 1,
        snapshotId: this.ids("snap"),
        syncRequestId: sync.value.syncRequestId,
        deviceId: input.deviceId,
        ownershipEpoch: input.ownershipEpoch,
      };
      this.transitionSync(sync, "uploading");
      t.put(keys.sync(sync.value.syncRequestId), sync);
      t.put<SnapshotRecord>(keys.snapshot(value.snapshotId), {
        owner: actor.owner,
        begin: input,
        value,
        state: "uploading",
        receipt: null,
        manifestUploadId: null,
        accepted: [],
        suppressedUploadIds: [],
        materialized: false,
        conflicts: [],
      });
      return value;
    });
  }

  /** Receipt codec for grants: signed URLs are re-issued on replay, never stored. */
  grantCodec(actor: Actor, origin?: string): ReceiptCodec<W.UploadGrants> {
    return {
      store: (body) => ({
        ...body,
        items: body.items.map((item) => ({ ...item, putURL: "" })),
      }),
      load: async (stored) => {
        const body = structuredClone(stored) as W.UploadGrants;
        for (const item of body.items) {
          const grant = (await this.store.get(keys.grant(item.uploadId)))
            ?.data as GrantRecord | undefined;
          if (!grant || grant.owner !== actor.owner)
            throw new Fault(404, "NOT_FOUND");
          item.putURL = (
            await this.signer.signPut({
              key: grant.objectKey,
              uploadId: item.uploadId,
              item: grant.item,
              expiresAt: item.expiresAt,
              now: this.now(),
              origin,
            })
          ).putURL;
        }
        return body;
      },
    };
  }

  async grants(
    actor: Actor,
    snapshotId: string,
    input: W.GrantRequest,
    origin?: string,
    tx?: Tx,
  ): Promise<W.UploadGrants> {
    return this.unit(tx, async (t) => {
      const snapshot = await this.snapshot(t, actor, snapshotId);
      await this.deviceActor(t, actor, input.deviceId, input.ownershipEpoch);
      const sync = await t.get<SyncRecord>(
        keys.sync(snapshot.value.syncRequestId),
      );
      if (
        input.deviceId !== snapshot.value.deviceId ||
        sync?.value.state !== "uploading"
      )
        throw new Fault(409, "INVALID_STATE");
      const items: W.UploadGrant[] = [];
      for (const item of input.items) {
        if (
          (item.kind === "manifest") !== (item.captureId === null) ||
          (item.kind === "manifest") !==
            (item.contentType === "application/json") ||
          (item.kind === "manifest" && item.byteLength > 1000000)
        )
          throw new Fault(400, "INVALID_REQUEST");
        const uploadId = uploadIdFor(snapshotId, item.kind, item.captureId);
        const existing = await t.get<GrantRecord>(keys.grant(uploadId));
        if (existing && canonical(existing.item) !== canonical(item))
          throw new Fault(409, "CONFLICT");
        if (item.captureId) {
          const capture = await t.get<CaptureRecord>(
            keys.capture(actor.owner, item.captureId),
          );
          if (
            capture &&
            (capture.value.sha256 !== item.sha256 ||
              capture.value.byteLength !== item.byteLength ||
              capture.value.contentType !== item.contentType)
          )
            throw new Fault(409, "CONFLICT");
        }
        const grant: GrantRecord = {
          owner: actor.owner,
          deviceId: input.deviceId,
          epoch: input.ownershipEpoch,
          snapshotId,
          item,
          expiresAt: this.expiry(900),
          objectKey: objectKey(actor.owner, snapshotId, uploadId),
        };
        t.put(keys.grant(uploadId), grant);
        if (!existing && item.captureId) {
          const index = keys.captureGrant(
            actor.owner,
            item.captureId,
            uploadId,
          );
          await t.get(index);
          t.put(index, { snapshotId, uploadId });
        }
        const signed = await this.signer.signPut({
          key: grant.objectKey,
          uploadId,
          item,
          expiresAt: grant.expiresAt,
          now: this.now(),
          origin,
        });
        items.push({
          schemaVersion: 1,
          uploadId,
          kind: item.kind,
          captureId: item.captureId,
          putURL: signed.putURL,
          expiresAt: grant.expiresAt,
          requiredHeaders: {
            "If-None-Match": "*",
            "X-Clippy-SHA256": item.sha256,
            "Content-Type": item.contentType,
          },
        });
      }
      return { schemaVersion: 1, items };
    });
  }

  /** Local adapter for the bytes path. S3 performs the equivalent checks in AWS. */
  async put(
    actor: Actor,
    uploadId: string,
    bytes: Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<void> {
    const t = new Tx(this.store);
    const grant = await t.get<GrantRecord>(keys.grant(uploadId));
    if (!grant || grant.owner !== actor.owner)
      throw new Fault(404, "NOT_FOUND");
    await this.deviceActor(t, actor, grant.deviceId, grant.epoch);
    await this.snapshot(t, actor, grant.snapshotId);
    if (grant.item.captureId)
      await this.assertLive(t, actor.owner, {
        kind: "capture",
        id: grant.item.captureId,
      });
    if (grant.expiresAt <= this.now()) throw new Fault(410, "EXPIRED");
    if (
      headers["if-none-match"] !== "*" ||
      headers["x-clippy-sha256"] !== grant.item.sha256 ||
      headers["content-type"] !== grant.item.contentType
    )
      throw new Fault(400, "INVALID_REQUEST");
    const objects = this.objects as WritableObjectStore;
    if (await objects.head(grant.objectKey))
      throw new Fault(412, "PRECONDITION_FAILED");
    if (bytes.length !== grant.item.byteLength)
      throw new Fault(422, "SIZE_MISMATCH");
    if (sha256(bytes) !== grant.item.sha256)
      throw new Fault(422, "CHECKSUM_MISMATCH");
    if (!(await objects.putIfAbsent(grant.objectKey, bytes)))
      throw new Fault(412, "PRECONDITION_FAILED");
  }
  async checkSnapshotAccess(actor: Actor, id: string): Promise<void> {
    await this.snapshot(new Tx(this.store), actor, id);
  }

  async complete(
    actor: Actor,
    snapshotId: string,
    input: W.CompleteSync,
    tx?: Tx,
  ): Promise<W.Receipt> {
    return this.unit(tx, async (t) => {
      const snapshot = await this.snapshot(t, actor, snapshotId);
      await this.deviceActor(t, actor, input.deviceId, input.ownershipEpoch);
      const manifestGrant = await t.get<GrantRecord>(
        keys.grant(input.manifestUploadId),
      );
      if (snapshot.receipt) {
        if (
          !manifestGrant ||
          manifestGrant.snapshotId !== snapshotId ||
          manifestGrant.item.sha256 !== input.manifestSHA256
        )
          throw new Fault(409, "CONFLICT");
        return snapshot.receipt;
      }
      const sync = (await t.get<SyncRecord>(
        keys.sync(snapshot.value.syncRequestId),
      ))!;
      if (sync.value.state !== "uploading")
        throw new Fault(409, "INVALID_STATE");
      if (
        !manifestGrant ||
        manifestGrant.snapshotId !== snapshotId ||
        manifestGrant.item.kind !== "manifest" ||
        manifestGrant.item.sha256 !== input.manifestSHA256
      )
        throw new Fault(422, "INVALID_MANIFEST");
      const bytes = (await this.verifiedObject(
        input.manifestUploadId,
        manifestGrant,
        true,
      ))!;
      let manifest: W.Manifest;
      try {
        manifest = decode<W.Manifest>(
          "Manifest",
          JSON.parse(Buffer.from(bytes).toString("utf8")),
        );
      } catch {
        throw new Fault(422, "INVALID_MANIFEST");
      }
      for (const field of [
        "deviceId",
        "ownershipEpoch",
        "trigger",
        "startedAt",
        "cutoffAt",
        "sequenceStart",
        "sequenceEnd",
        "captureCount",
      ] as const) {
        if (manifest[field] !== snapshot.begin[field])
          throw new Fault(422, "INVALID_MANIFEST");
      }
      if (
        manifest.snapshotId !== snapshotId ||
        manifest.syncRequestId !== snapshot.value.syncRequestId
      )
        throw new Fault(422, "INVALID_MANIFEST");
      const entries = manifest.captures.map((entry) => {
        const { uploadId, ...capture } = entry;
        const dayId =
          capture.clockQuality === "untrusted" ? null : localDayId(capture);
        return { uploadId, capture: capture as W.Capture, dayId };
      });
      const grants = await t.getMany<GrantRecord>(
        entries.map((e) => keys.grant(e.uploadId)),
      );
      entries.forEach((entry, index) => {
        const grant = grants[index];
        if (
          !grant ||
          grant.snapshotId !== snapshotId ||
          grant.item.captureId !== entry.capture.captureId ||
          grant.item.kind !== "capture" ||
          grant.item.sha256 !== entry.capture.sha256 ||
          grant.item.byteLength !== entry.capture.byteLength ||
          grant.item.contentType !== entry.capture.contentType
        )
          throw new Fault(422, "INVALID_MANIFEST");
      });
      const dayIds = [
        ...new Set(entries.flatMap((e) => (e.dayId ? [e.dayId] : []))),
      ];
      const [captureTombs, dayTombs, priors] = await Promise.all([
        t.getMany(
          entries.map((e) =>
            tomb(actor.owner, { kind: "capture", id: e.capture.captureId }),
          ),
        ),
        t.getMany(dayIds.map((id) => tomb(actor.owner, { kind: "day", id }))),
        t.getMany<CaptureRecord>(
          entries.map((e) => keys.capture(actor.owner, e.capture.captureId)),
        ),
      ]);
      const deletedDays = new Set(dayIds.filter((_, i) => dayTombs[i]));
      const accepted: string[] = [],
        suppressed: string[] = [],
        suppressedUploads: string[] = [],
        live: typeof entries = [],
        pending: AcceptedCapture[] = [],
        receiptDays = new Set<string>();
      entries.forEach((entry, index) => {
        if (
          captureTombs[index] ||
          (entry.dayId && deletedDays.has(entry.dayId))
        ) {
          suppressed.push(entry.capture.captureId);
          suppressedUploads.push(entry.uploadId);
          return;
        }
        const prior = priors[index];
        if (prior && canonical(prior.value) !== canonical(entry.capture))
          throw new Fault(409, "CONFLICT");
        live.push(entry);
        if (!prior) pending.push(entry);
        accepted.push(entry.capture.captureId);
        if (entry.dayId) receiptDays.add(entry.dayId);
      });
      const failures = await mapLimit(live, 16, async (entry) => {
        try {
          await this.verifiedObject(
            entry.uploadId,
            grants[entries.indexOf(entry)]!,
            false,
          );
          return null;
        } catch (error) {
          return error as Fault;
        }
      });
      const missing = failures.flatMap((f) =>
        f?.code === "MISSING_OBJECTS" ? f.itemIds! : [],
      );
      const invalid = failures.find((f) => f && f.code !== "MISSING_OBJECTS");
      if (invalid) throw invalid;
      if (missing.length)
        throw new Fault(503, "MISSING_OBJECTS", true, undefined, missing);
      this.transitionSync(sync, "verifying");
      this.transitionSync(sync, "uploaded");
      const sorted = [...accepted].sort();
      const receipt: W.Receipt = {
        schemaVersion: 1,
        snapshotId,
        syncRequestId: snapshot.value.syncRequestId,
        acceptedCaptureIds: sorted,
        suppressedCaptureIds: [...suppressed].sort(),
        effectiveDigest: sha256(sorted.join("\n")),
        verifiedAt: this.now(),
        dayIds: [...receiptDays].sort(),
      };
      t.put(keys.sync(sync.value.syncRequestId), sync);
      t.put<SnapshotRecord>(keys.snapshot(snapshotId), {
        ...snapshot,
        state: "accepted",
        receipt,
        manifestUploadId: input.manifestUploadId,
        accepted: pending,
        // Suppressed content must not remain as an orphan after a deleted capture is retried.
        suppressedUploadIds: suppressed.length
          ? [...suppressedUploads, input.manifestUploadId]
          : [],
      });
      this.enqueue(t, "snapshot.accepted", actor.owner, snapshotId, null);
      this.log("snapshot.accepted", {
        accepted: accepted.length,
        suppressed: suppressed.length,
      });
      return receipt;
    });
  }

  private async verifiedObject(
    uploadId: string,
    grant: GrantRecord,
    read: boolean,
  ): Promise<Uint8Array | undefined> {
    const item = grant.item;
    const head = await this.objects.head(grant.objectKey);
    if (!head)
      throw new Fault(503, "MISSING_OBJECTS", true, undefined, [uploadId]);
    if (head.byteLength !== item.byteLength)
      throw new Fault(422, "SIZE_MISMATCH", false, undefined, [uploadId]);
    if (!read && head.sha256 !== undefined) {
      if (head.sha256 !== item.sha256)
        throw new Fault(422, "CHECKSUM_MISMATCH", false, undefined, [uploadId]);
      return undefined;
    }
    const bytes = await this.objects.read(grant.objectKey, item.byteLength);
    if (!bytes)
      throw new Fault(503, "MISSING_OBJECTS", true, undefined, [uploadId]);
    if (bytes.length !== item.byteLength)
      throw new Fault(422, "SIZE_MISMATCH", false, undefined, [uploadId]);
    if (sha256(bytes) !== item.sha256)
      throw new Fault(422, "CHECKSUM_MISMATCH", false, undefined, [uploadId]);
    return bytes;
  }

  /** Outbox work: project an accepted snapshot into capture and day records. Idempotent. */
  async materialize(snapshotId: string): Promise<void> {
    const snapshot = (await this.store.get(keys.snapshot(snapshotId)))?.data as
      SnapshotRecord | undefined;
    if (!snapshot || snapshot.state !== "accepted" || snapshot.materialized)
      return;
    const owner = snapshot.owner;
    const conflicts: string[] = [];
    await mapLimit(snapshot.accepted, 8, (entry) =>
      this.run(async (t) => {
        const id = entry.capture.captureId;
        const deleted = await t.getMany([
          tomb(owner, ACCOUNT),
          tomb(owner, { kind: "capture", id }),
          ...(entry.dayId
            ? [tomb(owner, { kind: "day", id: entry.dayId })]
            : []),
        ]);
        if (deleted.some(Boolean)) return;
        const prior = await t.get<CaptureRecord>(keys.capture(owner, id));
        if (prior) {
          if (canonical(prior.value) !== canonical(entry.capture))
            conflicts.push(id);
          return;
        }
        t.put<CaptureRecord>(keys.capture(owner, id), {
          value: entry.capture,
          uploadId: entry.uploadId,
          objectKey: objectKey(owner, snapshotId, entry.uploadId),
          dayId: entry.dayId,
          snapshotId,
        });
        const alias = keys.moment(owner, momentID(id));
        await t.get(alias);
        t.put<MomentRecord>(alias, { captureId: id, dayId: entry.dayId });
        if (entry.dayId) {
          const member = keys.dayCapture(
            owner,
            entry.dayId,
            entry.capture.capturedAt,
            id,
          );
          await t.get(member);
          t.put(member, { value: entry.capture });
        }
      }),
    );
    const days = [
      ...new Set(snapshot.accepted.flatMap((e) => (e.dayId ? [e.dayId] : []))),
    ];
    // A new day takes the zone of its first capture (D52); existing days keep their boundaries.
    const zoneOf = (dayId: string): string =>
      snapshot.accepted.find((e) => e.dayId === dayId)?.capture.timeZone ??
      "UTC";
    for (const dayId of days)
      await this.run(async (t) => {
        const applied = keys.applied(owner, dayId, snapshotId);
        if (await t.get(applied)) return;
        const deleted = await t.getMany([
          tomb(owner, ACCOUNT),
          tomb(owner, { kind: "day", id: dayId }),
        ]);
        if (deleted.some(Boolean)) return;
        const meta =
          (await t.get<DayMeta>(keys.dayMeta(owner, dayId))) ??
          this.newMeta(dayId, zoneOf(dayId));
        meta.day.inputRevision++;
        meta.day.state = "pending";
        meta.day.failureCode = null;
        this.saveMeta(t, owner, meta);
        t.put(applied, { at: this.now() });
        this.enqueue(t, "day.process", owner, dayId, meta.day.inputRevision);
      });
    await this.objects.remove(
      snapshot.suppressedUploadIds.map((u) => objectKey(owner, snapshotId, u)),
    );
    await this.run(async (t) => {
      const current = await t.get<SnapshotRecord>(keys.snapshot(snapshotId));
      if (!current || current.materialized) return;
      t.put(keys.snapshot(snapshotId), {
        ...current,
        materialized: true,
        conflicts,
      });
    });
    if (conflicts.length)
      this.log("snapshot.materialize_conflict", { count: conflicts.length });
  }

  // Days, edits, profile -----------------------------------------------------

  private emptyDay(id: string, zone = "UTC"): W.Day {
    if (!/^day_\d{8}$/.test(id)) throw new Fault(404, "NOT_FOUND");
    const date = `${id.slice(4, 8)}-${id.slice(8, 10)}-${id.slice(10, 12)}T00:00:00Z`;
    if (
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10)
    )
      throw new Fault(404, "NOT_FOUND");
    const timeZone = isZone(zone) ? zone : "UTC";
    return {
      schemaVersion: 1,
      dayId: id,
      timeZone,
      startAt: zonedMidnight(Date.parse(date), timeZone),
      endAt: zonedMidnight(Date.parse(date) + 86400000, timeZone),
      inputRevision: 0,
      deletionGeneration: 0,
      state: "empty",
      calendarFreshness: "unavailable",
      recap: null,
      corrections: [],
      reflections: [],
      failureCode: null,
    };
  }
  private newMeta(dayId: string, zone = "UTC"): DayMeta {
    const { recap, corrections, reflections, ...day } = this.emptyDay(
      dayId,
      zone,
    );
    void recap;
    void corrections;
    void reflections;
    return {
      day,
      recapRevisionCounter: 0,
      recapRevision: null,
      contentRevision: 0,
    };
  }
  private saveMeta(tx: Tx, owner: string, meta: DayMeta): void {
    meta.contentRevision++;
    tx.put(keys.dayMeta(owner, meta.day.dayId), meta, {
      gsi1pk: keys.dayIndexPartition(owner),
      gsi1sk: `${meta.day.startAt}#${meta.day.dayId}`,
    });
  }
  private async edits<T extends { recordId: string }>(
    owner: string,
    dayId: string,
    prefix: "REFLECTION#" | "CORRECTION#",
  ): Promise<T[]> {
    const rows = await queryAll(this.store, {
      table: "journal",
      pk: keys.dayPartition(owner, dayId),
      prefix,
    });
    return rows
      .map((row) => row.data as EditRecord<T>)
      .sort(
        (a, b) =>
          a.order - b.order || a.value.recordId.localeCompare(b.value.recordId),
      )
      .map((row) => row.value);
  }
  private async assembleDay(
    tx: Tx,
    owner: string,
    meta: DayMeta,
  ): Promise<W.Day> {
    const dayId = meta.day.dayId;
    const [recap, corrections, reflections] = await Promise.all([
      meta.recapRevision === null
        ? Promise.resolve(undefined)
        : tx.get<W.Recap>(keys.recap(owner, dayId)),
      this.edits<W.Correction>(owner, dayId, "CORRECTION#"),
      this.edits<W.Reflection>(owner, dayId, "REFLECTION#"),
    ]);
    const { failureCode, ...fields } = meta.day;
    // Preserve the P03 field order so serialized fixtures stay byte-stable.
    return {
      ...fields,
      recap: recap ?? null,
      corrections,
      reflections,
      failureCode,
    };
  }
  async getDay(actor: Actor, id: string, tx?: Tx): Promise<W.Day> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      await this.assertLive(t, actor.owner, { kind: "day", id });
      const meta = await t.get<DayMeta>(keys.dayMeta(actor.owner, id));
      return meta ? this.assembleDay(t, actor.owner, meta) : this.emptyDay(id);
    });
  }
  private async ownedMeta(tx: Tx, actor: Actor, id: string): Promise<DayMeta> {
    await this.appActor(tx, actor);
    await this.assertLive(tx, actor.owner, { kind: "day", id });
    const meta = await tx.get<DayMeta>(keys.dayMeta(actor.owner, id));
    if (!meta) throw new Fault(404, "NOT_FOUND");
    return meta;
  }
  private async metaForMoment(
    tx: Tx,
    actor: Actor,
    id: string,
  ): Promise<DayMeta> {
    await this.appActor(tx, actor);
    if (!id.startsWith("moment_")) throw new Fault(404, "NOT_FOUND");
    const alias = await tx.get<MomentRecord>(keys.moment(actor.owner, id));
    if (!alias?.dayId) throw new Fault(404, "NOT_FOUND");
    await this.assertLive(tx, actor.owner, {
      kind: "capture",
      id: alias.captureId,
    });
    return this.ownedMeta(tx, actor, alias.dayId);
  }
  async dayForMoment(actor: Actor, id: string, tx?: Tx): Promise<W.Day> {
    return this.unit(tx, async (t) =>
      this.assembleDay(t, actor.owner, await this.metaForMoment(t, actor, id)),
    );
  }
  async saveEdit(
    actor: Actor,
    kind: "reflection" | "correction",
    target: string,
    id: string,
    edit: W.EditInput,
    tx?: Tx,
  ): Promise<W.Reflection | W.Correction> {
    return this.unit(tx, async (t) => {
      const meta =
        kind === "reflection"
          ? await this.ownedMeta(t, actor, target)
          : await this.metaForMoment(t, actor, target);
      const dayId = meta.day.dayId;
      const key =
        kind === "reflection"
          ? keys.reflection(actor.owner, dayId, id)
          : keys.correction(actor.owner, dayId, id);
      const current = (
        await t.get<EditRecord<W.Reflection | W.Correction>>(key)
      )?.value;
      if (
        kind === "correction" &&
        current &&
        (current as W.Correction).momentId !== target
      )
        throw new Fault(409, "CONFLICT");
      if ((current?.revision ?? 0) !== edit.expectedRevision)
        throw new Fault(
          409,
          "REVISION_CONFLICT",
          false,
          current?.revision ?? 0,
        );
      const record: W.Reflection | W.Correction = {
        schemaVersion: 1,
        operationId: edit.operationId,
        recordId: id,
        dayId,
        revision: (current?.revision ?? 0) + 1,
        text: edit.deleted ? "" : edit.text,
        deleted: edit.deleted,
        updatedAt: this.now(),
        ...(kind === "correction" ? { momentId: target } : {}),
      };
      t.put(key, { value: record, order: meta.contentRevision + 1 });
      if (kind === "correction") {
        meta.day.inputRevision++;
        meta.day.state = "pending";
        this.enqueue(
          t,
          "day.process",
          actor.owner,
          dayId,
          meta.day.inputRevision,
        );
      }
      this.saveMeta(t, actor.owner, meta);
      return record;
    });
  }

  private defaultProfile(): W.Profile {
    return {
      schemaVersion: 1,
      journalTimeZone: "UTC",
      revision: 1,
      retentionDays: 7,
      consentRevision: 0,
    };
  }
  async profile(actor: Actor, tx?: Tx): Promise<W.Profile> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      return (
        (await t.get<W.Profile>(keys.profile(actor.owner))) ??
        this.defaultProfile()
      );
    });
  }
  async preferences(
    actor: Actor,
    input: W.Preferences,
    tx?: Tx,
  ): Promise<W.Profile> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      const current =
        (await t.get<W.Profile>(keys.profile(actor.owner))) ??
        this.defaultProfile();
      if (current.revision !== input.expectedRevision)
        throw new Fault(409, "REVISION_CONFLICT", false, current.revision);
      // D10: day boundaries are UTC until a boundary-preserving timezone migration exists.
      if (input.journalTimeZone !== "UTC")
        throw new Fault(400, "INVALID_REQUEST");
      const next: W.Profile = {
        ...current,
        journalTimeZone: input.journalTimeZone,
        retentionDays: input.retentionDays,
        revision: current.revision + 1,
      };
      t.put(keys.profile(actor.owner), next);
      return next;
    });
  }

  /** Receipt codec for read grants: the URL is re-signed after re-checking access. */
  readCodec(
    actor: Actor,
    captureId: string,
    origin?: string,
  ): ReceiptCodec<W.ReadGrant> {
    return {
      store: (body) => ({ ...body, readURL: "" }),
      load: async (stored) => {
        const body = stored as W.ReadGrant;
        return this.readGrant(actor, captureId, origin, body.expiresAt);
      },
    };
  }
  async readGrant(
    actor: Actor,
    captureId: string,
    origin?: string,
    expiresAt?: string,
    tx?: Tx,
  ): Promise<W.ReadGrant> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      await this.assertLive(t, actor.owner, { kind: "capture", id: captureId });
      const capture = await t.get<CaptureRecord>(
        keys.capture(actor.owner, captureId),
      );
      if (!capture) throw new Fault(404, "NOT_FOUND");
      if (capture.dayId)
        await this.assertLive(t, actor.owner, {
          kind: "day",
          id: capture.dayId,
        });
      const until = expiresAt ?? this.expiry(60);
      const readURL = await this.signer.signGet({
        key: capture.objectKey,
        uploadId: capture.uploadId,
        expiresAt: until,
        now: this.now(),
        origin,
      });
      return { schemaVersion: 1, readURL, expiresAt: until };
    });
  }

  // Processing ---------------------------------------------------------------

  async dayCaptures(owner: string, dayId: string): Promise<W.Capture[]> {
    const rows = await queryAll(this.store, {
      table: "journal",
      pk: keys.dayPartition(owner, dayId),
      prefix: "CAPTURE#",
    });
    const values = rows.map((row) => (row.data as { value: W.Capture }).value);
    const deleted = await new Tx(this.store).getMany(
      values.map((c) => tomb(owner, { kind: "capture", id: c.captureId })),
    );
    return values.filter((_, index) => !deleted[index]);
  }
  async prepareJob(owner: string, dayId: string): Promise<Job> {
    return this.run(async (t) => {
      const actor = { owner, deviceId: null };
      const meta = await this.ownedMeta(t, actor, dayId);
      const id = jobIdFor(owner, dayId, meta.day.inputRevision, this.pipeline);
      const prior = await t.get<Job>(keys.job(owner, dayId, id));
      if (prior) return prior;
      const job: Job = {
        id,
        owner,
        day: await this.assembleDay(t, owner, meta),
        captures: await this.dayCaptures(owner, dayId),
        state: "queued",
        revision: 1,
        stages: ["queued"],
        nextRecapRevision: meta.recapRevisionCounter + 1,
        pipeline: this.pipeline,
        usage: null,
        failureCode: null,
      };
      t.put(keys.job(owner, dayId, id), job);
      return job;
    });
  }
  private jobTransition(job: Job, to: string): void {
    validate("Transition", {
      schemaVersion: 1,
      machine: "job",
      from: job.state,
      to,
      revision: job.revision,
      expectedRevision: job.revision,
    });
    job.state = to;
    job.revision++;
    job.stages.push(to);
  }
  private async loadJob(
    owner: string,
    dayId: string,
    jobId: string,
  ): Promise<Job> {
    const job = (await this.store.get(keys.job(owner, dayId, jobId)))?.data as
      Job | undefined;
    if (!job) throw new Fault(404, "NOT_FOUND");
    return job;
  }
  private async supersede(
    owner: string,
    dayId: string,
    jobId: string,
  ): Promise<void> {
    await this.run(async (t) => {
      const key = keys.job(owner, dayId, jobId);
      const stored = await t.get<Job>(key);
      if (!stored || TERMINAL_JOB.includes(stored.state)) return;
      this.jobTransition(stored, "superseded");
      t.put(key, stored);
    });
  }

  /**
   * Pipeline step 1. Freezes the job for the requested revision and moves it to observing.
   * A stale revision, deleted day or different pipeline version returns superseded so a
   * duplicate or late execution ends without model calls.
   */
  async beginJob(input: {
    owner: string;
    dayId: string;
    jobId: string;
    inputRevision: number;
  }): Promise<{
    status: "observing" | "superseded" | "done";
    captureIds: string[];
  }> {
    const { owner, dayId, jobId } = input;
    const superseded = async () => {
      await this.supersede(owner, dayId, jobId);
      return { status: "superseded" as const, captureIds: [] };
    };
    const [meta, ...deleted] = await new Tx(this.store).getMany<unknown>([
      keys.dayMeta(owner, dayId),
      tomb(owner, ACCOUNT),
      tomb(owner, { kind: "day", id: dayId }),
    ]);
    if (
      !meta ||
      deleted.some(Boolean) ||
      (meta as DayMeta).day.inputRevision !== input.inputRevision ||
      jobIdFor(owner, dayId, input.inputRevision, this.pipeline) !== jobId
    )
      return superseded();
    const job = await this.prepareJob(owner, dayId);
    if (job.id !== jobId) return superseded();
    if (["ready", "partial"].includes(job.state))
      return { status: "done", captureIds: [] };
    if (TERMINAL_JOB.includes(job.state))
      return { status: "superseded", captureIds: [] };
    await this.run(async (t) => {
      const key = keys.job(owner, dayId, jobId);
      const stored = (await t.get<Job>(key))!;
      if (stored.state === "failed_retryable")
        this.jobTransition(stored, "queued");
      if (stored.state === "queued") {
        this.jobTransition(stored, "observing");
        t.put(key, stored);
      }
    });
    return {
      status: "observing",
      captureIds: job.captures.map((c) => c.captureId),
    };
  }

  /** Pipeline step 2, one capture. Ready observations are cached; failures are not. */
  async observeCapture(
    owner: string,
    dayId: string,
    jobId: string,
    captureId: string,
    provider: ObservationProvider,
  ): Promise<{
    captureId: string;
    status: "ready" | "cached" | "failed" | "skipped";
    reason: string | null;
  }> {
    const job = await this.loadJob(owner, dayId, jobId);
    const capture = job.captures.find((c) => c.captureId === captureId);
    if (!capture) throw new Fault(404, "NOT_FOUND");
    const deleted = await new Tx(this.store).getMany([
      tomb(owner, ACCOUNT),
      tomb(owner, { kind: "day", id: dayId }),
      tomb(owner, { kind: "capture", id: captureId }),
    ]);
    if (deleted.some(Boolean))
      return { captureId, status: "skipped", reason: "deleted" };
    const cacheItem = keys.observation(
      owner,
      dayId,
      `${captureId}#${capture.sha256}#${this.pipeline}`,
    );
    if (await this.store.get(cacheItem))
      return { captureId, status: "cached", reason: null };
    const record = (await this.store.get(keys.capture(owner, captureId)))
      ?.data as CaptureRecord | undefined;
    const observation = await provider.observe(capture, {
      contentType: capture.contentType,
      byteLength: capture.byteLength,
      read: async (maxBytes) =>
        record ? this.objects.read(record.objectKey, maxBytes) : undefined,
    });
    try {
      validate("Observation", observation);
    } catch {
      throw new InvalidProviderOutput("observation schema");
    }
    if (
      observation.captureId !== captureId ||
      observation.evidence.some(
        (e) => e.type !== "capture" || e.id !== captureId,
      )
    )
      throw new InvalidProviderOutput("observation evidence");
    if (observation.status !== "ready")
      return { captureId, status: "failed", reason: "unusable" };
    await this.run(async (t) => {
      await t.get(cacheItem);
      t.put(cacheItem, observation);
    });
    return { captureId, status: "ready", reason: null };
  }

  /** Pipeline step 3 input: the frozen job and one observation (or a gap) per capture. */
  async synthesisInput(
    owner: string,
    dayId: string,
    jobId: string,
  ): Promise<{ job: Job; observations: W.Observation[] }> {
    const job = await this.loadJob(owner, dayId, jobId);
    const t = new Tx(this.store);
    const [cached, deleted] = await Promise.all([
      t.getMany<W.Observation>(
        job.captures.map((c) =>
          keys.observation(
            owner,
            dayId,
            `${c.captureId}#${c.sha256}#${this.pipeline}`,
          ),
        ),
      ),
      t.getMany(
        job.captures.map((c) =>
          tomb(owner, { kind: "capture", id: c.captureId }),
        ),
      ),
    ]);
    const observations = job.captures.map((c, i): W.Observation =>
      cached[i] && !deleted[i]
        ? cached[i]!
        : {
            schemaVersion: 1,
            captureId: c.captureId,
            providerVersion: "none",
            promptVersion: "none",
            preprocessingVersion: "none",
            status: "failed",
            visibleFacts: [],
            inferredActivity: null,
            uncertainty: "No observation is available for this capture.",
            evidence: [{ type: "capture", id: c.captureId }],
          },
    );
    return { job, observations };
  }

  /** Checks a candidate against the frozen job. Throws Fault 422 when it is not publishable. */
  private async checkRecap(tx: Tx, job: Job, result: W.Recap): Promise<void> {
    try {
      validate("Recap", result);
    } catch {
      throw new Fault(422, "INVALID_REQUEST");
    }
    const sources = new Set(job.captures.map((c) => c.captureId));
    const evidence = [
      ...new Set(result.moments.flatMap((m) => m.evidence.map((e) => e.id))),
    ];
    const deleted = await tx.getMany(
      evidence.map((id) => tomb(job.owner, { kind: "capture", id })),
    );
    const deletedEvidence = new Set(evidence.filter((_, i) => deleted[i]));
    if (
      result.dayId !== job.day.dayId ||
      result.inputRevision !== job.day.inputRevision ||
      result.deletionGeneration !== job.day.deletionGeneration ||
      result.recapRevision !== job.nextRecapRevision ||
      new Set(result.moments.map((m) => m.momentId)).size !==
        result.moments.length ||
      result.moments.some(
        (m) =>
          m.momentId !== momentID(m.evidence[0]!.id) ||
          m.evidence.some(
            (e) =>
              e.type !== "capture" ||
              !sources.has(e.id) ||
              deletedEvidence.has(e.id),
          ),
      ) ||
      result.coverage.captured !== job.captures.length ||
      result.coverage.observed !== result.moments.length ||
      result.coverage.missing !== job.captures.length - result.moments.length
    )
      throw new Fault(422, "INVALID_REQUEST");
  }

  /**
   * Pipeline step 3 output: validate and store a candidate recap plus usage, not yet
   * visible. A changed revision or deletion means the work is stale, not that the model
   * output was invalid, so it reports superseded instead of inviting a paid retry.
   */
  async saveCandidate(
    owner: string,
    dayId: string,
    jobId: string,
    candidate: W.Recap,
    usage: JobUsage,
  ): Promise<"saved" | "superseded"> {
    const outcome = await this.run(async (t) => {
      const key = keys.job(owner, dayId, jobId);
      const [job, meta, accountTomb, dayTomb] = await Promise.all([
        t.get<Job>(key),
        t.get<DayMeta>(keys.dayMeta(owner, dayId)),
        t.get(tomb(owner, ACCOUNT)),
        t.get(tomb(owner, { kind: "day", id: dayId })),
      ]);
      // Deletion removes a day's jobs; a vanished job is stale work, not an error.
      if (!job) return "superseded" as const;
      job.usage = usage;
      if (
        !meta ||
        accountTomb ||
        dayTomb ||
        meta.day.inputRevision !== job.day.inputRevision ||
        meta.day.deletionGeneration !== job.day.deletionGeneration ||
        TERMINAL_JOB.includes(job.state)
      ) {
        if (!TERMINAL_JOB.includes(job.state))
          this.jobTransition(job, "superseded");
        t.put(key, job);
        return "superseded" as const;
      }
      try {
        await this.checkRecap(t, job, candidate);
      } catch {
        throw new InvalidProviderOutput("recap");
      }
      for (const stage of ["assembling", "synthesizing", "validating"])
        if (
          job.stages.at(-1) !== stage &&
          ["observing", "assembling", "synthesizing"].includes(job.state)
        )
          this.jobTransition(job, stage);
      t.put(key, job);
      const candidateKey = keys.candidate(owner, dayId, jobId);
      await t.get(candidateKey);
      t.put(candidateKey, candidate);
      await t.guard(keys.dayMeta(owner, dayId));
      return "saved" as const;
    });
    return outcome;
  }

  /** Pipeline step 4: conditional publication of the stored candidate. */
  async publishCandidate(
    owner: string,
    dayId: string,
    jobId: string,
  ): Promise<{ status: "published" | "superseded"; state: string | null }> {
    const candidate = (
      await this.store.get(keys.candidate(owner, dayId, jobId))
    )?.data as W.Recap | undefined;
    if (!candidate) return { status: "superseded", state: null };
    try {
      const day = await this.publish(
        await this.loadJob(owner, dayId, jobId),
        candidate,
      );
      return { status: "published", state: day.state };
    } catch (error) {
      if (error instanceof Fault && error.code === "SUPERSEDED")
        return { status: "superseded", state: null };
      throw error;
    }
  }

  /** Records a safe failure code. Only the current revision's day shows the failure. */
  async failJob(
    owner: string,
    dayId: string,
    jobId: string,
    code: string,
  ): Promise<void> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(code)) code = "PROCESSING_FAILED";
    await this.run(async (t) => {
      const key = keys.job(owner, dayId, jobId);
      const [meta, stored] = await Promise.all([
        t.get<DayMeta>(keys.dayMeta(owner, dayId)),
        t.get<Job>(key),
      ]);
      if (
        !stored ||
        !meta ||
        meta.day.inputRevision !== stored.day.inputRevision ||
        meta.day.deletionGeneration !== stored.day.deletionGeneration
      )
        return;
      meta.day.state = "failure";
      meta.day.failureCode = code;
      this.saveMeta(t, owner, meta);
      if (!TERMINAL_JOB.includes(stored.state)) {
        if (stored.state !== "failed_retryable")
          this.jobTransition(stored, "failed_retryable");
        stored.failureCode = code;
        t.put(key, stored);
      }
    });
  }

  async publish(job: Job, result: W.Recap): Promise<W.Day> {
    const owner = job.owner,
      dayId = job.day.dayId;
    const outcome = await this.run(async (t) => {
      const jobKey = keys.job(owner, dayId, job.id);
      const [meta, stored, accountTomb, dayTomb] = await Promise.all([
        t.get<DayMeta>(keys.dayMeta(owner, dayId)),
        t.get<Job>(jobKey),
        t.get(tomb(owner, ACCOUNT)),
        t.get(tomb(owner, { kind: "day", id: dayId })),
      ]);
      if (
        !meta ||
        accountTomb ||
        dayTomb ||
        meta.day.inputRevision !== job.day.inputRevision ||
        meta.day.deletionGeneration !== job.day.deletionGeneration
      ) {
        if (stored && !TERMINAL_JOB.includes(stored.state)) {
          this.jobTransition(stored, "superseded");
          t.put(jobKey, stored);
        }
        return "superseded" as const;
      }
      if (stored && ["ready", "partial"].includes(stored.state))
        return "published" as const;
      await this.checkRecap(t, job, result);
      if (stored) {
        if (stored.state === "failed_retryable")
          this.jobTransition(stored, "queued");
        const path = [
          "queued",
          "observing",
          "assembling",
          "synthesizing",
          "validating",
          "publishing",
        ];
        const position = path.indexOf(stored.state);
        if (position < 0) throw new Fault(409, "INVALID_STATE");
        for (const next of path.slice(position + 1))
          this.jobTransition(stored, next);
        this.jobTransition(stored, result.state);
        t.put(jobKey, stored);
      }
      await t.get(keys.recap(owner, dayId));
      t.put(keys.recap(owner, dayId), result);
      meta.recapRevisionCounter = result.recapRevision;
      meta.recapRevision = result.recapRevision;
      meta.day.state = result.state;
      meta.day.failureCode = null;
      this.saveMeta(t, owner, meta);
      // The notification exists only if this exact publication commits.
      this.enqueue(t, "recap.published", owner, dayId, result.recapRevision);
      await t.guard(tomb(owner, ACCOUNT));
      await t.guard(tomb(owner, { kind: "day", id: dayId }));
      return "published" as const;
    });
    if (outcome === "superseded") throw new Fault(409, "SUPERSEDED");
    return this.getDay({ owner, deviceId: null }, dayId);
  }

  /** Local, sequential driver over the same pipeline steps Step Functions runs. */
  async process(
    owner: string,
    dayId: string,
    observationProvider: ObservationProvider,
    recapProvider: RecapProvider,
    fail = false,
  ): Promise<W.Day> {
    const job = await this.prepareJob(owner, dayId);
    if (["ready", "partial"].includes(job.state))
      return this.getDay({ owner, deviceId: null }, dayId);
    try {
      const begun = await this.beginJob({
        owner,
        dayId,
        jobId: job.id,
        inputRevision: job.day.inputRevision,
      });
      if (begun.status === "superseded") throw new Fault(409, "SUPERSEDED");
      if (fail) throw new Error("Synthetic provider failure");
      for (const captureId of begun.captureIds)
        await this.observeCapture(
          owner,
          dayId,
          job.id,
          captureId,
          observationProvider,
        );
      const input = await this.synthesisInput(owner, dayId, job.id);
      const composed = await recapProvider.compose(
        input.job.day,
        input.observations,
        input.job.captures,
      );
      return await this.publish(input.job, {
        ...composed,
        recapRevision: input.job.nextRecapRevision,
      });
    } catch (error) {
      if (error instanceof Fault && error.code === "SUPERSEDED") throw error;
      await this.failJob(owner, dayId, job.id, "MOCK_PROCESSING_FAILED");
      throw new Fault(503, "INTERNAL_ERROR", true);
    }
  }
  /** Test and tool inspection of stored jobs for a day. */
  async listJobs(owner: string, dayId: string): Promise<Job[]> {
    return (
      await queryAll(this.store, {
        table: "journal",
        pk: keys.dayPartition(owner, dayId),
        prefix: "JOB#",
      })
    )
      .filter((row) => !row.sk.endsWith("#CANDIDATE"))
      .map((row) => row.data as Job);
  }

  // Deletion -----------------------------------------------------------------

  async delete(
    actor: Actor,
    target: DeletionTarget,
    tx?: Tx,
  ): Promise<W.DeletionJob> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      const owner = actor.owner;
      if (target.kind === "capture") {
        const [capture, deleted] = await Promise.all([
          t.get<CaptureRecord>(keys.capture(owner, target.id)),
          t.get(tomb(owner, target)),
        ]);
        if (!capture || deleted) throw new Fault(404, "NOT_FOUND");
        const meta = capture.dayId
          ? await t.get<DayMeta>(keys.dayMeta(owner, capture.dayId))
          : undefined;
        if (meta) {
          const dayId = meta.day.dayId;
          const remaining = (await this.dayCaptures(owner, dayId)).filter(
            (c) => c.captureId !== target.id,
          );
          const moment = momentID(target.id);
          const corrections = (
            await queryAll(this.store, {
              table: "journal",
              pk: keys.dayPartition(owner, dayId),
              prefix: "CORRECTION#",
            })
          ).filter(
            (row) =>
              (row.data as EditRecord<W.Correction>).value.momentId === moment,
          );
          for (const row of corrections) {
            await t.get(row);
            t.delete(row);
          }
          if (meta.recapRevision !== null) {
            await t.get(keys.recap(owner, dayId));
            t.delete(keys.recap(owner, dayId));
          }
          meta.day.deletionGeneration++;
          meta.day.inputRevision++;
          meta.recapRevision = null;
          meta.day.state = remaining.length ? "pending" : "empty";
          this.saveMeta(t, owner, meta);
          if (remaining.length)
            this.enqueue(
              t,
              "day.process",
              owner,
              dayId,
              meta.day.inputRevision,
            );
        }
      } else if (target.kind === "day") {
        const [meta, deleted] = await Promise.all([
          t.get<DayMeta>(keys.dayMeta(owner, target.id)),
          t.get(tomb(owner, target)),
        ]);
        if (!meta || deleted) throw new Fault(404, "NOT_FOUND");
        t.delete(keys.dayMeta(owner, target.id));
        if (meta.recapRevision !== null) {
          await t.get(keys.recap(owner, target.id));
          t.delete(keys.recap(owner, target.id));
        }
      }
      await t.get(tomb(owner, target));
      t.put(tomb(owner, target), { target, at: this.now() });
      const refs = await queryAll(this.store, {
        table: "accounts",
        pk: keys.userPartition(owner),
        prefix: keys.deviceRefPrefix,
      });
      const devices = await t.getMany<DeviceRecord>(
        refs.map((r) =>
          keys.identity((r.data as { deviceId: string }).deviceId),
        ),
      );
      const value: W.DeletionJob = {
        schemaVersion: 1,
        jobId: this.ids("deletion"),
        targetId: target.kind === "account" ? "account" : target.id,
        state: "deleting_cloud",
        revision: 3,
        cloudComplete: false,
        pendingDeviceIds: devices
          .filter((d): d is DeviceRecord => d?.owner === owner)
          .map((d) => d.identity.deviceId)
          .sort(),
      };
      t.put<DeletionRecord>(keys.deletion(value.jobId), {
        owner,
        value,
        target,
        createdAt: this.now(),
        receiptSk: t.receiptKey?.sk ?? null,
      });
      this.enqueue(t, "deletion.requested", owner, value.jobId, null);
      return value;
    });
  }

  /** Outbox work: remove cloud content for a tombstoned target. Idempotent and restartable. */
  async runDeletion(jobId: string): Promise<void> {
    const record = (await this.store.get(keys.deletion(jobId)))?.data as
      DeletionRecord | undefined;
    if (!record || record.value.state !== "deleting_cloud") return;
    const { owner, target } = record;
    const journal = (pk: string, prefix?: string) =>
      queryAll(this.store, { table: "journal", pk, prefix });
    const operations = (pk: string, prefix?: string) =>
      queryAll(this.store, { table: "operations", pk, prefix });
    let dayIds: string[] = [];
    let captureIds: string[] = [];
    if (target.kind === "capture") captureIds = [target.id];
    if (target.kind === "day") {
      dayIds = [target.id];
      captureIds = (
        await journal(keys.dayPartition(owner, target.id), "CAPTURE#")
      ).map((row) => (row.data as { value: W.Capture }).value.captureId);
      // Per-capture tombstones stop a re-sent ID from resurrecting under a changed date.
      for (let i = 0; i < captureIds.length; i += 90)
        await this.run(async (t) => {
          for (const id of captureIds.slice(i, i + 90)) {
            const key = tomb(owner, { kind: "capture", id });
            if (!(await t.get(key)))
              t.put(key, { target: { kind: "capture", id }, at: this.now() });
          }
        });
    }
    if (target.kind === "account") {
      dayIds = (
        await queryAll(this.store, {
          table: "journal",
          index: "gsi1",
          pk: keys.dayIndexPartition(owner),
        })
      ).map((row) => (row.data as DayMeta).day.dayId);
      captureIds = (await journal(keys.capturesPartition(owner), "CAP#")).map(
        (row) => (row.data as CaptureRecord).value.captureId,
      );
    }
    const captureGrants =
      target.kind === "account"
        ? await operations(keys.captureGrantPartition(owner))
        : (
            await Promise.all(
              captureIds.map((id) =>
                operations(keys.captureGrantPartition(owner), `${id}#`),
              ),
            )
          ).flat();
    const grants = captureGrants.map(
      (row) => row.data as { snapshotId: string; uploadId: string },
    );
    const snapshotIds = [...new Set(grants.map((g) => g.snapshotId))];
    if (target.kind === "account")
      await this.objects.removePrefix(ownerObjectPrefix(owner));
    else
      await this.objects.remove([
        ...grants.map((g) => objectKey(owner, g.snapshotId, g.uploadId)),
        ...snapshotIds.map((s) =>
          objectKey(owner, s, uploadIdFor(s, "manifest", null)),
        ),
      ]);
    for (const snapshotId of snapshotIds)
      await this.run(async (t) => {
        const snapshot = await t.get<SnapshotRecord>(keys.snapshot(snapshotId));
        if (!snapshot || snapshot.state === "invalidated") return;
        // Keep identity and grant metadata for rejection; drop receipts and capture metadata.
        t.put<SnapshotRecord>(keys.snapshot(snapshotId), {
          ...snapshot,
          state: "invalidated",
          receipt: null,
          accepted: [],
        });
      });
    const removals: Key[] = [];
    const captures = await new Tx(this.store).getMany<CaptureRecord>(
      captureIds.map((id) => keys.capture(owner, id)),
    );
    captureIds.forEach((id, index) => {
      removals.push(keys.capture(owner, id), keys.moment(owner, momentID(id)));
      const capture = captures[index];
      if (capture?.dayId)
        removals.push(
          keys.dayCapture(owner, capture.dayId, capture.value.capturedAt, id),
        );
    });
    if (target.kind === "capture") {
      const dayId = captures[0]?.dayId;
      if (dayId) {
        removals.push(
          ...(await journal(
            keys.dayPartition(owner, dayId),
            `OBS#${target.id}#`,
          )),
          ...(await journal(keys.dayPartition(owner, dayId), "JOB#")),
        );
      }
    }
    for (const dayId of dayIds)
      removals.push(...(await journal(keys.dayPartition(owner, dayId))));
    if (target.kind === "account") {
      removals.push(
        ...(await journal(keys.capturesPartition(owner))),
        keys.profile(owner),
      );
    }
    removals.push(...captureGrants);
    removals.push(
      ...(await operations(keys.receiptPartition(owner))).filter(
        (row) => row.sk !== record.receiptSk,
      ),
    );
    await this.store.deleteMany(removals);
    await this.run(async (t) => {
      const current = await t.get<DeletionRecord>(keys.deletion(jobId));
      if (!current || current.value.state !== "deleting_cloud") return;
      validate("Transition", {
        schemaVersion: 1,
        machine: "deletion",
        from: current.value.state,
        to: "waiting_for_clients",
        revision: current.value.revision,
        expectedRevision: current.value.revision,
      });
      current.value = {
        ...current.value,
        state: "waiting_for_clients",
        revision: current.value.revision + 1,
        cloudComplete: true,
      };
      t.put(keys.deletion(jobId), current);
    });
    this.log("deletion.cloud_complete", {
      kind: target.kind,
      captures: captureIds.length,
      items: removals.length,
    });
  }
  async deletion(actor: Actor, id: string, tx?: Tx): Promise<W.DeletionJob> {
    return this.unit(tx, async (t) => {
      if (actor.deviceId) throw new Fault(403, "FORBIDDEN");
      const record = await t.get<DeletionRecord>(keys.deletion(id));
      if (!record || record.owner !== actor.owner)
        throw new Fault(404, "NOT_FOUND");
      return record.value;
    });
  }

  // Lists --------------------------------------------------------------------

  private async window(
    actor: Actor,
    route: string,
    query: URLSearchParams,
    revision: string,
    total: number,
  ): Promise<{ offset: number; limit: number; nextCursor: string | null }> {
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Fault(400, "INVALID_REQUEST");
    const filters = [...query.entries()].filter(([k]) => k !== "cursor").sort();
    const scope = canonical([actor.owner, route, filters, limit]);
    let offset = 0;
    if (query.has("cursor")) {
      const handle = query.get("cursor")!;
      let cursor: CursorRecord | undefined;
      try {
        validate("Id", handle);
        cursor = (await this.store.get(keys.cursor(handle)))?.data as
          CursorRecord | undefined;
      } catch {
        cursor = undefined;
      }
      if (!cursor || cursor.scope !== scope)
        throw new Fault(400, "INVALID_REQUEST");
      if (cursor.revision !== revision) throw new Fault(409, "CONFLICT");
      offset = cursor.offset;
    }
    let nextCursor: string | null = null;
    if (offset + limit < total) {
      nextCursor = this.ids("cursor");
      const handle = nextCursor;
      await this.run(async (t) => {
        t.put<CursorRecord>(
          keys.cursor(handle),
          { scope, offset: offset + limit, revision },
          { ttl: epochSeconds(this.now()) + 86400 },
        );
      });
    }
    return { offset, limit, nextCursor };
  }
  async page<T>(
    actor: Actor,
    route: string,
    query: URLSearchParams,
    items: T[],
  ): Promise<{ schemaVersion: 1; items: T[]; nextCursor: string | null }> {
    await this.appActor(new Tx(this.store), actor);
    const w = await this.window(
      actor,
      route,
      query,
      digest(items),
      items.length,
    );
    return {
      schemaVersion: 1,
      items: items.slice(w.offset, w.offset + w.limit),
      nextCursor: w.nextCursor,
    };
  }
  async days(actor: Actor, query: URLSearchParams): Promise<W.Days> {
    const t = new Tx(this.store);
    await this.appActor(t, actor);
    for (const field of ["from", "to"])
      if (query.has(field)) {
        try {
          validate("Instant", query.get(field));
        } catch {
          throw new Fault(400, "INVALID_REQUEST");
        }
      }
    const from = query.get("from"),
      to = query.get("to");
    if (from && to && from >= to) throw new Fault(400, "INVALID_REQUEST");
    const metas = (
      await queryAll(this.store, {
        table: "journal",
        index: "gsi1",
        pk: keys.dayIndexPartition(actor.owner),
      })
    )
      .map((row) => row.data as DayMeta)
      .filter(
        (m) => (!from || m.day.startAt >= from) && (!to || m.day.startAt < to),
      )
      .sort((a, b) => b.day.startAt.localeCompare(a.day.startAt));
    const revision = digest(metas.map((m) => [m.day.dayId, m.contentRevision]));
    const w = await this.window(
      actor,
      "/v1/days",
      query,
      revision,
      metas.length,
    );
    const fresh = await t.getMany<DayMeta>(
      metas
        .slice(w.offset, w.offset + w.limit)
        .map((m) => keys.dayMeta(actor.owner, m.day.dayId)),
    );
    const items: W.Day[] = [];
    for (const meta of fresh)
      if (meta) items.push(await this.assembleDay(t, actor.owner, meta));
    return { schemaVersion: 1, items, nextCursor: w.nextCursor };
  }
  async devices(actor: Actor, query: URLSearchParams): Promise<W.Devices> {
    const t = new Tx(this.store);
    await this.appActor(t, actor);
    const refs = await queryAll(this.store, {
      table: "accounts",
      pk: keys.userPartition(actor.owner),
      prefix: keys.deviceRefPrefix,
    });
    const devices = await t.getMany<DeviceRecord>(
      refs.map((r) => keys.identity((r.data as { deviceId: string }).deviceId)),
    );
    return this.page(
      actor,
      "/v1/devices",
      query,
      devices
        .filter(
          (d): d is DeviceRecord =>
            d?.owner === actor.owner && d.identity.claimState === "owned",
        )
        .map((d) => d.identity),
    );
  }
  async device(actor: Actor, id: string): Promise<W.DeviceDetail> {
    const t = new Tx(this.store);
    await this.appActor(t, actor);
    const d = await this.authorizeDevice(actor, id, undefined, t);
    return {
      schemaVersion: 1,
      identity: d.identity,
      state: (await t.get<W.DeviceState>(keys.deviceState(id))) ?? null,
      activeSync: (await this.activeSync(id, t)) ?? null,
    };
  }

  /**
   * Printed-QR claim (D50). The sticker's one-time secret proves possession of an unclaimed device.
   * Wrong secrets and unknown devices look identical (404). A device owned by someone else is 409.
   * Re-scanning your own device is idempotent.
   */
  async claimDevice(
    actor: Actor,
    input: W.ClaimInput,
    tx?: Tx,
  ): Promise<W.Claim> {
    return this.unit(tx, async (t) => {
      await this.appActor(t, actor);
      const device = await t.get<DeviceRecord>(keys.identity(input.deviceId));
      const confirmed: W.Claim = {
        schemaVersion: 1,
        claimId: "claim_" + input.deviceId.slice(0, 89),
        deviceId: input.deviceId,
        state: "confirmed",
        expiresAt: this.now(),
      };
      if (device?.identity.claimState === "owned") {
        if (device.owner === actor.owner) return confirmed;
        throw new Fault(409, "CONFLICT");
      }
      const expected = device?.claimSecretHash;
      const presented = crypto
        .createHash("sha256")
        .update(input.challengeId)
        .digest();
      if (
        !device ||
        device.identity.claimState !== "unclaimed" ||
        typeof expected !== "string" ||
        expected.length !== 64 ||
        !crypto.timingSafeEqual(Buffer.from(expected, "hex"), presented)
      )
        throw new Fault(404, "NOT_FOUND");
      t.put<DeviceRecord>(keys.identity(input.deviceId), {
        owner: actor.owner,
        identity: { ...device.identity, claimState: "owned" },
        certificateId: device.certificateId,
        claimSecretHash: null,
      });
      t.put(keys.deviceRef(actor.owner, input.deviceId), {
        deviceId: input.deviceId,
      });
      return confirmed;
    });
  }

  /** Device-side status poll: its own identity (epoch, revisions) and any sync waiting for it. */
  async deviceStatus(actor: Actor): Promise<W.DeviceDetail> {
    const t = new Tx(this.store);
    if (!actor.deviceId) throw new Fault(403, "FORBIDDEN");
    const d = await this.authorizeDevice(actor, actor.deviceId, undefined, t);
    return {
      schemaVersion: 1,
      identity: d.identity,
      state:
        (await t.get<W.DeviceState>(keys.deviceState(actor.deviceId))) ?? null,
      activeSync: (await this.activeSync(actor.deviceId, t)) ?? null,
    };
  }

  /** Device state.report: last reported state only, never treated as a live reading. */
  async reportState(
    actor: Actor,
    state: W.DeviceState,
    tx?: Tx,
  ): Promise<W.DeviceState> {
    return this.unit(tx, async (t) => {
      await this.deviceActor(t, actor, state.deviceId, state.ownershipEpoch);
      const current = await t.get<W.DeviceState>(
        keys.deviceState(state.deviceId),
      );
      if (current && current.observedAt >= state.observedAt) return current;
      t.put(keys.deviceState(state.deviceId), state);
      return state;
    });
  }

  // Outbox -------------------------------------------------------------------

  private enqueue(
    tx: Tx,
    kind: OutboxKind,
    owner: string,
    ref: string,
    inputRevision: number | null,
  ): void {
    const id = outboxIdFor(kind, owner, ref, inputRevision ?? "");
    const createdAt = this.now();
    tx.put<OutboxRecord>(
      keys.outbox(id),
      {
        id,
        kind,
        owner,
        ref,
        inputRevision,
        createdAt,
        dispatchedAt: null,
        outcome: null,
      },
      {
        kind: "outbox",
        opk: keys.pendingOutboxPartition,
        osk: `${createdAt}#${id}`,
      },
    );
    if (
      this.dispatchMode === "inline" &&
      kind !== "day.process" &&
      kind !== "recap.published"
    )
      tx.afterCommit(async () => {
        try {
          await this.dispatch(id);
        } catch (error) {
          // The entry stays pending; recovery or the stream retries it.
          this.log("outbox.inline_failed", {
            kind,
            error: error instanceof Fault ? error.code : "internal",
          });
        }
      });
  }

  /** Performs one outbox entry. Safe to call repeatedly and concurrently. */
  async dispatch(id: string): Promise<"dispatched" | "skipped" | "pending"> {
    const record = (await this.store.get(keys.outbox(id)))?.data as
      OutboxRecord | undefined;
    if (!record || record.dispatchedAt) return "skipped";
    let outcome = "done";
    if (record.kind === "snapshot.accepted") await this.materialize(record.ref);
    else if (record.kind === "deletion.requested")
      await this.runDeletion(record.ref);
    else if (record.kind === "recap.published") {
      // P10 delivers the generic push; until a notifier exists the entry stays pending.
      if (!this.notifier) return "pending";
      await this.notifier.recapReady({
        owner: record.owner,
        dayId: record.ref,
        recapRevision: record.inputRevision ?? 0,
      });
    } else {
      const meta = (
        await this.store.get(keys.dayMeta(record.owner, record.ref))
      )?.data as DayMeta | undefined;
      if (!meta || meta.day.inputRevision !== record.inputRevision)
        outcome = "superseded";
      else if (!this.jobs) return "pending";
      else
        await this.jobs.start({
          jobId: jobIdFor(
            record.owner,
            record.ref,
            meta.day.inputRevision,
            this.pipeline,
          ),
          owner: record.owner,
          dayId: record.ref,
          inputRevision: meta.day.inputRevision,
        });
    }
    await this.run(async (t) => {
      const current = await t.get<OutboxRecord>(keys.outbox(id));
      if (!current || current.dispatchedAt) return;
      // Dropping opk/osk removes the entry from the sparse pending index.
      t.put<OutboxRecord>(
        keys.outbox(id),
        { ...current, dispatchedAt: this.now(), outcome },
        { kind: "outbox", ttl: epochSeconds(this.now()) + 30 * 86400 },
      );
    });
    return "dispatched";
  }

  /** Explicit, finite recovery for undispatched work. Never scheduled automatically. */
  async recover(limit = 100): Promise<{
    dispatched: number;
    pending: number;
    failed: Array<{ id: string; kind: string; error: string }>;
  }> {
    const page = await this.store.query({
      table: "operations",
      index: "pending",
      pk: keys.pendingOutboxPartition,
      limit,
    });
    const result = {
      dispatched: 0,
      pending: 0,
      failed: [] as Array<{ id: string; kind: string; error: string }>,
    };
    for (const item of page.items) {
      const record = item.data as OutboxRecord;
      try {
        const status = await this.dispatch(record.id);
        if (status === "dispatched") result.dispatched++;
        if (status === "pending") result.pending++;
      } catch (error) {
        result.failed.push({
          id: record.id,
          kind: record.kind,
          error: error instanceof Fault ? error.code : "INTERNAL_ERROR",
        });
      }
    }
    return result;
  }
}
