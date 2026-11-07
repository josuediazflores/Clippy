import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../contracts";
import type {
  GrantSigner,
  ObjectHead,
  SignedPut,
  WritableObjectStore,
} from "../ports";
import type { GrantItem } from "../Wire";

function atomicWrite(file: string, data: Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}

const KEY = /^[a-z][a-z0-9_]*(\/[A-Za-z0-9_-]+)+$/;

/** Immutable local object files under one directory. Synthetic data only, unencrypted (D11). */
export class LocalObjectStore implements WritableObjectStore {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }
  private file(key: string): string {
    if (!KEY.test(key) || key.includes(".."))
      throw new Error("Invalid object key");
    return path.join(this.directory, ...key.split("/"));
  }
  async putIfAbsent(key: string, bytes: Uint8Array): Promise<boolean> {
    const file = this.file(key);
    if (fs.existsSync(file)) return false;
    atomicWrite(file, bytes);
    return true;
  }
  async head(key: string): Promise<ObjectHead | undefined> {
    const file = this.file(key);
    if (!fs.existsSync(file)) return undefined;
    const bytes = fs.readFileSync(file);
    return { byteLength: bytes.length, sha256: sha256(bytes) };
  }
  async read(key: string, maxBytes: number): Promise<Uint8Array | undefined> {
    const file = this.file(key);
    if (!fs.existsSync(file)) return undefined;
    const bytes = fs.readFileSync(file);
    return bytes.subarray(0, maxBytes + 1);
  }
  async remove(keys: readonly string[]): Promise<void> {
    for (const key of keys) fs.rmSync(this.file(key), { force: true });
  }
  async removePrefix(prefix: string): Promise<void> {
    if (!KEY.test(prefix.replace(/\/$/, "")))
      throw new Error("Invalid object prefix");
    fs.rmSync(path.join(this.directory, ...prefix.split("/").filter(Boolean)), {
      recursive: true,
      force: true,
    });
  }
  /** Test-only fault injection: replace stored bytes as if storage were corrupted. */
  corrupt(key: string, bytes: Uint8Array): void {
    fs.writeFileSync(this.file(key), bytes);
  }
}

/** Loopback URLs for the local adapter. They carry no secret; the server re-authenticates. */
export class LocalGrantSigner implements GrantSigner {
  constructor(private readonly origin = "http://127.0.0.1:8787") {}
  async signPut(input: {
    uploadId: string;
    item: GrantItem;
    origin?: string;
  }): Promise<SignedPut> {
    return {
      putURL: `${input.origin ?? this.origin}/local/uploads/${input.uploadId}`,
    };
  }
  async signGet(input: { uploadId: string; origin?: string }): Promise<string> {
    return `${input.origin ?? this.origin}/local/objects/${input.uploadId}`;
  }
}
