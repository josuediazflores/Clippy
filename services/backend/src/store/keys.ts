import type { Key } from "./store";

// Key layout. User content lives under USER#<owner> partitions so deletion can discover it
// by owner without scanning. Operational records (syncs, snapshots, grants, outbox,
// deletion ledger) are keyed by their own server-assigned IDs and hold no photo or text.
// Owner is the authenticated subject (Cognito `sub` in AWS, a synthetic ID locally).

const user = (owner: string) => `USER#${owner}`;

export const keys = {
  // Accounts
  profile: (owner: string): Key => ({
    table: "accounts",
    pk: user(owner),
    sk: "PROFILE",
  }),
  tombstone: (owner: string, targetId: string): Key => ({
    table: "accounts",
    pk: user(owner),
    sk: `TOMB#${targetId}`,
  }),
  deviceRef: (owner: string, deviceId: string): Key => ({
    table: "accounts",
    pk: user(owner),
    sk: `DEVICE#${deviceId}`,
  }),
  deviceRefPrefix: "DEVICE#",
  userPartition: user,

  // Devices
  identity: (deviceId: string): Key => ({
    table: "devices",
    pk: `DEVICE#${deviceId}`,
    sk: "IDENTITY",
  }),
  deviceState: (deviceId: string): Key => ({
    table: "devices",
    pk: `DEVICE#${deviceId}`,
    sk: "STATE",
  }),
  activeSync: (deviceId: string): Key => ({
    table: "devices",
    pk: `DEVICE#${deviceId}`,
    sk: "ACTIVE_SYNC",
  }),
  command: (deviceId: string, commandId: string): Key => ({
    table: "devices",
    pk: `DEVICE#${deviceId}`,
    sk: `ACK#${commandId}`,
  }),

  // Operations
  sync: (id: string): Key => ({
    table: "operations",
    pk: `SYNC#${id}`,
    sk: "SYNC",
  }),
  snapshot: (id: string): Key => ({
    table: "operations",
    pk: `SNAP#${id}`,
    sk: "SNAP",
  }),
  grant: (uploadId: string): Key => ({
    table: "operations",
    pk: `UPLOAD#${uploadId}`,
    sk: "GRANT",
  }),
  /** Which snapshots granted a capture, for deletion of bytes and manifests. */
  captureGrant: (owner: string, captureId: string, uploadId: string): Key => ({
    table: "operations",
    pk: `${user(owner)}#CAPGRANTS`,
    sk: `${captureId}#${uploadId}`,
  }),
  captureGrantPartition: (owner: string) => `${user(owner)}#CAPGRANTS`,
  receipt: (owner: string, scopeDigest: string): Key => ({
    table: "operations",
    pk: `${user(owner)}#RECEIPTS`,
    sk: scopeDigest,
  }),
  receiptPartition: (owner: string) => `${user(owner)}#RECEIPTS`,
  cursor: (id: string): Key => ({
    table: "operations",
    pk: `CURSOR#${id}`,
    sk: "CURSOR",
  }),
  deletion: (id: string): Key => ({
    table: "operations",
    pk: `DEL#${id}`,
    sk: "DEL",
  }),
  outbox: (id: string): Key => ({
    table: "operations",
    pk: `OUTBOX#${id}`,
    sk: "OUTBOX",
  }),
  pendingOutboxPartition: "PENDING",

  // Journal
  dayPartition: (owner: string, dayId: string) => `${user(owner)}#DAY#${dayId}`,
  dayIndexPartition: (owner: string) => `${user(owner)}#DAYS`,
  dayMeta: (owner: string, dayId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: "META",
  }),
  recap: (owner: string, dayId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: "RECAP",
  }),
  dayCapture: (
    owner: string,
    dayId: string,
    capturedAt: string,
    captureId: string,
  ): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `CAPTURE#${capturedAt}#${captureId}`,
  }),
  reflection: (owner: string, dayId: string, id: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `REFLECTION#${id}`,
  }),
  correction: (owner: string, dayId: string, id: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `CORRECTION#${id}`,
  }),
  applied: (owner: string, dayId: string, snapshotId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `APPLIED#${snapshotId}`,
  }),
  observation: (owner: string, dayId: string, cacheKey: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `OBS#${cacheKey}`,
  }),
  job: (owner: string, dayId: string, jobId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#DAY#${dayId}`,
    sk: `JOB#${jobId}`,
  }),
  capturesPartition: (owner: string) => `${user(owner)}#CAPTURES`,
  capture: (owner: string, captureId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#CAPTURES`,
    sk: `CAP#${captureId}`,
  }),
  moment: (owner: string, momentId: string): Key => ({
    table: "journal",
    pk: `${user(owner)}#CAPTURES`,
    sk: `MOMENT#${momentId}`,
  }),
};

/** S3 object keys are server-assigned. Owner prefix supports account-wide deletion. */
export const objectKey = (
  owner: string,
  snapshotId: string,
  uploadId: string,
): string => `u/${owner}/s/${snapshotId}/${uploadId}`;
export const ownerObjectPrefix = (owner: string): string => `u/${owner}/`;
