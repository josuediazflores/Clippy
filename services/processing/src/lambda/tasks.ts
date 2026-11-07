import { validate } from "../../../backend/src/contracts";
import { createAwsEngine } from "../../../backend/src/aws/runtime";
import { metric, safeLog } from "../../../backend/src/aws/log";
import { safeErrorFields } from "../../../backend/src/router";
import { pipelineVersion } from "../config";
import { createModels, readPipelineConfig } from "../models";
import {
  Pipeline,
  workflowError,
  type JobRef,
  type ObserveResult,
} from "../pipeline";

export type TaskEvent = JobRef &
  (
    | { action: "begin" | "synthesize" | "publish" }
    | { action: "observe"; captureId: string }
    | { action: "fail"; error: string }
  ) & { observations?: ObserveResult[] };

const isId = (value: unknown) => {
  try {
    validate("Id", value);
    return true;
  } catch {
    return false;
  }
};
/** Execution input carries references only; reject anything else before touching storage. */
export function checkEvent(event: TaskEvent): void {
  if (
    typeof event.owner !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(event.owner) ||
    !isId(event.dayId) ||
    !isId(event.jobId) ||
    !Number.isInteger(event.inputRevision) ||
    (event.action === "observe" && !isId(event.captureId)) ||
    !["begin", "observe", "synthesize", "publish", "fail"].includes(
      event.action,
    )
  )
    throw new Error("Invalid task input");
}

export function createTaskHandler(pipeline: Pipeline) {
  return async (event: TaskEvent): Promise<unknown> => {
    const started = Date.now();
    try {
      checkEvent(event);
      const ref: JobRef = {
        owner: event.owner,
        dayId: event.dayId,
        jobId: event.jobId,
        inputRevision: event.inputRevision,
      };
      const result =
        event.action === "begin"
          ? await pipeline.begin(ref)
          : event.action === "observe"
            ? await pipeline.observe({ ...ref, captureId: event.captureId })
            : event.action === "synthesize"
              ? await pipeline.synthesize({
                  ...ref,
                  observations: event.observations ?? [],
                })
              : event.action === "publish"
                ? await pipeline.publish(ref)
                : await pipeline.fail({
                    ...ref,
                    error: String("error" in event ? event.error : "").slice(
                      0,
                      80,
                    ),
                  });
      safeLog("processing.task", {
        action: event.action,
        ms: Date.now() - started,
      });
      return result;
    } catch (error) {
      safeLog("processing.task_failed", {
        action: String(event.action),
        ...safeErrorFields(error),
      });
      metric("ProcessingTaskFailed", 1);
      throw workflowError(error);
    }
  };
}

let cached: ReturnType<typeof createTaskHandler> | undefined;
export const handler = (event: TaskEvent) => {
  if (!cached) {
    const config = readPipelineConfig();
    const engine = createAwsEngine();
    if (engine.pipeline !== pipelineVersion(config))
      throw new Error(
        "Pipeline version mismatch between dispatcher and workflow",
      );
    cached = createTaskHandler(
      new Pipeline(
        engine,
        createModels(config, process.env.AWS_REGION),
        config,
        (name, value) => metric(name, value),
      ),
    );
  }
  return cached(event);
};
