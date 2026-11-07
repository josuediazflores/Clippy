/** Structured operational logs. Only identifiers, codes, counts and durations are accepted. */
export type SafeValue = string | number | boolean | null;
const SAFE_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const UNSAFE_TEXT = /https?:\/\/|X-Amz-|Bearer |eyJ[a-zA-Z0-9_-]{10,}/;

export function safeLog(
  event: string,
  fields: Record<string, SafeValue>,
): void {
  const record: Record<string, SafeValue> = { event };
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_KEY.test(key)) continue;
    if (
      typeof value === "string" &&
      (value.length > 160 || UNSAFE_TEXT.test(value))
    )
      record[key] = "[redacted]";
    else record[key] = value;
  }
  console.log(JSON.stringify(record));
}

/** CloudWatch embedded metric format; emits a metric without an extra API call. */
export function metric(
  name: string,
  value: number,
  dimensions: Record<string, string> = {},
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "Clippy",
            Dimensions: [Object.keys(dimensions)],
            Metrics: [{ Name: name, Unit: "Count" }],
          },
        ],
      },
      ...dimensions,
      [name]: value,
    }),
  );
}
