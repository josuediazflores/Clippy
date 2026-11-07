import { Fault, type Engine, type JobUsage } from "../../backend/src/domain";
import type { ObservationProvider } from "../../backend/src/ports";
import type * as W from "../../backend/src/Wire";
import type { PipelineConfig } from "./config";
import { composeRecap, localTime, synthesisInput } from "./compose";
import { PROVIDER_FAILURE_REASONS } from "./errors";
import { inspectImage } from "./images";
import type {
  ModelUsage,
  ObservationDraft,
  ObservationModel,
  SynthesisModel,
} from "./providers/types";

export interface JobRef {
  owner: string;
  dayId: string;
  jobId: string;
  inputRevision: number;
}
/** One Map item result. Only IDs, status words and counts: it lands in execution history. */
export interface ObserveResult {
  captureId: string;
  status: "ready" | "cached" | "failed" | "skipped";
  reason: string | null;
  calls: number;
  usage: ModelUsage;
}
export type SynthesisResult =
  | { status: "candidate"; observed: number; missing: number }
  | { status: "failed"; code: string }
  | { status: "superseded" };

const clip = (text: string, max: number) =>
  text.length <= max ? text : text.slice(0, max - 1) + "…";

/** Wire observation from a model draft, clipped to schema bounds. */
export function toObservation(
  capture: W.Capture,
  draft: ObservationDraft,
  versions: {
    providerVersion: string;
    promptVersion: string;
    preprocessingVersion: string;
  },
): W.Observation {
  const facts = draft.visibleFacts
    .map((f) => f.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((f) => clip(f, 512));
  const activity = draft.inferredActivity.trim();
  return {
    schemaVersion: 1,
    captureId: capture.captureId,
    providerVersion: versions.providerVersion.slice(0, 64),
    promptVersion: versions.promptVersion.slice(0, 64),
    preprocessingVersion: versions.preprocessingVersion.slice(0, 64),
    status: draft.usable && facts.length ? "ready" : "failed",
    visibleFacts: facts,
    inferredActivity: activity ? clip(activity, 256) : null,
    uncertainty: clip(draft.uncertainty.trim() || "Not stated.", 512),
    evidence: [{ type: "capture", id: capture.captureId }],
  };
}

/** Deletion removes a day's job records; later steps treat that as stale work. */
const removed = (error: unknown): boolean =>
  error instanceof Fault && error.code === "NOT_FOUND";

/** Maps a final error name to the safe failure code shown on the day. */
export function failureCode(errorName: string): string {
  if (
    ["ProviderThrottled", "ProviderTimeout", "ProviderUnavailable"].includes(
      errorName,
    )
  )
    return "PROVIDER_UNAVAILABLE";
  if (errorName === "ProviderInvalidOutput") return "SYNTHESIS_INVALID";
  if (errorName === "ProviderRejected") return "PROVIDER_REJECTED";
  if (errorName === "PipelineLimitExceeded") return "MOMENT_LIMIT";
  if (errorName === "States.Timeout") return "PROCESSING_TIMEOUT";
  return "PROCESSING_FAILED";
}

/**
 * The recap workflow as replay-safe steps. Step Functions and the local runner call the
 * same methods; every step re-reads state and is safe to repeat.
 */
export class Pipeline {
  constructor(
    readonly engine: Engine,
    readonly models: {
      observation: ObservationModel;
      synthesis: SynthesisModel;
    },
    readonly config: PipelineConfig,
    private readonly metric: (name: string, value: number) => void = () => {},
  ) {}

  begin(ref: JobRef) {
    return this.engine.beginJob(ref);
  }

  async observe(ref: JobRef & { captureId: string }): Promise<ObserveResult> {
    try {
      return await this.observeOnce(ref);
    } catch (error) {
      if (removed(error))
        return {
          captureId: ref.captureId,
          status: "skipped",
          reason: "deleted",
          calls: 0,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      throw error;
    }
  }

  private async observeOnce(
    ref: JobRef & { captureId: string },
  ): Promise<ObserveResult> {
    let reason: string | null = null;
    let calls = 0;
    const usage: ModelUsage = { inputTokens: 0, outputTokens: 0 };
    const versions = {
      providerVersion: this.models.observation.providerVersion,
      promptVersion: this.config.observation.promptVersion,
      preprocessingVersion: this.config.observation.preprocessingVersion,
    };
    const provider: ObservationProvider = {
      observe: async (capture, source) => {
        const bytes = await source?.read(this.config.maxImageBytes);
        const check = inspectImage(bytes, capture.contentType, {
          maxBytes: this.config.maxImageBytes,
          minDimension: this.config.minImageDimension,
        });
        const failed = (why: string): W.Observation => {
          reason = why;
          return toObservation(
            capture,
            {
              usable: false,
              visibleFacts: [],
              inferredActivity: "",
              uncertainty: `Not analyzed: ${why}.`,
            },
            versions,
          );
        };
        if (!check.ok) return failed(check.reason);
        calls++;
        const result = await this.models.observation.describe({
          capture,
          image: { bytes: bytes!, mediaType: check.mediaType },
          localTime: localTime(capture),
        });
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        if (result.refused) return failed("refused");
        const observation = toObservation(capture, result.draft, versions);
        if (observation.status !== "ready") reason = "unusable";
        return observation;
      },
    };
    const outcome = await this.engine.observeCapture(
      ref.owner,
      ref.dayId,
      ref.jobId,
      ref.captureId,
      provider,
    );
    return {
      captureId: ref.captureId,
      status: outcome.status,
      reason: reason ?? outcome.reason,
      calls,
      usage,
    };
  }

  async synthesize(
    ref: JobRef & { observations: ObserveResult[] },
  ): Promise<SynthesisResult> {
    const counted = ref.observations.filter((o) => o.status !== "skipped");
    const providerFailures = counted.filter(
      (o) =>
        o.status === "failed" && PROVIDER_FAILURE_REASONS.has(o.reason ?? ""),
    ).length;
    // Stop rule: a provider-wide problem should be diagnosed, not paid for again.
    if (
      counted.length &&
      providerFailures / counted.length > this.config.providerFailureThreshold
    ) {
      this.metric("ProviderBatchFailure", 1);
      await this.engine.failJob(
        ref.owner,
        ref.dayId,
        ref.jobId,
        "PROVIDER_BATCH_FAILURE",
      );
      return { status: "failed", code: "PROVIDER_BATCH_FAILURE" };
    }
    let loaded: Awaited<ReturnType<Engine["synthesisInput"]>>;
    try {
      loaded = await this.engine.synthesisInput(
        ref.owner,
        ref.dayId,
        ref.jobId,
      );
    } catch (error) {
      if (removed(error)) return { status: "superseded" };
      throw error;
    }
    const { job, observations } = loaded;
    if (["superseded", "cancelled_by_deletion"].includes(job.state))
      return { status: "superseded" };
    const input = synthesisInput(job, observations);
    if (!input.coverage.observed) {
      await this.engine.failJob(
        ref.owner,
        ref.dayId,
        ref.jobId,
        "NO_OBSERVATIONS",
      );
      return { status: "failed", code: "NO_OBSERVATIONS" };
    }
    const written = await this.models.synthesis.write(input);
    if (written.refused) {
      await this.engine.failJob(
        ref.owner,
        ref.dayId,
        ref.jobId,
        "SYNTHESIS_DECLINED",
      );
      return { status: "failed", code: "SYNTHESIS_DECLINED" };
    }
    const recap = composeRecap(job, observations, written.draft, {
      providerVersion: this.models.synthesis.providerVersion,
      promptVersion: `${this.config.observation.promptVersion}+${this.config.synthesis.promptVersion}`,
    });
    const usage: JobUsage = {
      observationCalls: ref.observations.reduce((n, o) => n + o.calls, 0),
      cachedObservations: ref.observations.filter((o) => o.status === "cached")
        .length,
      failedObservations: ref.observations.filter((o) => o.status === "failed")
        .length,
      synthesisCalls: 1,
      inputTokens:
        ref.observations.reduce((n, o) => n + o.usage.inputTokens, 0) +
        written.usage.inputTokens,
      outputTokens:
        ref.observations.reduce((n, o) => n + o.usage.outputTokens, 0) +
        written.usage.outputTokens,
    };
    const saved = await this.engine.saveCandidate(
      ref.owner,
      ref.dayId,
      ref.jobId,
      recap,
      usage,
    );
    this.metric("ObservationCalls", usage.observationCalls);
    this.metric("InputTokens", usage.inputTokens);
    this.metric("OutputTokens", usage.outputTokens);
    if (saved === "superseded") return { status: "superseded" };
    return {
      status: "candidate",
      observed: input.coverage.observed,
      missing: input.coverage.missing,
    };
  }

  async publish(ref: JobRef) {
    const result = await this.engine.publishCandidate(
      ref.owner,
      ref.dayId,
      ref.jobId,
    );
    this.metric(
      result.status === "published" ? "RecapPublished" : "RecapSuperseded",
      1,
    );
    return result;
  }

  async fail(
    ref: JobRef & { error: string },
  ): Promise<{ status: "failed"; code: string }> {
    const code = failureCode(ref.error);
    await this.engine.failJob(ref.owner, ref.dayId, ref.jobId, code);
    return { status: "failed", code };
  }
}

/** Optimistic-write exhaustion is retryable by the workflow under this name. */
export function workflowError(error: unknown): unknown {
  if (error instanceof Fault && error.code === "CONFLICT" && error.retryable) {
    const conflict = new Error("conditional write conflict");
    conflict.name = "ConditionalConflict";
    return conflict;
  }
  return error;
}
