/**
 * Error names are the Step Functions retry/catch match keys (Lambda reports `name` as the
 * error type). Retryable: throttling, timeouts and provider unavailability.
 */
export class ProviderThrottled extends Error {
  override readonly name = "ProviderThrottled";
}
export class ProviderTimeout extends Error {
  override readonly name = "ProviderTimeout";
}
export class ProviderUnavailable extends Error {
  override readonly name = "ProviderUnavailable";
}
/** The provider rejected the request (4xx other than throttling). Not retried. */
export class ProviderRejected extends Error {
  override readonly name = "ProviderRejected";
}
/** A pipeline bound was exceeded; retrying cannot help. */
export class PipelineLimitExceeded extends Error {
  override readonly name = "PipelineLimitExceeded";
}
export { InvalidProviderOutput } from "../../backend/src/domain";

export const RETRYABLE_PROVIDER_ERRORS = [
  "ProviderThrottled",
  "ProviderTimeout",
  "ProviderUnavailable",
] as const;
/** Failure reasons that count toward the provider batch-failure stop rule. */
export const PROVIDER_FAILURE_REASONS = new Set<string>([
  ...RETRYABLE_PROVIDER_ERRORS,
  "ProviderRejected",
  "ProviderInvalidOutput",
  "States.Timeout",
  "States.TaskFailed",
  "Lambda.ServiceException",
  "Lambda.TooManyRequestsException",
]);
