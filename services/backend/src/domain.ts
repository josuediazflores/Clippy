import { momentID } from "./identity";
import type * as W from "./Wire";
import type {
  JournalStore,
  ObjectStore,
  ObservationProvider,
  RecapProvider,
} from "./ports";
import { canonical, decode, digest, sha256, validate } from "./contracts";

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
interface BoundDevice {
  owner: string;
  identity: W.DeviceIdentity;
  state: W.DeviceState;
}
interface BoundSync {
  owner: string;
  value: W.SyncRequest;
}
interface StoredSnapshot {
  owner: string;
  begin: W.BeginSync;
  value: W.Snapshot;
  grantIds: string[];
  receipt?: W.Receipt;
  invalidated?: boolean;
}
interface StoredGrant {
  owner: string;
  deviceId: string;
  epoch: number;
  snapshotId: string;
  item: W.GrantItem;
  expiresAt: string;
}
interface StoredCapture {
  owner: string;
  value: W.Capture;
  uploadId: string;
  dayId: string | null;
}
interface StoredReceipt {
  owner: string;
  digest: string;
  status: number;
  body: unknown;
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
}
interface Cursor {
  scope: string;
  offset: number;
  revision: string;
}
export interface LocalState {
  counter: number;
  recapRevisions: Record<string, number>;
  devices: Record<string, BoundDevice>;
  syncs: Record<string, BoundSync>;
  snapshots: Record<string, StoredSnapshot>;
  grants: Record<string, StoredGrant>;
  captures: Record<string, StoredCapture>;
  days: Record<string, W.Day>;
  observations: Record<string, W.Observation>;
  jobs: Record<string, Job>;
  receipts: Record<string, StoredReceipt>;
  tombstones: Record<string, boolean>;
  deletions: Record<string, { owner: string; value: W.DeletionJob }>;
  cursors: Record<string, Cursor>;
}
export const FIXED_NOW = "2026-11-07T20:00:00Z";
const key = (owner: string, id: string): string => `${owner}/${id}`;
export function initialState(): LocalState {
  const devices: Record<string, BoundDevice> = {};
  for (const [suffix, owner] of [
    ["001", "user_a"],
    ["002", "user_b"],
  ]) {
    const deviceId = `dev_sample_${suffix}`;
    devices[deviceId] = {
      owner: owner!,
      identity: {
        schemaVersion: 1,
        deviceId,
        ownershipEpoch: 1,
        protocolVersion: 1,
        firmwareVersion: "simulator-1",
        claimState: "owned",
        configurationRevision: 1,
        appliedRevision: 1,
      },
      state: {
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
      },
    };
  }
  return {
    counter: 0,
    recapRevisions: {},
    devices,
    syncs: {},
    snapshots: {},
    grants: {},
    captures: {},
    days: {},
    observations: {},
    jobs: {},
    receipts: {},
    tombstones: {},
    deletions: {},
    cursors: {},
  };
}
export class Engine {
  state: LocalState;
  constructor(
    readonly store: JournalStore<LocalState>,
    readonly objects: ObjectStore,
    readonly now: () => string = () => FIXED_NOW,
  ) {
    this.state = store.load();
    this.state.recapRevisions ??= {};
  }
  private id(prefix: string): string {
    return `${prefix}_${String(++this.state.counter).padStart(6, "0")}`;
  }
  flush(): void {
    this.store.commit(this.state);
  }
  private assertLive(owner: string, id?: string): void {
    if (
      this.state.tombstones[key(owner, "account")] ||
      (id && this.state.tombstones[key(owner, id)])
    )
      throw new Fault(410, "DELETED");
  }
  authorizeDevice(actor: Actor, deviceId: string, epoch?: number): BoundDevice {
    this.assertLive(actor.owner);
    const device = this.state.devices[deviceId];
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
    return device;
  }
  private deviceActor(
    actor: Actor,
    deviceId: string,
    epoch: number,
  ): BoundDevice {
    if (!actor.deviceId || actor.deviceId !== deviceId)
      throw new Fault(403, "FORBIDDEN");
    return this.authorizeDevice(actor, deviceId, epoch);
  }
  private appActor(actor: Actor): void {
    this.assertLive(actor.owner);
    if (actor.deviceId) throw new Fault(403, "FORBIDDEN");
  }
  private snapshot(actor: Actor, id: string): StoredSnapshot {
    const snapshot = this.state.snapshots[id];
    if (!snapshot || snapshot.owner !== actor.owner)
      throw new Fault(404, "NOT_FOUND");
    this.deviceActor(
      actor,
      snapshot.value.deviceId,
      snapshot.value.ownershipEpoch,
    );
    if (snapshot.invalidated) throw new Fault(410, "DELETED");
    return snapshot;
  }
  mutate<T>(
    actor: Actor,
    method: string,
    route: string,
    operation: string,
    payload: unknown,
    status: number,
    fn: () => T,
  ): { status: number; body: T } {
    this.assertLive(actor.owner);
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
    const hash = digest(payload);
    const prior = this.state.receipts[scope];
    if (prior) {
      if (prior.digest !== hash) throw new Fault(409, "CONFLICT");
      return { status: prior.status, body: structuredClone(prior.body) as T };
    }
    const before = structuredClone(this.state);
    try {
      const body = structuredClone(fn());
      this.state.receipts[scope] = {
        owner: actor.owner,
        digest: hash,
        status,
        body,
      };
      this.flush();
      return { status, body };
    } catch (error) {
      this.state = before;
      throw error;
    }
  }
  requestSync(actor: Actor, deviceId: string): W.SyncRequest {
    this.appActor(actor);
    this.authorizeDevice(actor, deviceId);
    const active = this.activeSync(deviceId);
    if (active) return active;
    return this.createSync(actor.owner, deviceId, "manual");
  }
  activeSync(deviceId: string): W.SyncRequest | undefined {
    return Object.values(this.state.syncs)
      .map((s) => s.value)
      .find(
        (s) =>
          s.deviceId === deviceId &&
          !["uploaded", "cancelled", "failed_terminal"].includes(s.state) &&
          (s.state !== "waiting_for_device" || s.expiresAt > this.now()),
      );
  }
  private createSync(
    owner: string,
    deviceId: string,
    trigger: "manual" | "nightly",
  ): W.SyncRequest {
    const value: W.SyncRequest = {
      schemaVersion: 1,
      syncRequestId: this.id("sync"),
      deviceId,
      ownershipEpoch: this.state.devices[deviceId]!.identity.ownershipEpoch,
      trigger,
      state: "waiting_for_device",
      revision: 1,
      createdAt: this.now(),
      expiresAt: this.expiry(300),
    };
    this.state.syncs[value.syncRequestId] = { owner, value };
    return value;
  }
  getSync(actor: Actor, id: string): W.SyncRequest {
    this.appActor(actor);
    const sync = this.state.syncs[id];
    if (!sync || sync.owner !== actor.owner) throw new Fault(404, "NOT_FOUND");
    this.authorizeDevice(actor, sync.value.deviceId);
    return structuredClone(sync.value);
  }
  cancelSync(actor: Actor, id: string): W.SyncRequest {
    const sync = this.getSync(actor, id);
    if (sync.state === "uploaded" || sync.state === "cancelled") return sync;
    this.transitionSync(id, "cancel_requested");
    this.transitionSync(id, "cancelled");
    return this.state.syncs[id]!.value;
  }
  private transitionSync(id: string, to: W.SyncRequest["state"]): void {
    const s = this.state.syncs[id]!.value;
    validate("Transition", {
      schemaVersion: 1,
      machine: "sync",
      from: s.state,
      to,
      revision: s.revision,
      expectedRevision: s.revision,
    });
    s.state = to;
    s.revision++;
  }
  begin(actor: Actor, input: W.BeginSync): W.Snapshot {
    const device = this.deviceActor(
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
    let sync = input.syncRequestId
      ? this.state.syncs[input.syncRequestId]?.value
      : this.activeSync(input.deviceId);
    if (
      input.syncRequestId &&
      (!sync ||
        this.state.syncs[input.syncRequestId]?.owner !== actor.owner ||
        sync.deviceId !== input.deviceId)
    )
      throw new Fault(404, "NOT_FOUND");
    if (
      sync &&
      (sync.state !== "waiting_for_device" || sync.trigger !== input.trigger)
    )
      throw new Fault(409, "CONFLICT");
    if (sync && sync.expiresAt <= this.now()) throw new Fault(410, "EXPIRED");
    sync ??= this.createSync(actor.owner, input.deviceId, input.trigger);
    this.transitionSync(sync.syncRequestId, "preparing");
    const value: W.Snapshot = {
      schemaVersion: 1,
      snapshotId: this.id("snap"),
      syncRequestId: sync.syncRequestId,
      deviceId: input.deviceId,
      ownershipEpoch: input.ownershipEpoch,
    };
    this.state.snapshots[value.snapshotId] = {
      owner: actor.owner,
      begin: input,
      value,
      grantIds: [],
    };
    this.transitionSync(sync.syncRequestId, "uploading");
    return value;
  }
  expiry(seconds: number): string {
    return new Date(Date.parse(this.now()) + seconds * 1000)
      .toISOString()
      .replace(".000Z", "Z");
  }
  grants(
    actor: Actor,
    snapshotId: string,
    input: W.GrantRequest,
    baseURL: string,
  ): W.UploadGrants {
    const snapshot = this.snapshot(actor, snapshotId);
    this.deviceActor(actor, input.deviceId, input.ownershipEpoch);
    if (
      input.deviceId !== snapshot.value.deviceId ||
      this.state.syncs[snapshot.value.syncRequestId]!.value.state !==
        "uploading"
    )
      throw new Fault(409, "INVALID_STATE");
    const items = input.items.map((item) => {
      if (
        (item.kind === "manifest") !== (item.captureId === null) ||
        (item.kind === "manifest") !==
          (item.contentType === "application/json") ||
        (item.kind === "manifest" && item.byteLength > 1000000)
      )
        throw new Fault(400, "INVALID_REQUEST");
      const existing = snapshot.grantIds.find(
        (id) =>
          this.state.grants[id]!.item.kind === item.kind &&
          this.state.grants[id]!.item.captureId === item.captureId,
      );
      if (
        existing &&
        canonical(this.state.grants[existing]!.item) !== canonical(item)
      )
        throw new Fault(409, "CONFLICT");
      if (item.captureId) {
        const capture = this.state.captures[key(actor.owner, item.captureId)];
        if (
          capture &&
          (capture.value.sha256 !== item.sha256 ||
            capture.value.byteLength !== item.byteLength ||
            capture.value.contentType !== item.contentType)
        )
          throw new Fault(409, "CONFLICT");
      }
      const uploadId = existing ?? this.id("upload");
      this.state.grants[uploadId] = {
        owner: actor.owner,
        deviceId: input.deviceId,
        epoch: input.ownershipEpoch,
        snapshotId,
        item,
        expiresAt: this.expiry(900),
      };
      if (!existing) snapshot.grantIds.push(uploadId);
      return {
        schemaVersion: 1 as const,
        uploadId,
        kind: item.kind,
        captureId: item.captureId,
        putURL: `${baseURL}/local/uploads/${uploadId}`,
        expiresAt: this.state.grants[uploadId]!.expiresAt,
        requiredHeaders: {
          "If-None-Match": "*" as const,
          "X-Clippy-SHA256": item.sha256,
          "Content-Type": item.contentType,
        },
      };
    });
    return { schemaVersion: 1, items };
  }
  put(
    actor: Actor,
    uploadId: string,
    bytes: Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): void {
    const grant = this.state.grants[uploadId];
    if (!grant || grant.owner !== actor.owner)
      throw new Fault(404, "NOT_FOUND");
    this.deviceActor(actor, grant.deviceId, grant.epoch);
    this.snapshot(actor, grant.snapshotId);
    if (grant.item.captureId)
      this.assertLive(actor.owner, grant.item.captureId);
    if (grant.expiresAt <= this.now()) throw new Fault(410, "EXPIRED");
    if (
      headers["if-none-match"] !== "*" ||
      headers["x-clippy-sha256"] !== grant.item.sha256 ||
      headers["content-type"] !== grant.item.contentType
    )
      throw new Fault(400, "INVALID_REQUEST");
    if (this.objects.get(uploadId)) throw new Fault(412, "PRECONDITION_FAILED");
    if (bytes.length !== grant.item.byteLength)
      throw new Fault(422, "SIZE_MISMATCH");
    if (sha256(bytes) !== grant.item.sha256)
      throw new Fault(422, "CHECKSUM_MISMATCH");
    this.objects.put(uploadId, bytes);
  }
  checkSnapshotAccess(actor: Actor, id: string): void {
    this.snapshot(actor, id);
  }
  complete(actor: Actor, snapshotId: string, input: W.CompleteSync): W.Receipt {
    const snapshot = this.snapshot(actor, snapshotId);
    this.deviceActor(actor, input.deviceId, input.ownershipEpoch);
    if (snapshot.receipt) {
      const grant = this.state.grants[input.manifestUploadId];
      if (
        !grant ||
        grant.snapshotId !== snapshotId ||
        grant.item.sha256 !== input.manifestSHA256
      )
        throw new Fault(409, "CONFLICT");
      return snapshot.receipt;
    }
    if (
      this.state.syncs[snapshot.value.syncRequestId]!.value.state !==
      "uploading"
    )
      throw new Fault(409, "INVALID_STATE");
    const grant = this.state.grants[input.manifestUploadId];
    if (
      !grant ||
      grant.snapshotId !== snapshotId ||
      grant.item.kind !== "manifest" ||
      grant.item.sha256 !== input.manifestSHA256
    )
      throw new Fault(422, "INVALID_MANIFEST");
    const bytes = this.verifiedObject(input.manifestUploadId, grant.item);
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
    const accepted: string[] = [],
      suppressed: string[] = [],
      dayIds = new Set<string>();
    const pending: Array<{
      capture: W.Capture;
      uploadId: string;
      dayId: string | null;
    }> = [];
    for (const entry of manifest.captures) {
      const { uploadId, ...capture } = entry;
      const itemGrant = this.state.grants[uploadId];
      if (
        !itemGrant ||
        itemGrant.snapshotId !== snapshotId ||
        itemGrant.item.captureId !== capture.captureId ||
        itemGrant.item.kind !== "capture" ||
        itemGrant.item.sha256 !== capture.sha256 ||
        itemGrant.item.byteLength !== capture.byteLength ||
        itemGrant.item.contentType !== capture.contentType
      )
        throw new Fault(422, "INVALID_MANIFEST");
      const dayId =
        capture.clockQuality === "untrusted"
          ? null
          : "day_" + capture.capturedAt.slice(0, 10).replaceAll("-", "");
      if (
        this.state.tombstones[key(actor.owner, capture.captureId)] ||
        (dayId && this.state.tombstones[key(actor.owner, dayId)])
      ) {
        suppressed.push(capture.captureId);
        continue;
      }
      this.verifiedObject(uploadId, itemGrant.item);
      const prior = this.state.captures[key(actor.owner, capture.captureId)];
      if (prior && canonical(prior.value) !== canonical(capture))
        throw new Fault(409, "CONFLICT");
      if (!prior) pending.push({ capture, uploadId, dayId });
      accepted.push(capture.captureId);
      if (dayId) dayIds.add(dayId);
    }
    this.transitionSync(snapshot.value.syncRequestId, "verifying");
    const changedDays = new Set<string>();
    for (const { capture, uploadId, dayId } of pending) {
      this.state.captures[key(actor.owner, capture.captureId)] = {
        owner: actor.owner,
        value: capture,
        uploadId,
        dayId,
      };
      if (dayId) changedDays.add(dayId);
    }
    for (const dayId of changedDays) {
      const day =
        this.state.days[key(actor.owner, dayId)] ?? this.emptyDay(dayId);
      day.inputRevision++;
      day.state = "pending";
      day.failureCode = null;
      this.state.days[key(actor.owner, dayId)] = day;
    }
    this.transitionSync(snapshot.value.syncRequestId, "uploaded");
    // Suppressed content must not remain as an orphan after a deleted capture is retried.
    for (const entry of manifest.captures)
      if (suppressed.includes(entry.captureId))
        this.objects.remove(entry.uploadId);
    if (suppressed.length) this.objects.remove(input.manifestUploadId);
    snapshot.receipt = {
      schemaVersion: 1,
      snapshotId,
      syncRequestId: snapshot.value.syncRequestId,
      acceptedCaptureIds: accepted.sort(),
      suppressedCaptureIds: suppressed.sort(),
      effectiveDigest: sha256(accepted.sort().join("\n")),
      verifiedAt: this.now(),
      dayIds: [...dayIds].sort(),
    };
    return snapshot.receipt;
  }
  private verifiedObject(id: string, item: W.GrantItem): Uint8Array {
    const bytes = this.objects.get(id);
    if (!bytes) throw new Fault(503, "MISSING_OBJECTS", true, undefined, [id]);
    if (bytes.length !== item.byteLength)
      throw new Fault(422, "SIZE_MISMATCH", false, undefined, [id]);
    if (sha256(bytes) !== item.sha256)
      throw new Fault(422, "CHECKSUM_MISMATCH", false, undefined, [id]);
    return bytes;
  }
  private emptyDay(id: string): W.Day {
    if (!/^day_\d{8}$/.test(id)) throw new Fault(404, "NOT_FOUND");
    const date = `${id.slice(4, 8)}-${id.slice(8, 10)}-${id.slice(10, 12)}T00:00:00Z`;
    if (
      !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10)
    )
      throw new Fault(404, "NOT_FOUND");
    return {
      schemaVersion: 1,
      dayId: id,
      timeZone: "UTC",
      startAt: date,
      endAt: new Date(Date.parse(date) + 86400000)
        .toISOString()
        .replace(".000Z", "Z"),
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
  getDay(actor: Actor, id: string): W.Day {
    this.appActor(actor);
    this.assertLive(actor.owner, id);
    return structuredClone(
      this.state.days[key(actor.owner, id)] ?? this.emptyDay(id),
    );
  }
  private ownedDay(actor: Actor, id: string): W.Day {
    this.appActor(actor);
    this.assertLive(actor.owner, id);
    const day = this.state.days[key(actor.owner, id)];
    if (!day) throw new Fault(404, "NOT_FOUND");
    return day;
  }
  saveEdit(
    actor: Actor,
    kind: "reflection" | "correction",
    target: string,
    id: string,
    edit: W.EditInput,
  ): W.Reflection | W.Correction {
    const day =
      kind === "reflection"
        ? this.ownedDay(actor, target)
        : this.dayForMoment(actor, target);
    const records = kind === "reflection" ? day.reflections : day.corrections;
    const current = records.find((r) => r.recordId === id);
    if (
      kind === "correction" &&
      current &&
      (current as W.Correction).momentId !== target
    )
      throw new Fault(409, "CONFLICT");
    if ((current?.revision ?? 0) !== edit.expectedRevision)
      throw new Fault(409, "REVISION_CONFLICT", false, current?.revision ?? 0);
    const record: W.Reflection | W.Correction = {
      schemaVersion: 1,
      operationId: edit.operationId,
      recordId: id,
      dayId: day.dayId,
      revision: (current?.revision ?? 0) + 1,
      text: edit.deleted ? "" : edit.text,
      deleted: edit.deleted,
      updatedAt: this.now(),
      ...(kind === "correction" ? { momentId: target } : {}),
    };
    if (kind === "reflection")
      day.reflections = [
        ...day.reflections.filter((r) => r.recordId !== id),
        record as W.Reflection,
      ];
    else {
      day.corrections = [
        ...day.corrections.filter((r) => r.recordId !== id),
        record as W.Correction,
      ];
      day.inputRevision++;
      day.state = "pending";
    }
    return record;
  }
  dayForMoment(actor: Actor, id: string): W.Day {
    this.appActor(actor);
    const capture = Object.values(this.state.captures).find(
      (c) => c.owner === actor.owner && momentID(c.value.captureId) === id,
    );
    if (!id.startsWith("moment_") || !capture?.dayId)
      throw new Fault(404, "NOT_FOUND");
    this.assertLive(actor.owner, capture.value.captureId);
    return this.ownedDay(actor, capture.dayId);
  }
  prepareJob(owner: string, dayId: string): Job {
    const day = this.ownedDay({ owner, deviceId: null }, dayId);
    const id = `job_${owner}_${dayId}_${day.inputRevision}_mock_1`;
    const prior = this.state.jobs[id];
    if (prior) return structuredClone(prior);
    const captures = Object.values(this.state.captures)
      .filter(
        (c) =>
          c.owner === owner &&
          c.dayId === dayId &&
          !this.state.tombstones[key(owner, c.value.captureId)],
      )
      .map((c) => c.value);
    const job: Job = {
      id,
      owner,
      day: structuredClone(day),
      captures: structuredClone(captures),
      state: "queued",
      revision: 1,
      stages: ["queued"],
      nextRecapRevision:
        (this.state.recapRevisions[key(owner, dayId)] ??
          day.recap?.recapRevision ??
          0) + 1,
    };
    this.state.jobs[id] = structuredClone(job);
    this.flush();
    return job;
  }
  private jobTransition(id: string, to: string): void {
    const job = this.state.jobs[id]!;
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
  publish(job: Job, result: W.Recap): W.Day {
    const day = this.state.days[key(job.owner, job.day.dayId)];
    if (
      !day ||
      this.state.tombstones[key(job.owner, "account")] ||
      this.state.tombstones[key(job.owner, job.day.dayId)] ||
      day.inputRevision !== job.day.inputRevision ||
      day.deletionGeneration !== job.day.deletionGeneration
    ) {
      const obsolete = this.state.jobs[job.id];
      if (
        obsolete &&
        ![
          "ready",
          "partial",
          "superseded",
          "cancelled_by_deletion",
          "failed_terminal",
        ].includes(obsolete.state)
      )
        this.jobTransition(job.id, "superseded");
      this.flush();
      throw new Fault(409, "SUPERSEDED");
    }
    const stored = this.state.jobs[job.id];
    if (stored && ["ready", "partial"].includes(stored.state))
      return structuredClone(day);
    try {
      validate("Recap", result);
    } catch {
      throw new Fault(422, "INVALID_REQUEST");
    }
    const sources = new Set(job.captures.map((c) => c.captureId));
    if (
      result.dayId !== day.dayId ||
      result.inputRevision !== day.inputRevision ||
      result.deletionGeneration !== day.deletionGeneration ||
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
              this.state.tombstones[key(job.owner, e.id)],
          ),
      ) ||
      result.coverage.captured !== job.captures.length ||
      result.coverage.observed !== result.moments.length ||
      result.coverage.missing !== job.captures.length - result.moments.length
    )
      throw new Fault(422, "INVALID_REQUEST");
    if (stored) {
      if (stored.state === "failed_retryable")
        this.jobTransition(job.id, "queued");
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
        this.jobTransition(job.id, next);
      this.jobTransition(job.id, result.state);
    }
    this.state.recapRevisions[key(job.owner, day.dayId)] = result.recapRevision;
    day.recap = structuredClone(result);
    day.state = result.state;
    day.failureCode = null;
    this.flush();
    return structuredClone(day);
  }
  process(
    owner: string,
    dayId: string,
    observationProvider: ObservationProvider,
    recapProvider: RecapProvider,
    fail = false,
  ): W.Day {
    const job = this.prepareJob(owner, dayId);
    if (["ready", "partial"].includes(job.state))
      return this.getDay({ owner, deviceId: null }, dayId);
    try {
      if (this.state.jobs[job.id]!.state === "failed_retryable")
        this.jobTransition(job.id, "queued");
      this.jobTransition(job.id, "observing");
      if (fail) throw new Error("Synthetic provider failure");
      const observations = job.captures.map((c) => {
        const cacheKey = key(owner, `${c.captureId}_${c.sha256}_mock_1`);
        const observation =
          this.state.observations[cacheKey] ?? observationProvider.observe(c);
        validate("Observation", observation);
        if (
          observation.captureId !== c.captureId ||
          observation.evidence.some(
            (e) => e.type !== "capture" || e.id !== c.captureId,
          )
        )
          throw new Error("Invented evidence");
        if (observation.status === "ready")
          this.state.observations[cacheKey] = observation;
        return observation;
      });
      return this.publish(job, {
        ...recapProvider.compose(job.day, observations, job.captures),
        recapRevision: job.nextRecapRevision,
      });
    } catch (error) {
      if (error instanceof Fault && error.code === "SUPERSEDED") throw error;
      const day = this.state.days[key(owner, dayId)];
      if (
        day &&
        day.inputRevision === job.day.inputRevision &&
        day.deletionGeneration === job.day.deletionGeneration
      ) {
        day.state = "failure";
        day.failureCode = "MOCK_PROCESSING_FAILED";
        this.jobTransition(job.id, "failed_retryable");
        this.flush();
      }
      throw new Fault(503, "INTERNAL_ERROR", true);
    }
  }
  delete(actor: Actor, target: string): W.DeletionJob {
    this.appActor(actor);
    if (
      target !== "account" &&
      !this.state.captures[key(actor.owner, target)] &&
      !this.state.days[key(actor.owner, target)]
    )
      throw new Fault(404, "NOT_FOUND");
    const captureIds = Object.values(this.state.captures)
      .filter(
        (c) =>
          c.owner === actor.owner &&
          (target === "account" ||
            c.value.captureId === target ||
            c.dayId === target),
      )
      .map((c) => c.value.captureId);
    const affected = new Set<string>();
    this.state.tombstones[key(actor.owner, target)] = true;
    for (const id of captureIds) {
      this.state.tombstones[key(actor.owner, id)] = true;
      const stored = this.state.captures[key(actor.owner, id)]!;
      if (stored.dayId) affected.add(stored.dayId);
      delete this.state.captures[key(actor.owner, id)];
    }
    for (const [id, snapshot] of Object.entries(this.state.snapshots)) {
      if (
        snapshot.owner === actor.owner &&
        (target === "account" ||
          snapshot.grantIds.some((g) =>
            captureIds.includes(this.state.grants[g]!.item.captureId ?? ""),
          ))
      ) {
        snapshot.invalidated = true;
        delete snapshot.receipt;
        for (const g of snapshot.grantIds) {
          const item = this.state.grants[g]!.item;
          if (
            target === "account" ||
            item.kind === "manifest" ||
            captureIds.includes(item.captureId ?? "")
          )
            this.objects.remove(g);
        }
        // Keep only identity and grant metadata for tombstone/expiry rejection, never manifest bytes.
        void id;
      }
    }
    for (const id of Object.keys(this.state.observations))
      if (id.startsWith(actor.owner + "/")) delete this.state.observations[id];
    for (const id of Object.keys(this.state.receipts))
      if (this.state.receipts[id]!.owner === actor.owner)
        delete this.state.receipts[id];
    for (const id of Object.keys(this.state.jobs))
      if (this.state.jobs[id]!.owner === actor.owner)
        delete this.state.jobs[id];
    for (const id of affected) {
      const day = this.state.days[key(actor.owner, id)]!;
      if (target === "account" || target === id) {
        delete this.state.days[key(actor.owner, id)];
        this.state.tombstones[key(actor.owner, id)] = true;
      } else {
        day.deletionGeneration++;
        day.inputRevision++;
        day.recap = null;
        day.corrections = day.corrections.filter(
          (c) => !captureIds.map(momentID).includes(c.momentId),
        );
        day.state = Object.values(this.state.captures).some(
          (c) => c.owner === actor.owner && c.dayId === id,
        )
          ? "pending"
          : "empty";
      }
    }
    const pendingDeviceIds = Object.values(this.state.devices)
      .filter((d) => d.owner === actor.owner)
      .map((d) => d.identity.deviceId);
    const value: W.DeletionJob = {
      schemaVersion: 1,
      jobId: this.id("deletion"),
      targetId: target,
      state: "waiting_for_clients",
      revision: 4,
      cloudComplete: true,
      pendingDeviceIds,
    };
    this.state.deletions[value.jobId] = { owner: actor.owner, value };
    return value;
  }
  deletion(actor: Actor, id: string): W.DeletionJob {
    if (actor.deviceId) throw new Fault(403, "FORBIDDEN");
    const record = this.state.deletions[id];
    if (!record || record.owner !== actor.owner)
      throw new Fault(404, "NOT_FOUND");
    return record.value;
  }
  page<T>(
    actor: Actor,
    route: string,
    query: URLSearchParams,
    items: T[],
  ): { schemaVersion: 1; items: T[]; nextCursor: string | null } {
    this.appActor(actor);
    const limit = Number(query.get("limit") ?? 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Fault(400, "INVALID_REQUEST");
    const filters = [...query.entries()].filter(([k]) => k !== "cursor").sort();
    const scope = canonical([actor.owner, route, filters, limit]),
      revision = digest(items);
    let offset = 0;
    if (query.has("cursor")) {
      const cursor = this.state.cursors[query.get("cursor")!];
      if (!cursor || cursor.scope !== scope)
        throw new Fault(400, "INVALID_REQUEST");
      if (cursor.revision !== revision) throw new Fault(409, "CONFLICT");
      offset = cursor.offset;
    }
    let nextCursor: string | null = null;
    if (offset + limit < items.length) {
      nextCursor = this.id("cursor");
      this.state.cursors[nextCursor] = {
        scope,
        offset: offset + limit,
        revision,
      };
      this.flush();
    }
    return {
      schemaVersion: 1,
      items: items.slice(offset, offset + limit),
      nextCursor,
    };
  }
  days(actor: Actor, query: URLSearchParams): W.Days {
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
    const items = Object.entries(this.state.days)
      .filter(
        ([k, d]) =>
          k.startsWith(actor.owner + "/") &&
          (!from || d.startAt >= from) &&
          (!to || d.startAt < to),
      )
      .map(([, d]) => d)
      .sort((a, b) => b.startAt.localeCompare(a.startAt));
    return this.page(actor, "/v1/days", query, items);
  }
  devices(actor: Actor, query: URLSearchParams): W.Devices {
    return this.page(
      actor,
      "/v1/devices",
      query,
      Object.values(this.state.devices)
        .filter(
          (d) => d.owner === actor.owner && d.identity.claimState === "owned",
        )
        .map((d) => d.identity),
    );
  }
  device(actor: Actor, id: string): W.DeviceDetail {
    this.appActor(actor);
    const d = this.authorizeDevice(actor, id);
    return {
      schemaVersion: 1,
      identity: d.identity,
      state: d.state,
      activeSync: this.activeSync(id) ?? null,
    };
  }
}
