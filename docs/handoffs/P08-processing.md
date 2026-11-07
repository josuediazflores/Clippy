# Phase handoff: P08

## Identity and scope

- Phase/work package: P08 recap pipeline, workflow and evaluation harness.
- Owner: Person 2 lane, implemented with Claude Code at Josue's request.
- Starting commit: `3581ecd` (P04 local_complete, branch `p04-backend`).
- Result branch: `p08-processing`. Milestones: `b88120f` (dependencies), `9cdb83d` (pipeline and workflow). The final commit adds the evaluation harness and docs.
- Files owned/changed: `services/processing/**`, `infra/src/workflow.ts`, the workflow wiring in `infra/src/runtime-stack.ts`, `app.ts` and `assertions.ts`, the pipeline steps in `services/backend/src/domain.ts` (plus ports, keys, runtime), this handoff, `docs/deployment/P08-dev-addendum.md`, and D30 to D37 in `docs/decisions.md`.
- Coordinator-owned files touched: `package-lock.json` and `services/processing/package.json` (`b88120f` only); the root `package.json` `test` script now also runs `services/processing/test/*.test.ts`; `tools/test-dynamodb.sh` runs the processing suites too.
- Dependencies checked: P04 at `local_complete`.
- Status: **local_complete for the pipeline and workflow. The evaluation gate is blocked** on approval of a finite plan, the region and model verification (see "Remaining work").

## Result

