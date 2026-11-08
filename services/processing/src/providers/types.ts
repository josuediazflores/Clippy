import type { Capture } from "../../../backend/src/Wire";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
}
/** What a vision model may say about one photo. The server builds the wire Observation. */
export interface ObservationDraft {
  usable: boolean;
  visibleFacts: string[];
  inferredActivity: string;
  uncertainty: string;
}
export interface ObservationModel {
  readonly providerVersion: string;
  describe(input: {
    capture: Capture;
    image: { bytes: Uint8Array; mediaType: "image/png" | "image/jpeg" };
    localTime: string;
  }): Promise<{ draft: ObservationDraft; usage: ModelUsage; refused: boolean }>;
}
export interface TimelineEntry {
  captureId: string;
  localTime: string;
  visibleFacts: string[];
  inferredActivity: string | null;
  uncertainty: string;
  /** Approximate area label, never coordinates. */
  place: string | null;
}
export interface SynthesisInput {
  date: string;
  timeZone: string;
  timeline: TimelineEntry[];
  /** Owner-written corrections; authoritative. `question` is what was asked, if this answers one. */
  corrections: Array<{
    captureId: string;
    text: string;
    question: string | null;
  }>;
  /** How many new clarifying questions the model may ask in this revision. */
  questionSlots: number;
  /** Captures already asked about today; never ask again. */
  alreadyAsked: string[];
  coverage: { captured: number; observed: number; missing: number };
}
/** What a writing model may produce. Moments, evidence and coverage stay server-side. */
export interface RecapDraft {
  summary: string;
  reflectionPrompt: string;
  titles: Array<{ captureId: string; title: string }>;
  /** Candidate clarifying questions; the server sanitizes, caps or drops them. */
  questions: Array<{ captureId: string; prompt: string; options: string[] }>;
}
export interface SynthesisModel {
  readonly providerVersion: string;
  write(
    input: SynthesisInput,
  ): Promise<{ draft: RecapDraft; usage: ModelUsage; refused: boolean }>;
}
