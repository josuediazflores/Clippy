import test from "node:test";
import assert from "node:assert/strict";
import { setup, upload, capture, app } from "./helpers";
import { Fault } from "../src/domain";
import { validate } from "../src/contracts";
import {
  MockObservationProvider,
  MockRecapProvider,
} from "../../processing/src/mock";
import type { ClarifyingQuestion, Recap } from "../src/Wire";

const dayId = "day_20261107";
const invalid = (e: unknown) =>
  e instanceof Fault && e.code === "INVALID_REQUEST";
const ask = (
  momentId: string,
  labels = ["Working at a desk", "Taking a break", "Reading"],
): ClarifyingQuestion => ({
  momentId,
  prompt: "What were you doing here?",
  options: labels.map((label) => ({ label })),
});

async function candidate(engine: Awaited<ReturnType<typeof setup>>["engine"]) {
  const job = await engine.prepareJob(app.owner, dayId);
  const recap: Recap = new MockRecapProvider().compose(
    job.day,
    job.captures.map((c) => new MockObservationProvider().observe(c)),
    job.captures,
  );
  // The mock may add its own question; tests set questions explicitly.
  delete recap.questions;
  return { job, recap };
}

test("a valid clarifying question publishes and is served on the day", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  const { job, recap } = await candidate(engine);
  recap.questions = [ask("moment_cap_sample_002")];
  const day = await engine.publish(job, recap);
  validate("Day", day);
  assert.equal(day.recap?.questions?.[0]?.momentId, "moment_cap_sample_002");
});

test("questions must target this recap's moments, once each, with distinct labels", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  const cases: ClarifyingQuestion[][] = [
    [ask("moment_cap_invented")],
    [ask("moment_cap_sample_001"), ask("moment_cap_sample_001")],
    [ask("moment_cap_sample_001", ["Reading", "reading "])],
    Array.from({ length: 11 }, () => ask("moment_cap_sample_001")),
  ];
  for (const questions of cases) {
    const { job, recap } = await candidate(engine);
    recap.questions = questions;
    await assert.rejects(engine.publish(job, recap), invalid);
  }
});

test("a new question never targets a corrected moment, but an asked one stays in the queue", async (t) => {
  const { engine } = await setup(t);
  await (await upload(engine, [capture(1), capture(2)])).finish();
  const first = await candidate(engine);
  first.recap.questions = [ask("moment_cap_sample_001")];
  await engine.publish(first.job, first.recap);
  // The owner answers question 1 by saving a correction, and corrects moment 2 directly.
  for (const [moment, text] of [
    ["moment_cap_sample_001", "Taking a break"],
    ["moment_cap_sample_002", "Lunch"],
  ] as const)
    await engine.saveEdit(app, "correction", moment, `correction_${moment}`, {
      schemaVersion: 1,
      operationId: `answer_${moment}`,
      expectedRevision: 0,
      text,
      deleted: false,
    });
  const next = await candidate(engine);
  next.recap.questions = [ask("moment_cap_sample_002")];
  await assert.rejects(engine.publish(next.job, next.recap), invalid);
  next.recap.questions = [ask("moment_cap_sample_001")];
  const day = await engine.publish(next.job, next.recap);
  assert.deepEqual(
    day.recap?.questions?.map((q) => q.momentId),
    ["moment_cap_sample_001"],
  );
});
