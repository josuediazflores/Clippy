import {
  BatchGetItemCommand,
  BatchWriteItemCommand,
  ConditionalCheckFailedException,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
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
  type Table,
  type Write,
} from "./store";

export type TableNames = Record<Table, string>;
type Row = Record<string, AttributeValue>;

const INDEX: Record<NonNullable<QueryInput["index"]>, [string, string]> = {
  gsi1: ["gsi1pk", "gsi1sk"],
  pending: ["opk", "osk"],
};
const OPTIONAL = ["gsi1pk", "gsi1sk", "opk", "osk", "kind"] as const;

function encode(item: Item): Row {
  const row: Row = {
    pk: { S: item.pk },
    sk: { S: item.sk },
    v: { N: String(item.v) },
    // Data is stored as canonical JSON text: exact round trip, no marshalling surprises.
    d: { S: JSON.stringify(item.data) },
  };
  for (const name of OPTIONAL) {
    const value = item[name];
    if (value !== undefined) row[name] = { S: value };
  }
  if (item.ttl !== undefined) row.ttl = { N: String(item.ttl) };
  return row;
}
export function decodeRow(table: Table, row: Row): Item {
  const item: Item = {
    table,
    pk: row.pk!.S!,
    sk: row.sk!.S!,
    v: Number(row.v!.N),
    data: JSON.parse(row.d!.S!),
  };
  for (const name of OPTIONAL) if (row[name]?.S) item[name] = row[name].S;
  if (row.ttl?.N) item.ttl = Number(row.ttl.N);
  return item;
}
const keyRow = (key: Key): Row => ({ pk: { S: key.pk }, sk: { S: key.sk } });
function conditionParts(condition?: Condition): {
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Row;
} {
  if (!condition) return {};
  if ("absent" in condition)
    return {
      ConditionExpression: "attribute_not_exists(#pk)",
      ExpressionAttributeNames: { "#pk": "pk" },
    };
  return {
    ConditionExpression: "#v = :v",
    ExpressionAttributeNames: { "#v": "v" },
    ExpressionAttributeValues: { ":v": { N: String(condition.version) } },
  };
}
const pause = (attempt: number) =>
  new Promise((resolve) =>
    setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt) * Math.random()),
  );