- **One code path.** The pipeline steps are the same for the local driver (`Engine.process`, P03's `/local/process`), the local Step Functions-equivalent runner, and the deployed Standard workflow.
- **Replay safety.**
  - Every step re-reads state.
  - A stale revision, a different pipeline version, a deleted day or a vanished job ends `superseded` without model calls.
  - Ready observations are cached per (capture, checksum, pipeline version); failures are not cached.
  - Publication is conditional and atomically enqueues one `recap.published` notification.
- **Model boundary.**
  - Observation drafts and recap text come from a forced, strict tool call through the Anthropic SDK (`AnthropicBedrockMantle` on AWS).
  - The server builds the wire Observation and Recap: moments one-to-one with ready observations, evidence from the frozen job, coverage counted server-side, owner corrections over generated titles. A model cannot cite a capture it was not given.
  - Photographed text is delimited data in the prompt and is never treated as instructions.
- **Spend and failure control.**
  - Image screening runs before any call (format parse, 3.75 MB bound, degenerate frames).
  - Throttles, timeouts and unavailability get bounded exponential retries with full jitter.
  - Invalid output gets one retry, then the capture is a gap; a model refusal is not retried.
  - More than 20% provider failures stops the job before synthesis (`PROVIDER_BATCH_FAILURE`).
  - Usage totals (calls, cached, failed, tokens) are stored on the job and emitted as EMF metrics.
- **Configuration.** The pipeline config is versioned. The default deployment uses free mock models. The Haiku-class observation candidate and the Opus-class and Sonnet-class synthesis candidates are unverified and cannot be called, or even synthesized into a Bedrock deployment, until verified for the region (D06, D35).
- **Workflow.** Standard state machine, history holds IDs and counts only, ERROR logs without execution data. Retry rules come from the same `POLICY` constants the local runner uses, and template assertions compare them state by state.
- **Evaluation harness.** An 8-image synthetic corpus (drawn scenes, including a prompt-injection sign and a covered lens); a runner with automated checks and a human-review rubric; a worst-case cost gate, a 20% stop rule and an approval requirement. The `--dry-run` mode runs free mock models.

## Decisions and compatibility

- Decisions D30 to D37 added.
- Contract changes: none. Engine API additions are internal. `ObservationProvider.observe` takes an optional `CaptureSource`, which the P03 mock ignores.
- Behavior: publication also creates a `recap.published` outbox entry, pending until P10. Deletion-interrupted jobs end superseded.
- Migration: none.

## Verification evidence

Environment as in the P04 handoff (Node 25.6.0 against a 22.23.4 pin, DynamoDB Local 3.3.2). Anthropic SDK 1.3.0, Bedrock SDK 1.1.0.

- `npm test`: 72 tests, 71 pass, 1 skipped (the DynamoDB placeholder). New:
  - 15 pipeline tests: mock publish and replay; screening of an unsupported (GIF declared as PNG) and a degenerate 8 px image with no model call and an honest partial; throttle and timeout retry counts; the 20% stop before synthesis plus a cache-reusing retry; the real Claude adapter rejecting malformed tool output; SDK error mapping with no sampling parameters; invented source rejected; photographed injection delimited and unable to add sources; a correction mid-run superseding (no overwrite, no notification, late duplicate makes no calls); deletion mid-synthesis superseding without a paid retry; refusal; correction precedence; unverified-model refusal and version separation; image header parsing; retry semantics.
  - 4 task-handler tests: all actions, with outputs free of photo text; input validation; conflict mapping; the Bedrock guard.
- `npm run test:dynamodb`: 9 adapter tests, then 62 shared tests on DynamoDB Local including the processing suites (60 pass, 2 memory-only skips), and the bundled API smoke test.
- `npm run check`: all pass. Synth: 12 Data + 73 Runtime resources, 30 template assertions, triggers disabled. A verified Bedrock config synthesizes with exactly `bedrock-mantle:CreateInference`; an unverified one is refused at synthesis.
- `npm run scenario`: passes, UI fixtures unchanged.
- `npx tsx services/processing/eval/run.ts --dry-run`: completes 9 calls with mock models and writes a report under ignored `.local/eval/`. The checks discriminate: mocks fail the "mentions" checks and the covered-lens case. Paid mode refuses an unapproved plan and refuses with no plan.
- Generated corpus images were inspected visually (for example the injection sign).
- Not run: any Bedrock or other model call, model-availability check, Step Functions execution or AWS deployment. No service evidence exists.

## Remaining work and risks

- **Evaluation gate (blocked on approval).** It needs:
  - the region;
  - verification of the candidate Bedrock IDs in that region;
  - real prices;
  - approval of `services/processing/eval/PLAN.md` (8 images, 6 synthesis calls, USD 5 ceiling);
  - a human reviewer.

  Until then the deployed pipeline uses mock models. Do not substitute another model silently.
- **Representative images.** The corpus is drawn and synthetic. Real-scene quality needs a consented, non-Git image set and its own approval.
- **Known limits.**
  - No resizing: images over 3.75 MB are gaps until normalization exists (P05 or a later preprocessing version).
  - Over 200 observed moments fails `MOMENT_LIMIT`.
  - The system prompts are below the cache minimum, so prompt caching is not used.
  - Calendar context (P09) is not part of synthesis input yet.
  - Location labels (Amazon Location) are not implemented.
- **Notifications.** The `recap.published` entries accumulate as pending until P10 adds a notifier; the recovery command reports them as pending.
- **Consumers.**
  - P09 adds calendar context to `synthesisInput` and the prompt (a new prompt version).
  - P10 provides `Notifier` and the APNs path.
  - P05 normalization would allow a new `preprocessingVersion`.

## Next agent instructions

First, review the coordinator-owned changes and the P04 and P08 packets together. Then choose a region with Bedrock access for the candidates.

With approval:
1. Verify the models.
2. Fill in `eval/plan.example.json`.
3. Run the evaluation and complete the human review.
4. Record the selection here.

Deploying with mock models can happen with the P04 packet approvals. Bedrock enablement is a separate approval.

Proposed STATUS update: `P08: local_complete (pipeline, workflow, harness). Person 2, branch p08-processing. Evaluation gate blocked on region, model verification and approved finite plan (USD 5 ceiling proposed). Live workflow evidence blocked on P04 deployment approval.`
