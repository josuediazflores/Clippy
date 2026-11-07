import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { assertCallable, DEFAULT_CONFIG, type PipelineConfig } from "./config";
import {
  ClaudeObservationModel,
  ClaudeSynthesisModel,
  type MessagesClient,
} from "./providers/claude";
import {
  MockObservationModel,
  MockSynthesisModel,
} from "./providers/mock-models";
import type { ObservationModel, SynthesisModel } from "./providers/types";

/** Reads the deployed configuration. Anything malformed falls back to nothing, not to a guess. */
export function readPipelineConfig(
  env: NodeJS.ProcessEnv = process.env,
): PipelineConfig {
  const raw = env.CLIPPY_PIPELINE_CONFIG;
  if (!raw) return DEFAULT_CONFIG;
  const parsed = JSON.parse(raw) as PipelineConfig;
  if (
    !["mock", "bedrock"].includes(parsed.provider) ||
    !parsed.observation?.id ||
    !parsed.synthesis?.id
  )
    throw new Error("Invalid CLIPPY_PIPELINE_CONFIG");
  return parsed;
}

/**
 * Bedrock models go through the Anthropic SDK's Bedrock Mantle client with the Lambda role's
 * SigV4 credentials. SDK retries are off: the workflow owns bounded retries (policy.ts).
 */
export function createModels(
  config: PipelineConfig,
  region: string | undefined,
): { observation: ObservationModel; synthesis: SynthesisModel } {
  if (config.provider === "mock")
    return {
      observation: new MockObservationModel(),
      synthesis: new MockSynthesisModel(),
    };
  if (!region) throw new Error("A region is required for Bedrock models");
  assertCallable(config.observation, region);
  assertCallable(config.synthesis, region);
  const client = new AnthropicBedrockMantle({
    awsRegion: region,
    maxRetries: 0,
  });
  const messages = client as unknown as MessagesClient;
  return {
    observation: new ClaudeObservationModel(messages, config.observation),
    synthesis: new ClaudeSynthesisModel(messages, config.synthesis),
  };
}
