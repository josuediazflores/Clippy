import fs from "node:fs";
import path from "node:path";
import {
  ConditionFailed,
  MAX_ITEM_BYTES,
  MAX_TRANSACTION_WRITES,
  keyString,
  type Condition,
  type Item,
  type Key,
  type QueryInput,
  type QueryPage,
  type Store,
  type Write,
} from "./store";

export interface MemoryStoreHooks {
  /** Test fault injection: runs before a transaction is applied. Throwing aborts it. */
  beforeTransact?: (writes: readonly Write[]) => void;
  /** Test fault injection: runs after a transaction is applied. Throwing simulates a crash after commit. */
  afterTransact?: (writes: readonly Write[]) => void;
}

const sortKey = (item: Item, index?: QueryInput["index"]): string =>
  index === "gsi1"
    ? (item.gsi1sk ?? "")
    : index === "pending"
      ? (item.osk ?? "")
      : item.sk;
const partition = (item: Item, index?: QueryInput["index"]): string =>
  index === "gsi1"
    ? (item.gsi1pk ?? "")
    : index === "pending"
      ? (item.opk ?? "")
      : item.pk;

/**
 * Single-process adapter with the same conditional, atomic and size semantics the
 * DynamoDB adapter relies on. Used by the local server, unit tests and the scenario.
 */
export class MemoryStore implements Store {
  protected items = new Map<string, Item>();
  hooks: MemoryStoreHooks = {};

  async get(key: Key): Promise<Item | undefined> {
    const found = this.items.get(keyString(key));
    return found ? structuredClone(found) : undefined;
  }

  async getMany(keys: readonly Key[]): Promise<Array<Item | undefined>> {
    if (keys.length > 100) throw new Error("Batch read exceeds 100 keys");
    return Promise.all(keys.map((key) => this.get(key)));
  }

  async query(input: QueryInput): Promise<QueryPage> {
    const limit = input.limit ?? 1000;
    const rows = [...this.items.values()]
      .filter(
        (item) =>
          item.table === input.table &&
          partition(item, input.index) === input.pk &&
          (!input.index || sortKey(item, input.index) !== "") &&
          sortKey(item, input.index).startsWith(input.prefix ?? ""),
      )
      .sort((a, b) => {
        const order = sortKey(a, input.index).localeCompare(
          sortKey(b, input.index),
        );
        return order || keyString(a).localeCompare(keyString(b));
      });
    const start = input.after
      ? rows.findIndex((row) => keyString(row) === input.after) + 1
      : 0;
    const page = rows.slice(start, start + limit);
    return {
      items: structuredClone(page),
      next: start + limit < rows.length ? keyString(page.at(-1)!) : undefined,
    };
  }

  private satisfied(current: Item | undefined, condition?: Condition): boolean {
    if (!condition) return true;
    if ("absent" in condition) return current === undefined;
    return current?.v === condition.version;
  }

  async transact(writes: readonly Write[]): Promise<void> {
    if (!writes.length) return;
    if (writes.length > MAX_TRANSACTION_WRITES)
      throw new Error("Transaction exceeds 100 writes");
    const ids = writes.map((w) => keyString(w.op === "put" ? w.item : w.key));
    if (new Set(ids).size !== ids.length)
      throw new Error("Transaction touches the same item twice");
    this.hooks.beforeTransact?.(writes);
    const failed = writes
      .filter((w, i) => !this.satisfied(this.items.get(ids[i]!), w.condition))
      .map((w) => keyString(w.op === "put" ? w.item : w.key));
    if (failed.length) throw new ConditionFailed(failed);
    for (const write of writes)
      if (
        write.op === "put" &&
        Buffer.byteLength(JSON.stringify(write.item)) > MAX_ITEM_BYTES
      )
        throw new Error(`Item ${write.item.sk} exceeds the item size bound`);
    for (const [index, write] of writes.entries()) {
      if (write.op === "put")
        this.items.set(ids[index]!, structuredClone(write.item));
      else if (write.op === "delete") this.items.delete(ids[index]!);
    }
    this.persist();
    this.hooks.afterTransact?.(writes);
  }

  async deleteMany(keys: readonly Key[]): Promise<void> {
    for (const key of keys) this.items.delete(keyString(key));
    this.persist();
  }

  /** Local tools only: branch deterministic fixture state. */
  snapshot(): Map<string, Item> {
    return structuredClone(this.items);
  }

  restore(state: Map<string, Item>): void {
    this.items = structuredClone(state);
    this.persist();
  }

  /** Test inspection only. */
  all(table?: Item["table"]): Item[] {
    return structuredClone(
      [...this.items.values()].filter((i) => !table || i.table === table),
    );
  }

  protected persist(): void {}
}

/** MemoryStore persisted by atomic file replacement after every write (local server/restart tests). */
export class FileStore extends MemoryStore {
  constructor(private readonly file: string) {
    super();
    if (fs.existsSync(file)) {
      const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Item[];
      this.items = new Map(rows.map((row) => [keyString(row), row]));
    }
  }

  protected override persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + ".tmp";
    const fd = fs.openSync(temporary, "w", 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify([...this.items.values()]));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, this.file);
  }
}
