# Phase handoff: P03

## Identity and scope

- Phase/work package: local capture-to-recap vertical slice and shared foundation acceptance.
- Owner: Codex coordinator.
- Starting commit: `18bd283d69fd1c63d848755b139ede14988aee6a` (accepted P02).
- Result commit/branch: `foundation/p01-p03`; the final revision record identifies the tested source commit.
- Files owned/changed: local backend/object/persistence adapters, deterministic processing providers, Python upload simulator/checkpoints, iPhone repositories/cache/views/UI tests, shared validation/tools, synthetic UI fixtures, evidence and documentation.
- Dependencies checked: P01 `cb3ed600dc3d0dac80c3987698d38e65124b5c81`; P02 `18bd283d69fd1c63d848755b139ede14988aee6a`.
- Status: local_complete after the checks recorded below. No service or hardware completion is claimed.

## Result

A finite command generates two synthetic captures in Python, uploads them over loopback HTTP, validates grants/manifest/size/SHA-256, persists an ingestion receipt, and runs deterministic observation and recap providers. The SwiftUI app fetches the resulting typed day and writes a correction and reflection over the API. A second synthetic nightly snapshot repeats one capture and adds another: the final day has three unique moments and preserves both user edits and their revisions. No nightly schedule exists.

The app renders empty, pending, partial, ready, failure, and offline states from generated domain data. It shows snapshot coverage and keeps calendar freshness separate. Offline reading uses the previously fetched cache; offline saves are disabled in this slice. Successful reflection saving dismisses the keyboard so tabs remain reachable. History and Device are minimal local views; Sync now reports waiting for the simulated device rather than claiming an upload started.

Local ingestion survives separate-process restarts. Checkpoints before local PUT acknowledgement, after one upload, after manifest upload, and after server receipt but before device acknowledgement resume without duplicate captures. Successful PUT alone never marks the queue acknowledged or removes images.

## Decisions and compatibility

- D13-D17 record toolchains, adapter scope, temporary cache choice, finite harness, and two-person ownership.
- Wire version remains v1.0.0. Swift generated names avoid Foundation/Observation collisions; JSON is unchanged.
- Consumers: Python simulator, TypeScript API/domain/mock providers, and Swift Codable/validator/repository/UI.
- Stable bounded moment IDs handle the maximum capture ID size. Recap revisions remain monotonic after deletion clears the generated body. Receipts are immutable copies. User edits remain separate records.
- Local state is disposable synthetic data. No production migration or rollout occurred. Remove this task's generated scenario directory to reset it; do not reset a future production store this way.

## Verification evidence

Environment: Node 22.23.4, npm 11.8.0, CPython 3.12.13, uv 0.11.21, TypeScript 5.9.3, Xcode 26.6 (17F113), Swift 6.3.3, iOS 26.5 Simulator. Minimum deployment target is iOS 18; that older runtime is not installed/tested.

- `npm run check`: generated models match schemas; Python validates OpenAPI/JSON Schema; Swift, TypeScript, and Python agree on 32 fixtures and 363 state/revision cases each; strict TypeScript compilation, lint/format, Python lint and simulator test, Swift package tests, and empty CDK synth pass.
- `npm test`: 24 backend/HTTP tests pass. Includes duplicate/conflicting requests, immutable receipts, bad sizes/hashes, corrupted stored objects, incomplete/duplicate manifests, changed capture metadata, restart recovery, unauthorized/unknown/revoked devices, stale epochs, expired grants, stale recap publication, invented evidence, duplicate moments, partial/failure states, user revision conflicts, capture/day/account deletion, no resurrection, monotonic revisions, long IDs, backlog/clock quarantine, scoped pagination, and sync coalescing/cancellation.
- `npm run scenario`: repeatable two-snapshot flow passes; reports 2 then 3 unique moments, preserved correction/reflection revisions, duplicate replay, and interrupted-upload recovery.
- `npm run demo`: simulator app and two UI tests pass on iPhone 17e. The harness verifies the exact iPhone-written text and revision 2 on the local server, independently of UI labels. Offline reading retains the recap.
- `CLIPPY_SIMULATOR_ID=80875337-2700-4A9B-A21A-8465504042B0 npm run demo`: larger iPhone 17 Pro Max UI verification, including Home/History/Device, Sync now, and large text. Both UI tests passed; Home/History/Device, saved edits, offline cache, all domain states, and large text were inspected.
- `CLIPPY_CLEAN_UI=1 CLIPPY_SIMULATOR_ID=80875337-2700-4A9B-A21A-8465504042B0 uv run python tools/clean-check.py`: passed on the final implementation. An isolated source export installed locked dependencies, passed all checks above, built both simulator architectures from fresh directories, and passed the full scenario and both UI tests. The temporary source export was removed; its report and screenshots are retained.
- `git diff --check`: passed. Documentation links, excluded files, and secret/source-data checks are recorded in the final evidence note.

