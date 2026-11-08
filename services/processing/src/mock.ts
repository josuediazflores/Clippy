import { momentID } from "../../backend/src/identity";
import type {
  ObservationProvider,
  RecapProvider,
} from "../../backend/src/ports";
import type { Capture, Day, Observation, Recap } from "../../backend/src/Wire";

export class MockObservationProvider implements ObservationProvider {
  constructor(private readonly failed: ReadonlySet<string> = new Set()) {}
  observe(capture: Capture): Observation {
    return {
      schemaVersion: 1,
      captureId: capture.captureId,
      providerVersion: "mock-1",
      promptVersion: "mock-1",
      preprocessingVersion: "png-1",
      status: this.failed.has(capture.captureId) ? "failed" : "ready",
      visibleFacts: this.failed.has(capture.captureId)
        ? []
        : ["A synthetic color sample was captured."],
      inferredActivity: null,
      uncertainty: "Synthetic image. No real activity or attendance inferred.",
      evidence: [{ type: "capture", id: capture.captureId }],
    };
  }
}
export class MockRecapProvider implements RecapProvider {
  compose(day: Day, observations: Observation[], captures: Capture[]): Recap {
    const available = observations.filter((o) => o.status === "ready");
    const capturedById = new Map(captures.map((c) => [c.captureId, c]));
    const moments = available
      .map((observation) => {
        const capture = capturedById.get(observation.captureId)!;
        const momentId = momentID(capture.captureId);
        const correction = [...day.corrections]
          .reverse()
          .find((c) => c.momentId === momentId && !c.deleted);
        return {
          schemaVersion: 1 as const,
          momentId,
          capturedAt: capture.capturedAt,
          title: correction?.text || `Moment ${capture.sequence}`,
          detail: observation.visibleFacts.join(" "),
          evidence: observation.evidence,
        };
      })
      .sort(
        (a, b) =>
          a.capturedAt.localeCompare(b.capturedAt) ||
          a.momentId.localeCompare(b.momentId),
      );
    const missing = captures.length - available.length;
    // Contract v1.1.0: one sticky clarifying question. Keep any already-asked question
    // whose moment still exists; otherwise ask once about an uncorrected moment.
    const momentIds = new Set(moments.map((m) => m.momentId));
    const corrected = new Set(
      day.corrections
        .filter((c) => !c.deleted && c.text)
        .map((c) => c.momentId),
    );
    const asked = (day.recap?.questions ?? []).filter((q) =>
      momentIds.has(q.momentId),
    );
    // The latest uncorrected moment, so a demo day keeps an open question after the
    // owner corrects an earlier moment.
    const fresh = [...moments]
      .reverse()
      .find((m) => !corrected.has(m.momentId));
    const questions =
      asked.length || day.recap?.questions?.length
        ? asked
        : fresh
          ? [
              {
                momentId: fresh.momentId,
                prompt: "What were you doing here?",
                options: [
                  { label: "Working at a desk" },
                  { label: "Taking a break" },
                  { label: "Reading" },
                ],
              },
            ]
          : [];
    return {
      schemaVersion: 1,
      dayId: day.dayId,
      inputRevision: day.inputRevision,
      recapRevision: (day.recap?.recapRevision ?? 0) + 1,
      deletionGeneration: day.deletionGeneration,
      state: missing ? "partial" : "ready",
      summary: `${available.length} captured moment${available.length === 1 ? "" : "s"} from this synthetic day. ${missing ? "Some observations are unavailable." : "Your recap is up to date with this snapshot."}`,
      moments,
      ...(questions.length ? { questions } : {}),
      reflectionPrompt: "What would you like to remember about this day?",
      coverage: {
        captured: captures.length,
        observed: available.length,
        missing,
        throughAt:
          captures
            .map((c) => c.capturedAt)
            .sort()
            .at(-1) ?? null,
      },
      providerVersion: "mock-1",
      promptVersion: "mock-1",
    };
  }
}
