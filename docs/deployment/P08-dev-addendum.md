# P08 addendum to the P04 development deployment packet

Status: **ready to ship, not approved.** This extends [the P04 packet](P04-dev-packet.md) for the same account, region and approval steps. Nothing has been deployed and no model has been called.

## Added to `ClippyRuntime-dev` (9 resources, 73 total)

- `RecapWorkflow`: a Step Functions Standard state machine (Begin, Map over captures with MaxConcurrency 4, Synthesize, Publish, MarkFailed). One-hour timeout. Logs at ERROR level without execution data, 30-day retention.
- Task function (Node 22, ARM64, 1024 MB, 180 s). Item-level table access, data-key use, and `s3:GetObject` on `u/*`. No S3 write, no IoT, no API exposure.
- Dispatcher: gains `CLIPPY_RECAP_STATE_MACHINE_ARN` and `states:StartExecution` on that one state machine.
- A `WorkflowFailures` alarm (no action, like the others).

## Model configuration

- Default: `provider: "mock"`, free deterministic models, pipeline version `mock_1`. Deploying this needs no model access and incurs no model spend.
- Bedrock: requires a reviewed config file passed with `-c clippy:pipelineConfig=PATH -c clippy:region=REGION`. Synthesis refuses unless both models are verified for that region. Only then is the single grant added: `bedrock-mantle:CreateInference` on `arn:aws:bedrock-mantle:REGION:ACCOUNT:project/*`. This is a separate approval that follows the approved evaluation in `services/processing/eval/PLAN.md`.

## When work runs

Executions start only from the outbox dispatcher (disabled unless approved, see packet section 7) or a manual `StartExecution`. There is no schedule. One execution per (owner, day, revision, pipeline version); duplicates are rejected by name. **Stop:** disable the dispatcher mapping. In-flight executions can be stopped with `aws stepfunctions stop-execution`. A stopped job leaves the day pending and the recovery command can restart it.

## Cost (list prices to re-check)

Step Functions Standard costs about USD 0.025 per 1,000 state transitions. A 96-capture day is roughly 300 transitions, about USD 0.008 per job. The task Lambda and logs are negligible at test volume. With mock models, model spend is zero. Bedrock spend depends on the approved models; the evaluation plan bounds it at USD 5 for the finite comparison.

## Live checks after approval (synthetic data)

1. With the dispatcher enabled and mock models: complete a snapshot. The execution ends `Done`, and the day is `ready` with mock text.
2. Save a correction mid-run (or start a duplicate execution for an old revision). It ends `SupersededDuringWork` or `NothingToDo` without overwriting the newer day.
3. Confirm the execution history and logs contain only IDs, statuses and counts.
4. Delete the capture during a run. No recap includes it, and the execution does not fail.
