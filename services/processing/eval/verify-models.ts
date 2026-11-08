/**
 * Model verification for a region (D06). One minimal call per model through the same
 * AnthropicBedrockMantle client the pipeline uses; prints the `verified` evidence to record in a
 * reviewed pipeline config. Each call is capped at 8 output tokens (well under USD 0.001).
 *
 *   AWS_PROFILE=... npx tsx services/processing/eval/verify-models.ts us-east-1 MODEL_ID [MODEL_ID...]
 */
import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";

async function main(): Promise<void> {
  const [region, ...models] = process.argv.slice(2);
  if (!region || models.length === 0)
    throw new Error("usage: verify-models.ts REGION MODEL_ID [MODEL_ID...]");
  const client = new AnthropicBedrockMantle({
    awsRegion: region,
    maxRetries: 0,
  });
  let failed = false;
  for (const model of models) {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: "user", content: "Reply with the single word OK." }],
      });
      const verified = {
        region,
        verifiedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        method: `messages.create via AnthropicBedrockMantle, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`,
      };
      console.log(`${model}: OK ${JSON.stringify(verified)}`);
    } catch (error) {
      failed = true;
      const status = (error as { status?: number }).status;
      console.log(
        `${model}: FAILED ${status ?? ""} ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`,
      );
    }
  }
  if (failed) process.exit(1);
}

void main();