Evidence is [the local report](../evidence/P03-local-report.json), [UI evidence](../evidence/ui/01-ready.png), and [verification notes](../evidence/P03-verification.md). Full local build/test logs and xcresult bundles are ignored under `.local/evidence/`. Screenshots contain only synthetic data.

Rendered UI was inspected for the six states, coverage wording, readable wrapping, reachable edit controls, saved text, and cached offline content. Large text wraps and scrolls. Accessibility identifiers support the journey; an actual VoiceOver listening pass is not claimed.

Fixed failures before acceptance: Python skipped hidden editable `.pth` files, so finite launchers now set the checkout's package path explicitly; generated Swift names collided with platform types; a lost post-receipt checkpoint needed completion reconciliation before grant renewal; mutable receipts needed copying; deletion needed to retain unrelated capture bytes and keep recap revision counters; UI text replacement needed a reliable end-of-text cursor; the reflection keyboard needed dismissal before navigation. A disk-full simulator attempt was stopped and its failed outputs removed. Debugger-version diagnostic warnings from Xcode did not fail the accepted tests.

## Remaining work and risks

- No local blocker remains for the two development lanes. The first unimplemented phases are P04, P05, and P06.
- Local JSON/files are single-process adapters, not distributed transactions, a cloud outbox, encrypted storage, or proof against power loss. The Python simulator retains all test images; it is not the P05 capture scheduler/SQLite runtime.
- Real Cognito JWTs, IoT mTLS/topic policies, S3 signed-header enforcement/read URL expiry, DynamoDB transactions, Step Functions dispatch/recovery, Bedrock quality/cost, notifications, and AWS isolation remain unverified. P04/P08/P10 own them.
- Pi/OS/camera/IMU/display/power/location, pause gestures, secure pairing, encryption/key unlock, physical device storage, and real connectivity remain unresolved or untested. P05/P07 need Josue's hardware decisions.
- EventKit permission/revocation/background refresh is unimplemented. The staged Calendar contract is ready for P09; mail remains deferred.
- Deletion proves local server removal/tombstone behavior. Receipts honestly remain `waiting_for_clients`; offline device cleanup, backups, issued URLs, and physical erasure are not verified.
- Full iOS onboarding/auth, persistent edit outbox/conflict journeys, SwiftData migrations, permission screens, VoiceOver listening, and iOS 18/physical-iPhone behavior belong to P06 and later.
- Every deployment, device installation, build upload, paid evaluation, or activation of recurring work still needs its applicable explicit approval. This is a local development foundation, not a release candidate.

## Next agent instructions

Both developers branch from the accepted `main` head and run the documented setup, `npm run check`, and `npm run demo` once. Do not change wire meanings independently.

**Person 1: device and iPhone.** Begin P05 and P06 in parallel within your own lane. Own `device/clippy_device/`, `device/tests/`, `apps/ios/App/`, handwritten `apps/ios/Core/Sources/ClippyCore/`, and iOS tests. Start with `ports.py`, `sync.py`, `Ports.swift`, `Repositories.swift`, and `JournalModel.swift`. Replace simulated hardware/platform adapters behind those boundaries. Keep the local HTTP client and deterministic fixtures as integration tests. Do not edit generated `Wire.swift` directly. Coordinate project.yml/project.pbxproj and shared fixture changes with the coordinator. Hardware installation, real capture, and BLE pairing wait for their decisions and approval.

**Person 2: backend and AI.** Begin P04 in `services/backend/` and `infra/`. Own `domain.ts`, `http.ts`, `ports.ts`, backend tests, and local/AWS adapter implementations. Read the tests before replacing persistence: preserve owner/epoch checks, immutable receipts, manifest verification, publication conditions, and deletion behavior. Keep the zero-resource CDK baseline until a P04 resource proposal is reviewed. Begin P08 in `services/processing/` only after P04's local gate is accepted; keep `MockObservationProvider` and `MockRecapProvider` for repeatable tests. Do not edit generated `Wire.ts` directly. Live AWS and paid model work require the account/region/budget/model decisions and specific approval.

**Shared coordinator ownership:** `contracts/`, shared `fixtures/`, `tools/`, root package/lock/toolchain files, generated models, Xcode project configuration, `docs/STATUS.md`, and integration evidence. Contract changes must update examples, all three consumers, compatibility tests, and migration notes in one review. Person 1 and Person 2 can coordinate shared changes through one nominated person; do not both edit the locks/ledger independently.

P07 pairing is joint work after P04/P05/P06. P09 Calendar joins Person 1's EventKit adapter with Person 2's staged backend contract after P04/P06. No P04-or-later implementation was undertaken in this task.
