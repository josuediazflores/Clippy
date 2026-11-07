import { createAwsEngine, readConfig } from "../aws/runtime";

/**
 * Explicit operator command: dispatch at most --limit undispatched outbox entries once and
 * report counts. It never loops, schedules itself or runs without the configured tables.
 * Usage: CLIPPY_TABLE_*=... CLIPPY_MEDIA_BUCKET=... npx tsx services/backend/src/tools/recover.ts --limit 25
 */
async function main(): Promise<void> {
  const index = process.argv.indexOf("--limit");
  const limit = index > 0 ? Number(process.argv[index + 1]) : 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new Error("--limit must be 1-500");
  const config = readConfig();
  const result = await createAwsEngine(config).recover(limit);
  console.log(
    JSON.stringify({
      tables: config.tables.operations,
      limit,
      dispatched: result.dispatched,
      pending: result.pending,
      failed: result.failed,
    }),
  );
  if (result.failed.length) process.exitCode = 1;
}
void main();
