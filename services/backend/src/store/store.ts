// Storage port shaped like the DynamoDB access patterns in docs/architecture.md section 8.
// The domain layer depends on this interface only; adapters live beside it.

export type Table = "accounts" | "devices" | "journal" | "operations";
export const TABLES: readonly Table[] = [
  "accounts",
  "devices",
  "journal",
  "operations",
];

export interface Key {
  readonly table: Table;
  readonly pk: string;
  readonly sk: string;
}

/** Optional top-level attributes that feed sparse secondary indexes, TTL and stream filters. */
export interface Attributes {
  /** Journal history index: one entry per day metadata item. */
  gsi1pk?: string;
  gsi1sk?: string;
  /** Operations pending-outbox index: present only while an outbox entry is undispatched. */
  opk?: string;
  osk?: string;
  /** Epoch seconds. Eventual housekeeping only, never a privacy deletion guarantee. */
  ttl?: number;
  /** Stream filter discriminator, for example "outbox". */
  kind?: string;
}

export interface Item<T = unknown> extends Key, Attributes {
  /** Optimistic version. Every write increments it; conditions compare it. */
  v: number;
  data: T;
}

export type Condition =
  { readonly absent: true } | { readonly version: number };

export type Write =
  | { op: "put"; item: Item; condition?: Condition }
  | { op: "delete"; key: Key; condition?: Condition }
  | { op: "check"; key: Key; condition: Condition };

export type IndexName = "gsi1" | "pending";

export interface QueryInput {
  table: Table;
  index?: IndexName;
  pk: string;
  /** Sort-key prefix (base table sk, or index sort key). */
  prefix?: string;
  limit?: number;
  /** Opaque continuation from a previous page. */
  after?: string;
}

export interface QueryPage {
  items: Item[];
  next?: string;
}

export interface Store {
  /** Strongly consistent single read. */
  get(key: Key): Promise<Item | undefined>;
  /** Strongly consistent batch read. Order of results matches keys; missing items are undefined. */
  getMany(keys: readonly Key[]): Promise<Array<Item | undefined>>;
  /** Base-table queries are strongly consistent; index queries are eventually consistent. */
  query(input: QueryInput): Promise<QueryPage>;
  /** All writes succeed or none do. A failed condition throws ConditionFailed. */
  transact(writes: readonly Write[]): Promise<void>;
  /** Non-atomic bulk removal for cleanup. Idempotent. */
  deleteMany(keys: readonly Key[]): Promise<void>;
}

export class ConditionFailed extends Error {
  constructor(readonly keys: string[] = []) {
    super("Condition failed");
  }
}

/** DynamoDB TransactWriteItems allows 100 actions; adapters enforce the same bound. */
export const MAX_TRANSACTION_WRITES = 100;
/** DynamoDB item limit is 400 KB; keep a margin for attribute names and index keys. */
export const MAX_ITEM_BYTES = 380 * 1024;

export const keyString = (key: Key): string =>
  `${key.table}\u0000${key.pk}\u0000${key.sk}`;

export async function queryAll(
  store: Store,
  input: Omit<QueryInput, "after">,
  maxItems = 10000,
): Promise<Item[]> {
  const items: Item[] = [];
  let after: string | undefined;
  do {
    const page = await store.query({ ...input, after });
    items.push(...page.items);
    after = page.next;
    if (items.length > maxItems)
      throw new Error(`Query exceeded ${maxItems} items`);
  } while (after);
  return items;
}
