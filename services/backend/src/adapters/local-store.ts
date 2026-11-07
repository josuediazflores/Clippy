import fs from "node:fs";
import path from "node:path";
import type { JournalStore, ObjectStore } from "../ports";

function atomicWrite(file: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + ".tmp";
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
export class LocalJournalStore<T> implements JournalStore<T> {
  constructor(
    private readonly file: string,
    private readonly initial: () => T,
  ) {}
  load(): T {
    return fs.existsSync(this.file)
      ? (JSON.parse(fs.readFileSync(this.file, "utf8")) as T)
      : this.initial();
  }
  commit(state: T): void {
    atomicWrite(this.file, JSON.stringify(state));
  }
}
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
  }
  private file(id: string): string {
    if (!/^[a-z][a-z0-9_]{2,95}$/.test(id))
      throw new Error("Invalid object ID");
    return path.join(this.directory, id);
  }
  put(id: string, bytes: Uint8Array): void {
    if (fs.existsSync(this.file(id))) throw new Error("Object exists");
    atomicWrite(this.file(id), bytes);
  }
  get(id: string): Uint8Array | undefined {
    return fs.existsSync(this.file(id))
      ? fs.readFileSync(this.file(id))
      : undefined;
  }
  remove(id: string): void {
    fs.rmSync(this.file(id), { force: true });
  }
}
