import {
  ConditionFailed,
  MAX_TRANSACTION_WRITES,
  keyString,
  type Attributes,
  type Condition,
  type Item,
  type Key,
  type Store,
  type Write,
} from "./store";

const bare = (key: Key): Key => ({
  table: key.table,
  pk: key.pk,
  sk: key.sk,
});

/**
 * Unit of work with optimistic concurrency. Reads are strongly consistent and cached.
 * Every staged write is conditioned on the version observed by this unit (or absence),
 * so a commit fails instead of overwriting a concurrent change. Reads see staged writes.
 */
export class Tx {
  private readonly seen = new Map<string, Item | null>();
  private readonly staged = new Map<string, Write>();
  private readonly guards = new Map<string, Key>();
  private readonly hooks: Array<() => Promise<void>> = [];
  /** Set by the idempotent mutation wrapper so deletion can retain its own receipt. */
  receiptKey: Key | null = null;

  constructor(readonly store: Store) {}

  async get<T>(key: Key): Promise<T | undefined> {
    return (await this.item<T>(key))?.data;
  }

  async item<T>(key: Key): Promise<Item<T> | undefined> {
    const id = keyString(key);
    const write = this.staged.get(id);
    if (write?.op === "put") return structuredClone(write.item) as Item<T>;
    if (write?.op === "delete") return undefined;
    if (!this.seen.has(id))
      this.seen.set(id, (await this.store.get(key)) ?? null);
    const found = this.seen.get(id);
    return found ? (structuredClone(found) as Item<T>) : undefined;
  }

  async getMany<T>(keys: readonly Key[]): Promise<Array<T | undefined>> {
    const missing = keys.filter((key) => {
      const id = keyString(key);
      return !this.staged.has(id) && !this.seen.has(id);
    });
    const unique = [...new Map(missing.map((k) => [keyString(k), k])).values()];
    for (let i = 0; i < unique.length; i += 100) {
      const chunk = unique.slice(i, i + 100);
      const found = await this.store.getMany(chunk);
      chunk.forEach((key, index) =>
        this.seen.set(keyString(key), found[index] ?? null),
      );
    }
    return Promise.all(keys.map((key) => this.get<T>(key)));
  }

  private condition(key: Key): Condition {
    const prior = this.seen.get(keyString(key));
    return prior ? { version: prior.v } : { absent: true };
  }

  private version(key: Key): number {
    return this.seen.get(keyString(key))?.v ?? 0;
  }

  /** Create or replace. Replacing requires that this unit read the item first. */
  put<T>(key: Key, data: T, attributes: Attributes = {}): void {
    const id = keyString(key);
    this.guards.delete(id);
    this.staged.set(id, {
      op: "put",
      item: {
        table: key.table,
        pk: key.pk,
        sk: key.sk,
        ...attributes,
        v: this.version(key) + 1,
        data: structuredClone(data),
      },
      condition: this.condition(key),
    });
  }

  delete(key: Key): void {
    const id = keyString(key);
    this.guards.delete(id);
    if (!this.seen.get(id) && this.staged.get(id)?.op === "put") {
      // Created and removed in the same unit: nothing to write.
      this.staged.delete(id);
      return;
    }
    this.staged.set(id, {
      op: "delete",
      key: bare(key),
      condition: this.condition(key),
    });
  }

  /** Require that a read item is unchanged (or still absent) when this unit commits. */
  async guard(key: Key): Promise<void> {
    await this.item(key);
    const id = keyString(key);
    if (!this.staged.has(id)) this.guards.set(id, bare(key));
  }

  afterCommit(hook: () => Promise<void>): void {
    this.hooks.push(hook);
  }

  get writeCount(): number {
    return this.staged.size;
  }

  async commit(): Promise<void> {
    const writes: Write[] = [...this.staged.values()];
    if (writes.length) {
      for (const [id, key] of this.guards)
        if (!this.staged.has(id))
          writes.push({ op: "check", key, condition: this.condition(key) });
      if (writes.length > MAX_TRANSACTION_WRITES)
        throw new Error(`Transaction has ${writes.length} writes`);
      await this.store.transact(writes);
    }
    for (const hook of this.hooks) await hook();
  }
}

export async function withRetries<T>(
  attempts: number,
  fn: () => Promise<T>,
  onExhausted: () => Error,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ConditionFailed)) throw error;
      if (attempt >= attempts) throw onExhausted();
    }
  }
}
