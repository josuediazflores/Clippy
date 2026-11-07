import { digest } from "../../backend/src/contracts";

/** Evidence that a model ID works in a region. Written only after an approved check. */
export interface ModelVerification {
  region: string;
  verifiedAt: string;
  method: string;
}
export interface ModelChoice {
  /** Bedrock model ID as used by the Anthropic Bedrock Mantle client. */
  id: string;
  maxOutputTokens: number;
  timeoutMs: number;
  /** null until checked in the deployment region. Unverified models are never called (D06). */
  verified: ModelVerification | null;
}
export interface PipelineConfig {
  provider: "mock" | "bedrock";
  observation: ModelChoice & {
    promptVersion: string;
    preprocessingVersion: string;
  };
  synthesis: ModelChoice & { promptVersion: string };
  /** Observation fan-out per job (Step Functions Map MaxConcurrency). */
  concurrency: number;
  /** Conservative image bound for provider requests; larger images are not sent. */
  maxImageBytes: number;
  /** Degenerate frames below this edge length are not sent to a model. */
  minImageDimension: number;
  /** Stop before synthesis when provider failures exceed this fraction of a job. */
  providerFailureThreshold: number;
  /** Optional list prices for usage estimates, USD per million tokens. Unset until verified. */
  prices: { observation: TokenPrice | null; synthesis: TokenPrice | null };
}
export interface TokenPrice {
  input: number;
  output: number;
}

/**
 * Candidates named by the plan (D06): a Haiku-class observation model and an Opus-class
 * synthesis model compared with a cheaper Sonnet-class option. IDs follow the current
 * Claude family; Bedrock availability, ID prefixes and inference profiles must be
 * confirmed in the chosen region before any of them is marked verified.
 */
export const CANDIDATES = {
  observation: ["anthropic.claude-haiku-5-5"],
  synthesis: ["anthropic.claude-opus-5-5", "anthropic.claude-sonnet-5-5"],
} as const;

export const DEFAULT_CONFIG: PipelineConfig = {
  provider: "mock",
  observation: {
    id: CANDIDATES.observation[0],
    maxOutputTokens: 600,
    timeoutMs: 60_000,
    verified: null,
    promptVersion: "obs_v1",
    preprocessingVersion: "raw_v1",
  },
  synthesis: {
    id: CANDIDATES.synthesis[0],
    maxOutputTokens: 4000,
    timeoutMs: 120_000,
    verified: null,
    promptVersion: "recap_v1",
  },
  concurrency: 4,
  maxImageBytes: 3_750_000,
  minImageDimension: 32,
  providerFailureThreshold: 0.2,
  prices: { observation: null, synthesis: null },
};

/**
 * Job and observation-cache identity. Any change to the models, prompts or preprocessing
 * yields a new version, so results from one configuration never satisfy another.
 */
export function pipelineVersion(config: PipelineConfig): string {
  if (config.provider === "mock") return "mock_1";
  return (
    "pipe_" +
    digest({
      provider: config.provider,
      observation: [
        config.observation.id,
        config.observation.promptVersion,
        config.observation.preprocessingVersion,
      ],
      synthesis: [config.synthesis.id, config.synthesis.promptVersion],
    }).slice(0, 16)
  );
}

export function assertCallable(choice: ModelChoice, region: string): void {
  if (!choice.verified || choice.verified.region !== region)
    throw new Error(
      `Model ${choice.id} is not verified for ${region}; refusing to call it (D06).`,
    );
}
