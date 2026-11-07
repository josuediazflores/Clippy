import type { IndexName, Table } from "./store";

/** Single source for table keys, indexes, TTL and streams. CDK and DynamoDB Local tests both use it. */
export interface TableDefinition {
  indexes: ReadonlyArray<{ name: IndexName; pk: string; sk: string }>;
  ttl: string | null;
  /** Operations streams outbox inserts to the dispatcher. */
  stream: boolean;
}
export const TABLE_DEFINITIONS: Record<Table, TableDefinition> = {
  accounts: { indexes: [], ttl: null, stream: false },
  devices: { indexes: [], ttl: null, stream: false },
  journal: {
    indexes: [{ name: "gsi1", pk: "gsi1pk", sk: "gsi1sk" }],
    ttl: null,
    stream: false,
  },
  operations: {
    indexes: [{ name: "pending", pk: "opk", sk: "osk" }],
    ttl: "ttl",
    stream: true,
  },
};
