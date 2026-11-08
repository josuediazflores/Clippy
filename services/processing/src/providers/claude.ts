import Anthropic from "@anthropic-ai/sdk";
import type { ModelChoice } from "../config";
import {
  InvalidProviderOutput,
  ProviderRejected,
  ProviderThrottled,
  ProviderTimeout,
  ProviderUnavailable,
} from "../errors";
import {
  OBSERVATION_SYSTEM,
  OBSERVATION_TOOL,
  SYNTHESIS_SYSTEM,
  SYNTHESIS_TOOL,
  synthesisUserMessage,
} from "../prompts";
import type {
  ModelUsage,
  ObservationDraft,
  ObservationModel,
  RecapDraft,
  SynthesisInput,
  SynthesisModel,
} from "./types";

/** The subset of the Anthropic client (first-party or AnthropicBedrockMantle) used here. */
export interface MessagesClient {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number },
    ): PromiseLike<Anthropic.Message>;
  };
}

/** Typed SDK errors, most specific first, mapped to the workflow's retry vocabulary. */
async function call(
  fn: () => PromiseLike<Anthropic.Message>,
): Promise<Anthropic.Message> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError)
      throw new ProviderThrottled("rate limited");
    if (error instanceof Anthropic.APIConnectionTimeoutError)
      throw new ProviderTimeout("timed out");
    if (error instanceof Anthropic.APIConnectionError)
      throw new ProviderUnavailable("connection");
    if (error instanceof Anthropic.InternalServerError)
      throw new ProviderUnavailable(`status ${error.status}`);
    if (error instanceof Anthropic.APIError)
      throw new ProviderRejected(`status ${error.status ?? "unknown"}`);
    throw error;
  }
}
function toolInput(response: Anthropic.Message, name: string): unknown {
  if (response.stop_reason === "max_tokens")
    throw new InvalidProviderOutput("truncated");
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock =>
      b.type === "tool_use" && b.name === name,
  );
  if (!block) throw new InvalidProviderOutput("missing tool call");
  return block.input;
}
const usage = (response: Anthropic.Message): ModelUsage => ({
  inputTokens: response.usage.input_tokens,
  outputTokens: response.usage.output_tokens,
});
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export class ClaudeObservationModel implements ObservationModel {
  readonly providerVersion: string;
  constructor(
    private readonly client: MessagesClient,
    private readonly choice: ModelChoice,
  ) {
    this.providerVersion = choice.id.slice(0, 64);
  }
  async describe(input: Parameters<ObservationModel["describe"]>[0]) {
    const response = await call(() =>
      this.client.messages.create(
        {
          model: this.choice.id,
          max_tokens: this.choice.maxOutputTokens,
          system: OBSERVATION_SYSTEM,
          tools: [OBSERVATION_TOOL],
          // Opus 5.5 on Bedrock rejects forced tool_choice ("tool"/"any"). The prompt requires the
          // tool, and toolInput() rejects any reply without it, so output stays strict (D51).
          tool_choice: { type: "auto" },
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: input.image.mediaType,
                    data: Buffer.from(input.image.bytes).toString("base64"),
                  },
                },
                {
                  type: "text",
                  text: `Photo taken at ${input.localTime} local time. Describe it.`,
                },
              ],
            },
          ],
        },
        { timeout: this.choice.timeoutMs },
      ),
    );
    if (response.stop_reason === "refusal")
      return {
        draft: {
          usable: false,
          visibleFacts: [],
          inferredActivity: "",
          uncertainty: "Declined.",
        },
        usage: usage(response),
        refused: true,
      };
    const value = toolInput(
      response,
      OBSERVATION_TOOL.name,
    ) as Partial<ObservationDraft>;
    if (
      typeof value?.usable !== "boolean" ||
      !isStringArray(value.visibleFacts) ||
      typeof value.inferredActivity !== "string" ||
      typeof value.uncertainty !== "string"
    )
      throw new InvalidProviderOutput("observation shape");
    return {
      draft: value as ObservationDraft,
      usage: usage(response),
      refused: false,
    };
  }
}

export class ClaudeSynthesisModel implements SynthesisModel {
  readonly providerVersion: string;
  constructor(
    private readonly client: MessagesClient,
    private readonly choice: ModelChoice,
  ) {
    this.providerVersion = choice.id.slice(0, 64);
  }
  async write(input: SynthesisInput) {
    const response = await call(() =>
      this.client.messages.create(
        {
          model: this.choice.id,
          max_tokens: this.choice.maxOutputTokens,
          system: SYNTHESIS_SYSTEM,
          tools: [SYNTHESIS_TOOL],
          tool_choice: { type: "auto" },
          messages: [{ role: "user", content: synthesisUserMessage(input) }],
        },
        { timeout: this.choice.timeoutMs },
      ),
    );
    if (response.stop_reason === "refusal")
      return {
        draft: { summary: "", reflectionPrompt: "", titles: [] },
        usage: usage(response),
        refused: true,
      };
    const value = toolInput(
      response,
      SYNTHESIS_TOOL.name,
    ) as Partial<RecapDraft>;
    if (
      typeof value?.summary !== "string" ||
      typeof value.reflectionPrompt !== "string" ||
      !Array.isArray(value.titles) ||
      !value.titles.every(
        (t) =>
          t && typeof t.captureId === "string" && typeof t.title === "string",
      )
    )
      throw new InvalidProviderOutput("recap shape");
    return {
      draft: value as RecapDraft,
      usage: usage(response),
      refused: false,
    };
  }
}
