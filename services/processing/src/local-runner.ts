import type { JobRef, ObserveResult, Pipeline } from "./pipeline";
import { POLICY, type RetryRule } from "./policy";

const nameOf = (error: unknown): string =>
  error instanceof Error ? error.name : "Error";

/** Step Functions Retry semantics: per-rule attempt counters, exponential backoff, full jitter. */
export async function withPolicy<T>(
  rules: readonly RetryRule[],
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  const attempts = rules.map(() => 0);
  for (;;) {
    try {
      return await fn();
    } catch (error) {
      const index = rules.findIndex((r) => r.errors.includes(nameOf(error)));
      const rule = rules[index];
      if (!rule || attempts[index]! >= rule.maxAttempts) throw error;
      const delay = Math.min(
        rule.maxDelaySeconds,
        rule.intervalSeconds * rule.backoffRate ** attempts[index]!,
      );
      attempts[index]!++;
      await sleep(Math.random() * delay * 1000);
    }
  }
}

/** Runs one job exactly as the state machine orders it. For tests and local evaluation. */
export async function runJobLocally(
  pipeline: Pipeline,
  ref: JobRef,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<
  | { status: "superseded" | "done" }
  | { status: "failed"; code: string }
  | {
      status: "published" | "superseded";
      state: string | null;
      observations: ObserveResult[];
    }
> {
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const begun = await withPolicy(POLICY.step, () => pipeline.begin(ref), sleep);
  if (begun.status !== "observing") return { status: begun.status };
  const queue = [...begun.captureIds];
  const observations: ObserveResult[] = [];
  await Promise.all(
    Array.from(
      { length: Math.min(pipeline.config.concurrency, queue.length) },
      async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          const captureId = id;
          try {
            observations.push(
              await withPolicy(
                POLICY.observe,
                () => pipeline.observe({ ...ref, captureId }),
                sleep,
              ),
            );
          } catch (error) {
            observations.push({
              captureId,
              status: "failed",
              reason: nameOf(error),
              calls: 0,
              usage: { inputTokens: 0, outputTokens: 0 },
            });
          }
        }
      },
    ),
  );
  try {
    const synthesis = await withPolicy(
      POLICY.synthesize,
      () => pipeline.synthesize({ ...ref, observations }),
      sleep,
    );
    if (synthesis.status === "failed") return synthesis;
    if (synthesis.status === "superseded") return { status: "superseded" };
    const published = await withPolicy(
      POLICY.step,
      () => pipeline.publish(ref),
      sleep,
    );
    return { ...published, observations };
  } catch (error) {
    return pipeline.fail({ ...ref, error: nameOf(error) });
  }
}