/** DynamoDB adapter for the four-table layout synthesized by infra/src/data-stack.ts. */
export class DynamoStore implements Store {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly tables: TableNames,
  ) {}

  private table(name: string): Table {
    const found = (Object.entries(this.tables) as Array<[Table, string]>).find(
      ([, physical]) => physical === name,
    );
    if (!found) throw new Error("Unknown table");
    return found[0];
  }

  async get(key: Key): Promise<Item | undefined> {
    const result = await this.client.send(
      new GetItemCommand({
        TableName: this.tables[key.table],
        Key: keyRow(key),
        ConsistentRead: true,
      }),
    );
    return result.Item ? decodeRow(key.table, result.Item) : undefined;
  }

  async getMany(keys: readonly Key[]): Promise<Array<Item | undefined>> {
    if (keys.length > 100) throw new Error("Batch read exceeds 100 keys");
    const found = new Map<string, Item>();
    let request: Record<string, { Keys: Row[]; ConsistentRead: boolean }> = {};
    for (const key of new Map(keys.map((k) => [keyString(k), k])).values()) {
      const name = this.tables[key.table];
      (request[name] ??= { Keys: [], ConsistentRead: true }).Keys.push(
        keyRow(key),
      );
    }
    for (let attempt = 0; Object.keys(request).length; attempt++) {
      if (attempt > 8) throw new Error("Batch read did not complete");
      if (attempt) await pause(attempt);
      const result = await this.client.send(
        new BatchGetItemCommand({ RequestItems: request }),
      );
      for (const [name, rows] of Object.entries(result.Responses ?? {}))
        for (const row of rows) {
          const item = decodeRow(this.table(name), row);
          found.set(keyString(item), item);
        }
      request = (result.UnprocessedKeys ?? {}) as typeof request;
    }
    return keys.map((key) => found.get(keyString(key)));
  }

  async query(input: QueryInput): Promise<QueryPage> {
    const [pkName, skName] = input.index ? INDEX[input.index] : ["pk", "sk"];
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tables[input.table],
        IndexName: input.index,
        KeyConditionExpression: input.prefix
          ? "#p = :p AND begins_with(#s, :s)"
          : "#p = :p",
        ExpressionAttributeNames: {
          "#p": pkName,
          ...(input.prefix ? { "#s": skName } : {}),
        },
        ExpressionAttributeValues: {
          ":p": { S: input.pk },
          ...(input.prefix ? { ":s": { S: input.prefix } } : {}),
        },
        ConsistentRead: input.index ? false : true,
        Limit: input.limit ?? 1000,
        ExclusiveStartKey: input.after
          ? (JSON.parse(
              Buffer.from(input.after, "base64url").toString("utf8"),
            ) as Row)
          : undefined,
      }),
    );
    return {
      items: (result.Items ?? []).map((row) => decodeRow(input.table, row)),
      next: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
            "base64url",
          )
        : undefined,
    };
  }

  private checkSize(item: Item): void {
    if (Buffer.byteLength(JSON.stringify(item)) > MAX_ITEM_BYTES)
      throw new Error(`Item ${item.sk} exceeds the item size bound`);
  }

  async transact(writes: readonly Write[]): Promise<void> {
    if (!writes.length) return;
    if (writes.length > MAX_TRANSACTION_WRITES)
      throw new Error("Transaction exceeds 100 writes");
    const ids = writes.map((w) => keyString(w.op === "put" ? w.item : w.key));
    if (new Set(ids).size !== ids.length)
      throw new Error("Transaction touches the same item twice");
    for (const w of writes) if (w.op === "put") this.checkSize(w.item);
    const only = writes[0]!;
    try {
      // A single conditional write is atomic on its own and costs half a transaction.
      if (writes.length === 1 && only.op === "put") {
        await this.client.send(
          new PutItemCommand({
            TableName: this.tables[only.item.table],
            Item: encode(only.item),
            ...conditionParts(only.condition),
          }),
        );
        return;
      }
      if (writes.length === 1 && only.op === "delete") {
        await this.client.send(
          new DeleteItemCommand({
            TableName: this.tables[only.key.table],
            Key: keyRow(only.key),
            ...conditionParts(only.condition),
          }),
        );
        return;
      }
      const items: TransactWriteItem[] = writes.map((w) => {
        if (w.op === "put")
          return {
            Put: {
              TableName: this.tables[w.item.table],
              Item: encode(w.item),
              ...conditionParts(w.condition),
            },
          };
        if (w.op === "delete")
          return {
            Delete: {
              TableName: this.tables[w.key.table],
              Key: keyRow(w.key),
              ...conditionParts(w.condition),
            },
          };
        const parts = conditionParts(w.condition);
        return {
          ConditionCheck: {
            TableName: this.tables[w.key.table],
            Key: keyRow(w.key),
            ConditionExpression: parts.ConditionExpression!,
            ExpressionAttributeNames: parts.ExpressionAttributeNames,
            ExpressionAttributeValues: parts.ExpressionAttributeValues,
          },
        };
      });
      await this.client.send(
        new TransactWriteItemsCommand({ TransactItems: items }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException)
        throw new ConditionFailed(ids);
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        // A concurrent transaction on the same item is an optimistic conflict too.
        if (
          reasons.some((r) =>
            ["ConditionalCheckFailed", "TransactionConflict"].includes(
              r.Code ?? "",
            ),
          )
        )
          throw new ConditionFailed(
            ids.filter(
              (_, i) => reasons[i]?.Code && reasons[i]?.Code !== "None",
            ),
          );
      }
      throw error;
    }
  }

  async deleteMany(keys: readonly Key[]): Promise<void> {
    const unique = [...new Map(keys.map((k) => [keyString(k), k])).values()];
    for (let i = 0; i < unique.length; i += 25) {
      let request: Record<string, Array<{ DeleteRequest: { Key: Row } }>> = {};
      for (const key of unique.slice(i, i + 25))
        (request[this.tables[key.table]] ??= []).push({
          DeleteRequest: { Key: keyRow(key) },
        });
      for (let attempt = 0; Object.keys(request).length; attempt++) {
        if (attempt > 8) throw new Error("Batch delete did not complete");
        if (attempt) await pause(attempt);
        const result = await this.client.send(
          new BatchWriteItemCommand({ RequestItems: request }),
        );
        request = (result.UnprocessedItems ?? {}) as typeof request;
      }
    }
  }
}
