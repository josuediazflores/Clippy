import type { Day, Capture, Observation, Recap, GrantItem } from "./Wire";

export interface ObjectHead {
  readonly byteLength: number;
  /** Lowercase hex SHA-256 when the store already verified a full-object checksum. */
  readonly sha256?: string;
}

/** Private media storage. Keys are server-assigned; clients never choose them. */
export interface ObjectStore {
  head(key: string): Promise<ObjectHead | undefined>;
  /** Reads at most maxBytes + 1 bytes so oversized objects are detectable without full download. */
  read(key: string, maxBytes: number): Promise<Uint8Array | undefined>;
  remove(keys: readonly string[]): Promise<void>;
  removePrefix(prefix: string): Promise<void>;
}

/** Local-only byte ingestion. In AWS, S3 receives the PUT directly. */
export interface WritableObjectStore extends ObjectStore {
  putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean>;
}

export interface SignedPut {
  readonly putURL: string;
}

/** Issues short-lived URLs bound to exact keys and headers. Signed URLs are never persisted. */
export interface GrantSigner {
  signPut(input: {
    key: string;
    uploadId: string;
    item: GrantItem;
    expiresAt: string;
    now: string;
    origin?: string;
  }): Promise<SignedPut>;
  signGet(input: {
    key: string;
    uploadId: string;
    expiresAt: string;
    now: string;
    origin?: string;
  }): Promise<string>;
}

/** Starts durable processing for a day revision. Must be idempotent by jobId. */
export interface JobStarter {
  start(input: {
    jobId: string;
    owner: string;
    dayId: string;
    inputRevision: number;
  }): Promise<void>;
}

export interface ObservationProvider {
  observe(capture: Capture): Observation | Promise<Observation>;
}
export interface RecapProvider {
  compose(
    day: Day,
    observations: Observation[],
    captures: Capture[],
  ): Recap | Promise<Recap>;
}
