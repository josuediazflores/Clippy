import { RETRYABLE_PROVIDER_ERRORS } from "./errors";

/**
 * Retry and concurrency policy shared by the Step Functions definition and the local
 * runner, so tests exercise the same bounds that production uses.
 */
export interface RetryRule {
  errors: readonly string[];
  intervalSeconds: number;
  maxAttempts: number;
  backoffRate: number;
  maxDelaySeconds: number;
}
const LAMBDA_TRANSIENT = [
  "Lambda.ServiceException",
  "Lambda.AWSLambdaException",
  "Lambda.SdkClientException",
  "Lambda.TooManyRequestsException",
];
export const POLICY = {
  observe: [
    {
      errors: [...RETRYABLE_PROVIDER_ERRORS, ...LAMBDA_TRANSIENT],
      intervalSeconds: 2,
      maxAttempts: 3,
      backoffRate: 2,
      maxDelaySeconds: 20,
    },
    {
      errors: ["ProviderInvalidOutput"],
      intervalSeconds: 1,
      maxAttempts: 1,
      backoffRate: 1,
      maxDelaySeconds: 1,
    },
  ],
  synthesize: [
    {
      errors: [...RETRYABLE_PROVIDER_ERRORS, ...LAMBDA_TRANSIENT],
      intervalSeconds: 5,
      maxAttempts: 3,
      backoffRate: 2,
      maxDelaySeconds: 60,
    },
    {
      errors: ["ProviderInvalidOutput"],
      intervalSeconds: 1,
      maxAttempts: 1,
      backoffRate: 1,
      maxDelaySeconds: 1,
    },
  ],
  step: [
    {
      errors: [...LAMBDA_TRANSIENT, "ConditionalConflict"],
      intervalSeconds: 1,
      maxAttempts: 3,
      backoffRate: 2,
      maxDelaySeconds: 10,
    },
  ],
} satisfies Record<string, RetryRule[]>;
