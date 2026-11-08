import type { ObservationModel, SynthesisModel } from "./types";

/** Deterministic, free models for local runs and dev deployments without model access. */
export class MockObservationModel implements ObservationModel {
  readonly providerVersion = "mock-1";
  async describe() {
    return {
      draft: {
        usable: true,
        visibleFacts: ["A synthetic color sample was captured."],
        inferredActivity: "",
        uncertainty:
          "Synthetic image. No real activity or attendance inferred.",
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      refused: false,
    };
  }
}
export class MockSynthesisModel implements SynthesisModel {
  readonly providerVersion = "mock-1";
  async write(input: Parameters<SynthesisModel["write"]>[0]) {
    const n = input.coverage.observed;
    return {
      draft: {
        summary: `${n} captured moment${n === 1 ? "" : "s"} from this synthetic day.${input.coverage.missing ? " This recap covers part of the day." : ""}`,
        reflectionPrompt: "What would you like to remember about this day?",
        titles: [],
      },
      usage: { inputTokens: 0, outputTokens: 0 },
      refused: false,
    };
  }
}
