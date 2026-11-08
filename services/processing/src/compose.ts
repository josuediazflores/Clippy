import { momentID } from "../../backend/src/identity";
import type * as W from "../../backend/src/Wire";
import { correctedMoments, type Job } from "../../backend/src/domain";
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

export interface QuestionPolicy {
  /** Daily ceiling for the sticky question queue (contract maximum is 10). */
  maxPerDay: number;
}
export const DEFAULT_QUESTIONS: QuestionPolicy = { maxPerDay: 5 };

/** Model input: observed captures in time order, owner corrections, server-computed coverage. */
export function synthesisInput(
  job: Job,
  observations: W.Observation[],
  places: ReadonlyMap<string, string | null> = new Map(),
  questions: QuestionPolicy = DEFAULT_QUESTIONS,
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
  const asked = new Map(
    (job.day.recap?.questions ?? []).map((q) => [q.momentId, q.prompt]),
  );
  const readyMoments = new Set(ready.map((o) => momentID(o.captureId)));
  const carried = [...asked.keys()].filter((m) => readyMoments.has(m)).length;
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
      const moment = momentID(o.captureId);
      const text = corrections.get(moment);
      return text
        ? [
            {
              captureId: o.captureId,
              text,
              question: asked.get(moment) ?? null,
            },
          ]
        : [];
    }),
    questionSlots: Math.max(0, questions.maxPerDay - carried),
    alreadyAsked: ready
      .filter((o) => asked.has(momentID(o.captureId)))
      .map((o) => o.captureId),
    coverage: {
      captured: job.captures.length,
      observed: ready.length,
      missing: job.captures.length - ready.length,
    },
  };
}

const INSTRUCTION_WORDS =
  /\b(ignore|instruction|instructions|system|assistant|prompt|disregard|click|visit|download)\b/i;
const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

/** True when `text` repeats 4 or more consecutive words that appear in photo descriptions. */
function copiesPhotoText(text: string, facts: string[][]): boolean {
  const w = words(text);
  for (let i = 0; i + 4 <= w.length; i++) {
    const run = w.slice(i, i + 4).join(" ");
    if (facts.some((f) => f.join(" ").includes(run))) return true;
  }
  return false;
}

/**
 * Cleans model-written question text. Removes links, emails, phone numbers, long digit
 * runs and control characters; rejects instruction-like text and text copied from photo
 * descriptions, so photographed text cannot become an option the owner taps and the
 * pipeline later trusts as an owner answer.
 */
export function cleanQuestionText(
  raw: string,
  max: number,
  facts: string[][],
): string | null {
  const text = raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ")
    .replace(/\d{4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || /^(yes|no)\.?$/i.test(text)) return null;
  if (INSTRUCTION_WORDS.test(text) || copiesPhotoText(text, facts)) return null;
  return clip(text, max);
}

/**
 * The day's question queue. Questions already asked stay, in order, while their moment
 * exists (sticky). New candidates fill the remaining slots in time order. A candidate is
 * dropped, never failing the recap, if it targets an unknown, duplicate, already-asked or
 * corrected capture, or if fewer than 2 clean options remain.
 */
export function composeQuestions(
  job: Job,
  input: SynthesisInput,
  candidates: RecapDraft["questions"],
  policy: QuestionPolicy,
): { questions: W.ClarifyingQuestion[]; asked: number; dropped: number } {
  const timeline = new Map(input.timeline.map((t, i) => [t.captureId, i]));
  const momentsNow = new Set(input.timeline.map((t) => momentID(t.captureId)));
  const carried = (job.day.recap?.questions ?? []).filter((q) =>
    momentsNow.has(q.momentId),
  );
  const taken = new Set(carried.map((q) => q.momentId));
  const corrected = correctedMoments(job.day);
  const facts = input.timeline.map((t) => words(t.visibleFacts.join(" ")));
  const fresh: Array<{ order: number; question: W.ClarifyingQuestion }> = [];
  let dropped = 0;
  for (const c of candidates) {
    const order = timeline.get(c.captureId);
    const moment = momentID(c.captureId);
    const prompt = cleanQuestionText(c.prompt, 200, facts);
    const labels: string[] = [];
    for (const raw of c.options) {
      const label = cleanQuestionText(raw, 60, facts);
      if (label && !labels.some((l) => l.toLowerCase() === label.toLowerCase()))
        labels.push(label);
    }
    if (
      order === undefined ||
      taken.has(moment) ||
      corrected.has(moment) ||
      !prompt ||
      labels.length < 2
    ) {
      dropped++;
      continue;
    }
    taken.add(moment);
    fresh.push({
      order,
      question: {
        momentId: moment,
        prompt,
        options: labels.slice(0, 3).map((label) => ({ label })),
      },
    });
  }
  fresh.sort((a, b) => a.order - b.order);
  const room = Math.max(0, Math.min(policy.maxPerDay, 10) - carried.length);
  dropped += Math.max(0, fresh.length - room);
  const added = fresh.slice(0, room).map((f) => f.question);
  return { questions: [...carried, ...added], asked: added.length, dropped };
}

/**
 * Builds the wire Recap. The model contributes only text; moments, evidence, coverage and
 * the question queue's targets come from the frozen job, so a model cannot cite a capture
 * it was not given.
 */
export function composeRecap(
  job: Job,
  observations: W.Observation[],
  draft: RecapDraft,
  versions: { providerVersion: string; promptVersion: string },
  places: ReadonlyMap<string, string | null> = new Map(),
  policy: QuestionPolicy = DEFAULT_QUESTIONS,
  stats: { questionsAsked: number; questionsDropped: number } = {
    questionsAsked: 0,
    questionsDropped: 0,
  },
): W.Recap {
  const input = synthesisInput(job, observations, places, policy);
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
  const queue = composeQuestions(job, input, draft.questions, policy);
  stats.questionsAsked = queue.asked;
  stats.questionsDropped = queue.dropped;
  return {
    schemaVersion: 1,
    dayId: job.day.dayId,
    inputRevision: job.day.inputRevision,
    recapRevision: job.nextRecapRevision,
    deletionGeneration: job.day.deletionGeneration,
    state: input.coverage.missing ? "partial" : "ready",
    summary: clip(draft.summary, 4000),
    moments,
    ...(queue.questions.length ? { questions: queue.questions } : {}),
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
