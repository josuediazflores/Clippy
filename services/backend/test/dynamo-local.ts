import crypto from "node:crypto";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoStore, type TableNames } from "../src/store/dynamo";
import { TABLE_DEFINITIONS } from "../src/store/schema";
import { TABLES } from "../src/store/store";

/** Null unless a DynamoDB Local endpoint is configured. Never targets a real AWS account. */
export function dynamoLocalClient(): DynamoDBClient | null {
  const endpoint = process.env.CLIPPY_DYNAMODB_ENDPOINT;
  if (!endpoint) return null;
  const url = new URL(endpoint);
  if (!["127.0.0.1", "localhost"].includes(url.hostname))
    throw new Error("DynamoDB tests only run against a loopback emulator");
  return new DynamoDBClient({
    endpoint,
    region: "us-west-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

export async function createLocalTables(
  client: DynamoDBClient,
): Promise<{
  store: DynamoStore;
  names: TableNames;
  drop: () => Promise<void>;
}> {
  const run = crypto.randomBytes(4).toString("hex");
  const names = Object.fromEntries(
    TABLES.map((t) => [t, `clippy-test-${run}-${t}`]),
  ) as TableNames;
  for (const table of TABLES) {
    const def = TABLE_DEFINITIONS[table];
    const attributes = new Set([
      "pk",
      "sk",
      ...def.indexes.flatMap((i) => [i.pk, i.sk]),
    ]);
    await client.send(
      new CreateTableCommand({
        TableName: names[table],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [...attributes].map((name) => ({
          AttributeName: name,
          AttributeType: "S",
        })),
        GlobalSecondaryIndexes: def.indexes.length
          ? def.indexes.map((i) => ({
              IndexName: i.name,
              KeySchema: [
                { AttributeName: i.pk, KeyType: "HASH" },
                { AttributeName: i.sk, KeyType: "RANGE" },
              ],
              Projection: { ProjectionType: "ALL" },
            }))
          : undefined,
      }),
    );
  }
  return {
    store: new DynamoStore(client, names),
    names,
    drop: async () => {
      for (const table of TABLES)
        await client.send(new DeleteTableCommand({ TableName: names[table] }));
    },
  };
}
