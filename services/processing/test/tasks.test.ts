import test from "node:test";
import assert from "node:assert/strict";
import { setup, upload, capture, app } from "../../backend/test/helpers";
import { Fault, jobIdFor } from "../../backend/src/domain";
import { DEFAULT_CONFIG } from "../src/config";
import { Pipeline, workflowError } from "../src/pipeline";
import {
  checkEvent,
  createTaskHandler,
  type TaskEvent,
} from "../src/lambda/tasks";
import { createModels } from "../src/models";
import type { ObservationModel } from "../src/providers/types";

const dayId = "day_20261107";

test("task handler runs each workflow action and returns only IDs, statuses and counts", async (t) => {
  const h = await setup(t);
  await (await upload(h.engine, [capture(1), capture(2)])).finish();
  const secret =
    "Synthetic visible-text marker that must stay out of execution history";
  const observation: ObservationModel = {
    providerVersion: "fake",
    describe: async () => ({
      draft: {
        usable: true,
        visibleFacts: [secret],
        inferredActivity: "",
        uncertainty: "None.",
      },
      usage: { inputTokens: 5, outputTokens: 5 },
      refused: false,
    }),
  };
  const models = createModels(DEFAULT_CONFIG, undefined);
  t.mock.method(console, "log", () => {});
  const handler = createTaskHandler(
    new Pipeline(
      h.engine,
      { observation, synthesis: models.synthesis },
      DEFAULT_CONFIG,
    ),
  );
  const ref = {
    owner: app.owner,
    dayId,
    jobId: jobIdFor(app.owner, dayId, 1, "mock_1"),
    inputRevision: 1,
  };
  const outputs: unknown[] = [];
  const begun = (await handler({ ...ref, action: "begin" } as TaskEvent)) as {
    captureIds: string[];
  };
  outputs.push(begun);
  const observations = [];
  for (const captureId of begun.captureIds) {
    const result = await handler({
      ...ref,
      action: "observe",
      captureId,
    } as TaskEvent);
    observations.push(result);
    outputs.push(result);
  }
  outputs.push(
    await handler({ ...ref, action: "synthesize", observations } as TaskEvent),
  );
  outputs.push(await handler({ ...ref, action: "publish" } as TaskEvent));
  assert.deepEqual(outputs.at(-1), { status: "published", state: "ready" });
  assert.ok(!JSON.stringify(outputs).includes("Synthetic visible-text marker"));
  assert.ok(
    (await h.engine.getDay(app, dayId)).recap!.moments[0]!.detail.includes(
      "Synthetic visible-text marker",
    ),
  );
});

test("task input must be references; malformed or unknown actions are rejected", () => {
  const ok = {
    owner: "1d2c-ab",
    dayId,
    jobId: "job_abc",
    inputRevision: 1,
    action: "begin",
  } as TaskEvent;
  assert.doesNotThrow(() => checkEvent(ok));
  for (const bad of [
    { ...ok, owner: "USER#x" },
    { ...ok, dayId: "../day" },
    { ...ok, inputRevision: 1.5 },
    { ...ok, action: "delete" },
    { ...ok, action: "observe", captureId: "Cap With Spaces" },
  ])
    assert.throws(() => checkEvent(bad as TaskEvent));
});

test("exhausted optimistic retries surface as a retryable workflow error name", () => {
  assert.equal(
    (workflowError(new Fault(409, "CONFLICT", true)) as Error).name,
    "ConditionalConflict",
  );
  const other = new Fault(404, "NOT_FOUND");
  assert.equal(workflowError(other), other);
});

test("Bedrock models are refused without a verification record for the region", () => {
  assert.throws(
    () => createModels({ ...DEFAULT_CONFIG, provider: "bedrock" }, "us-west-2"),
    /not verified/,
  );
  assert.throws(
    () => createModels({ ...DEFAULT_CONFIG, provider: "bedrock" }, undefined),
    /region/,
  );
});
