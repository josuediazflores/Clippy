import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import type { Engine } from "../domain";
import { createAwsEngine } from "../aws/runtime";
import { metric, safeLog } from "../aws/log";

/**
 * Operations-table stream consumer. The event source mapping filters to INSERT events of
 * outbox items, so state and dispatch-marker updates never re-trigger work. Failures are
 * reported per record; the mapping's on-failure destination keeps a metadata-only receipt.
 */
export function createDispatcher(engine: Engine) {
  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const batchItemFailures: Array<{ itemIdentifier: string }> = [];
    for (const record of event.Records) {
      const sequence = record.dynamodb?.SequenceNumber ?? "";
      const image = record.dynamodb?.NewImage;
      if (record.eventName !== "INSERT" || image?.kind?.S !== "outbox")
        continue;
      let id: string | undefined;
      try {
        id = (JSON.parse(image.d?.S ?? "{}") as { id?: string }).id;
        if (!id) continue;
        const status = await engine.dispatch(id);
        safeLog("outbox.dispatch", { id, status });
      } catch (error) {
        safeLog("outbox.dispatch_failed", {
          id: id ?? null,
          error: error instanceof Error ? error.name : "unknown",
        });
        metric("OutboxDispatchFailed", 1);
        batchItemFailures.push({ itemIdentifier: sequence });
      }
    }
    return { batchItemFailures };
  };
}

let cached: ReturnType<typeof createDispatcher> | undefined;
export const handler = (event: DynamoDBStreamEvent) => {
  cached ??= createDispatcher(createAwsEngine());
  return cached(event);
};
