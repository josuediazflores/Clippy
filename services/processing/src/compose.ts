import { momentID } from "../../backend/src/identity";
import type * as W from "../../backend/src/Wire";
import type { Job } from "../../backend/src/domain";
import { InvalidProviderOutput, PipelineLimitExceeded } from "./errors";
import type { RecapDraft, SynthesisInput } from "./providers/types";

const clip = (text: string, max: number): string => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + "…";
};
/** Wall-clock time in the capture's own timezone, for prompts only. */
export function localTime(capture: W.Capture): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: capture.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(capture.capturedAt));
}
/** Latest non-deleted correction per moment, matching the P03 mock's precedence. */
const latestCorrections = (day: W.Day): Map<string, string> => {
  const map = new Map<string, string>();
  for (const c of [...day.corrections].reverse())
    if (!c.deleted && c.text && !map.has(c.momentId))
      map.set(c.momentId, c.text);
  return map;
};

/** Model input: observed captures in time order, owner corrections, server-computed coverage. */
export function synthesisInput(
  job: Job,
  observations: W.Observation[],
  places: ReadonlyMap<string, string | null> = new Map(),
): SynthesisInput {
  const byId = new Map(job.captures.map((c) => [c.captureId, c]));
  const ready = observations
    .filter((o) => o.status === "ready" && byId.has(o.captureId))
    .sort((a, b) =>
      byId
        .get(a.captureId)!
        .capturedAt.localeCompare(byId.get(b.captureId)!.capturedAt),
    );
  const corrections = latestCorrections(job.day);
  return {
    date: job.day.startAt.slice(0, 10),
    timeZone: job.day.timeZone,
    timeline: ready.map((o) => ({
      captureId: o.captureId,
      localTime: localTime(byId.get(o.captureId)!),
      visibleFacts: o.visibleFacts,
      inferredActivity: o.inferredActivity,
      uncertainty: o.uncertainty,
      place: places.get(o.captureId) ?? null,
    })),
    corrections: ready.flatMap((o) => {
      const text = corrections.get(momentID(o.captureId));
      return text ? [{ captureId: o.captureId, text }] : [];
    }),
    coverage: {
      captured: job.captures.length,
      observed: ready.length,
      missing: job.captures.length - ready.length,
    },
  };
}

/**
 * Builds the wire Recap. The model contributes only text; moments, evidence and coverage
 * come from the frozen job, so a model cannot cite a capture it was not given.
 */
export function composeRecap(
  job: Job,
  observations: W.Observation[],
  draft: RecapDraft,
  versions: { providerVersion: string; promptVersion: string },
  places: ReadonlyMap<string, string | null> = new Map(),
): W.Recap {
  const input = synthesisInput(job, observations, places);
  if (input.timeline.length > 200)
    throw new PipelineLimitExceeded("more than 200 observed moments");
  const allowed = new Set(input.timeline.map((t) => t.captureId));
  const titles = new Map<string, string>();
  for (const t of draft.titles) {
    if (!allowed.has(t.captureId))
      throw new InvalidProviderOutput("unknown source");
    if (titles.has(t.captureId))
      throw new InvalidProviderOutput("duplicate source");
    if (t.title.trim()) titles.set(t.captureId, clip(t.title, 200));
  }
  if (!draft.summary.trim() || !draft.reflectionPrompt.trim())
    throw new InvalidProviderOutput("empty text");
  const byId = new Map(job.captures.map((c) => [c.captureId, c]));
  const obs = new Map(observations.map((o) => [o.captureId, o]));
  const corrections = new Map(
    input.corrections.map((c) => [c.captureId, c.text]),
  );
  const moments: W.Moment[] = input.timeline.map((entry) => {
    const capture = byId.get(entry.captureId)!;
    const facts = obs.get(entry.captureId)!.visibleFacts.join(" ");
    const near = entry.place ? `Near ${entry.place}. ` : "";
    return {
      schemaVersion: 1,
      momentId: momentID(entry.captureId),
      capturedAt: capture.capturedAt,
      title: clip(
        corrections.get(entry.captureId) ??
          titles.get(entry.captureId) ??
          `Moment ${capture.sequence}`,
        200,
      ),
      detail: clip(near + (facts || "No visible details were recorded."), 1000),
      evidence: [{ type: "capture", id: entry.captureId }],
    };
  });
  return {
    schemaVersion: 1,
    dayId: job.day.dayId,
    inputRevision: job.day.inputRevision,
    recapRevision: job.nextRecapRevision,
    deletionGeneration: job.day.deletionGeneration,
    state: input.coverage.missing ? "partial" : "ready",
    summary: clip(draft.summary, 4000),
    moments,
    reflectionPrompt: clip(draft.reflectionPrompt, 512),
    coverage: {
      ...input.coverage,
      throughAt:
        job.captures
          .map((c) => c.capturedAt)
          .sort()
          .at(-1) ?? null,
    },
    providerVersion: versions.providerVersion.slice(0, 64),
    promptVersion: versions.promptVersion.slice(0, 64),
  };
}
