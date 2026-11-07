# Verification and release gates

This file describes required future verification. The only checks currently runnable against the repository are documentation checks. P02 creates and documents actual build/test commands. Do not report planned commands or proposed targets as passed results.

## Evidence levels

- **Document reviewed:** contracts, dependencies, and diagrams inspected. No runtime claim.
- **Local tested:** deterministic tests, fixture scenarios, app simulator, local adapters, and infrastructure synthesis.
- **Service tested:** approved development AWS environment, actual authorization/permissions, storage behavior, and finite model calls.
- **Hardware tested:** approved Pi/iPhone builds with actual camera, IMU, screen, storage, BLE, and power behavior.
- **Pilot observed:** approved participant/data use over a defined period, measured coverage/power/cost, and human recap review.

Each handoff names the evidence level and exact source revision. A local mock is never described as live integration. A phase may reach `local_complete` while its live gate waits for approval or hardware.

## Local check interface to establish in P02

Provide finite commands for contracts, backend type/lint/tests, device lint/tests, iOS build/unit/UI tests, CDK synth/assertions, and the local end-to-end scenario. Record exact versions, environment, simulator destination, and invocation in the repository once implemented. A root aggregate command must not deploy, install a service, send messages, or start an unattended watcher.

Baseline fixture cases:

1. A normal day, an empty day, and a day paused for several hours.
2. Daytime snapshot followed by a nightly snapshot of the same day.
3. A two-day offline backlog and an upload crossing midnight.
4. Duplicate and conflicting IDs, stale owner epoch, corrupted media, missing manifest entries.
5. Process termination before/after local file commit, before/after upload, and before/after durable acknowledgement.
6. Duplicate workflow dispatch, stale input revision, revoked device, and deletion during synthesis.
7. Calendar permission denial/revocation, missing page, complete empty window, recurring/all-day events, and stale phone data.
8. Offline user edits, conflicting revisions, and recap regeneration preserving corrections/reflections.
9. Model failure, invalid output, invented source IDs, harmful prompt instructions embedded in source text, and partial coverage.
10. Cross-user attempts against every resource family and an expired signed read URL.

## Mandatory invariants

- A confirmed local pause prevents new camera acquisition until the defined resume action.
- An unacknowledged capture survives tested restarts and storage-management decisions.
- A snapshot is not accepted until all required objects and metadata verify.
- Replaying requests/events does not duplicate captures, moments, user edits, or current recap publication.
- Only a current owner/epoch can request device operations or obtain media access.
- A stale workflow cannot overwrite a newer day revision or resurrect deleted content.
- Calendar refresh failure never masquerades as a complete empty calendar.
- The app never labels stale device knowledge as current or a partial day as fully observed.
- User-authored text survives processing refreshes unchanged unless the user edits/deletes it.
- Private data and secrets are absent from fixtures, Git history, telemetry, and generic error responses.

## UI inspection

Inspect Home/History/Device on a small supported iPhone size and a larger size, with large text and VoiceOver labels. Exercise permission denial, no-device state, no-network state, pending device settings, active upload, processing failure, partial recap, stale calendar, edit conflict, and deletion progress. Verify date/coverage labels and that primary actions remain reachable. No decorative gradients, transparency, or animations are required by the current design.

## Finite model evaluation

Before calling a paid provider, define the fixture count, input/image size bounds, candidate model IDs, output token limits, maximum attempts, concurrency, expected spend ceiling, and stopping rule. Use the same sources across candidates.

Record validity, factual support, valid evidence references, coverage recognition, reflection usefulness, latency, token/usage totals, and human-reviewed failure examples. Keep successful observation outputs for reuse. More than roughly 20% failures in a batch triggers diagnosis, not an automatic full rerun. Ask before an expensive rerun.

Quality targets are proposed product acceptance criteria, not model guarantees. Critical errors include invented sensitive claims, unsupported attendance/identity conclusions, source access across users, and following instructions embedded in source material.

## Deployment approval packet

Prepare this packet before requesting any specific cloud deployment, app upload, or device installation:

1. Source commit and artifact checksum/build identifiers.
2. Environment/account/region and exactly what changes.
3. Local check results and limitations; AWS/CDK resource and IAM diff where relevant.
4. Cost estimate and bounded live test plan.
5. Data used, retention, and deletion verification plan.
6. Migration/backward compatibility and rollback steps.
7. Any recurring work: purpose, frequency/trigger, data/resources modified, enable/disable controls, and stop procedure.

Approval must identify the artifact/environment. A source push, a previous build approval, or the existence of this plan is not deployment approval. TestFlight, production cloud rollout, and device software rollout are separate ships when they contain different artifacts.

## Automation activation record

For each future recurring component, record its owner and stop method:

- **Pi nightly scheduler:** evaluates one user-configured local window and uploads pending captures. Stop via acknowledged automatic-sync toggle or disabling the installed device service. Capture policy is independently controlled.
- **Cloud reconciliation, if introduced:** checks due/stuck operations and retries only bounded idempotent work. Record the chosen frequency and disable its Scheduler resource to stop new invocations; manage active jobs separately.
- **Retention cleanup:** removes eligible data according to the approved policy. Document lifecycle/worker schedules and disabling behavior; stopping a schedule does not restore deleted data.
- **CI or dependency tooling, if introduced:** record events, permissions, and effects. Prefer check-only CI; deployment still requires approval for each candidate. Do not install it merely because a phase mentions tests.

These are descriptions to prepare and approve, not jobs to enable during documentation work.

## Release gate

P13 requires local, service, hardware, and finite pilot evidence appropriate to the actual release scope. All privacy invariants pass, open defects are classified, raw/derived retention behavior is explainable, and support/recovery ownership exists. If mail is deferred, keep it absent from the released feature promises. If any required evidence is missing, report the exact incomplete gate rather than calling the product ready.
