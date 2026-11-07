# Decisions and unresolved inputs

Updated 2026-11-07. Product requirements below come from the project discussion. Technical choices are a proposed baseline, not evidence of completed implementation.

## Confirmed product requirements

- Clippy is intended to be an iPhone app with a wearable companion.
- The primary purpose is daily recap and reflection.
- The hardware owner designs the Raspberry Pi, battery, IMU, camera, and screen assembly.
- The device supports a local gesture to pause camera capture and indicates its state on the screen.
- Nightly automatic sync is the preferred routine, with user-initiated daytime sync as an option.
- The first optional account context is Apple Calendar.
- Mail context is desired if a supported integration is available.
- AWS is the preferred cloud platform.
- A QR on the device should support onboarding/pairing.

## Proposed technical baseline

### D01: Separate capture, transfer, and analysis

The Pi persists captures locally. A shared sync engine handles manual and nightly transfer. Only verified complete snapshots enter processing. This supports intermittent connectivity and avoids confusing upload success with a ready recap.

### D02: Native app and typed service boundaries

Use SwiftUI, a local cache/edit outbox, TypeScript Lambda/CDK, and Python device adapters. Freeze shared contracts before component implementation. This is a proposed stack for the empty repository, not a migration from existing code.

### D03: Visual cloud orchestration

Use Step Functions Standard to make stages and failures inspectable by the team. Lambda tasks are short and retryable. No autonomous AI agents or EC2 service are needed for the first workflow. Revisit orchestration only with a documented reason.

### D04: Immutable captures and replaceable generated recaps

Capture identities and verified object references are durable. Generated recap revisions are separate from user-authored corrections and reflections. Conditional publication prevents stale processing from overriding newer inputs.

### D05: Own the nightly schedule on the device

The Pi can initiate uploads without the iPhone app running. iOS background updates enrich Calendar context opportunistically. Cloud scheduled jobs are for reconciliation if needed, not a guarantee that offline hardware connects.

### D06: No early lock-in to model names or mailbox access

Evaluate a Haiku observation candidate and Opus synthesis candidate against representative fixtures and a cheaper synthesis option. Verify region/access first. Mail remains a capability investigation until a supported provider route is tested.

### D07: Privacy applies to derived content too

Delete actions tombstone immediately and remove dependent generated content through a durable workflow. Automatic raw-photo expiry is a distinct, disclosed retention policy. User-facing deletion claims must match offline-device and backup behavior.

## Inputs required before the relevant implementation gate

1. **Hardware interface, by P01/P05:** Pi model/OS, camera driver, IMU sampling, display API, power/charging telemetry, and storage capacity. Hardware owner supplies these; simulated adapters allow initial development.
2. **Local setup transport, before P07:** BLE support and secure pairing method, physical confirmation interaction, reconnection/reset behavior. BLE is proposed, not yet validated.
3. **Location source, by P01/P05:** dedicated GNSS or phone-supplied samples, accuracy/age policy, and behavior when unavailable. An IMU is not a GPS source.
4. **Capture and pause policy, by P01:** capture hours, initial ten-minute interval, pause duration or explicit-resume behavior, reboot behavior, and low-storage response.
5. **iOS target, by P02:** supported iPhone/OS range and developer signing setup. iOS 18+ is proposed; Apple Developer membership is not assumed.
6. **AWS environment, before P04 live work:** account, region, budget, model availability, IAM deployment role, and development isolation. No account identifiers or credentials belong in this document.
7. **Local data protection, by P05:** key storage/unlock strategy and physical-theft limitation for the chosen Pi hardware.
8. **Retention and day boundary, before real-data P13:** proposed seven-day raw-image retention, journal retention, backup policy, midnight day boundary, and user timezone/travel behavior. These need a documented product decision.
9. **Nightly behavior, before P10 activation:** default/user-selected time, power/network conditions, timezone/DST rule, missed-run handling, and how the user disables it. No clock time has been selected for users by this plan.
10. **Mail feasibility, P12:** supported authorization, scopes, provider eligibility, IMAP fallback acceptability, and data-selection UI. App authentication is not mailbox permission.

## Deferrals

Multi-device users, continuous video/audio, live location tracking, semantic memory search, long-term behavioral coaching, general inbox ingestion, automated account actions, fleet manufacturing, and production-scale analytics are outside the first implementation. Add a separate decision and phase before introducing them.

## Change log

- 2026-11-07: Recorded daily recap/reflection, iPhone, hardware ownership, AWS, and QR onboarding requirements.
- 2026-11-07: Recorded Apple Calendar, conditional Mail support, daytime Sync now, and preferred nightly automatic sync.
- 2026-11-07: Inspected the supplied Clippy repository and found it empty. Prepared the documentation baseline and staged implementation approach. No application code or cloud resources existed to preserve at inspection time.

Future entries should state the decision, reason, owner, affected contracts/phases, and what earlier decision it supersedes. Do not silently rewrite historical rationale.

## P01 local implementation decisions (2026-11-07)

- D08: Coordinator selects iOS 18 minimum, SwiftUI, TypeScript and Python for the local foundation requested by Josue. No signing membership or hardware capability is assumed. Exact installed/pinned tooling is recorded by P02.
- D09: Freeze v1.0.0 with strict fields, 30-day idempotency receipts, 5 MB photo / 200 capture bounds, 15-minute upload grants, 60-second future read grants, and optimistic edit revisions. See `contracts/README.md`. These settle the P00 proposals for local implementation.
- D10: Synthetic profile uses UTC midnight day boundaries. Original capture timezone/offset is preserved; untrusted clocks are quarantined from day assignment. Production preference changes must preserve existing boundaries.
- D11: Explicit pause resume, ten-minute default capture interval, no active capture/nightly scheduler, seven-day retention metadata without an expiry job. Synthetic local bytes are unencrypted; real-data collection is blocked on key protection and retention decisions.
- D12: All unresolved hardware/transport choices are named interfaces in `docs/hardware-adapters.md`. Real pairing and physical proof remain P07 blockers. Apple Calendar uses staged complete windows; EventKit access is P09. Mail remains deferred.

These are documented defaults authorized for this local implementation task. They do not resolve Pi hardware, AWS account/region/budget, paid model selection, or real-data privacy decisions.

## P02/P03 implementation choices (2026-11-07)

- D13: Pin Node 22.23.4/npm 11.8.0, CPython 3.12.13/uv 0.11.21, Xcode 26.6/Swift 6.3.3, and exact package locks. The iOS minimum remains 18; the installed simulator runtime is 26.5.
- D14: Local server persistence is single-process atomic JSON replacement plus immutable object files. Python checkpoints retain all synthetic images and reconcile an acknowledgement lost before the local checkpoint. This proves process restart behavior, not hardware power-loss durability. P04 replaces persistence with conditional cloud transactions/outbox; P05 owns SQLite/encryption.
- D15: The local app reads/writes through `JournalRepository`, uses a small JSON cache for this slice, and preserves operation IDs across in-session retries. Full SwiftData migrations, persistent edit outbox, authentication, pairing, and permission flows remain P06/P07/P09. This narrows the P00 SwiftData proposal for the P03 demo only.
- D16: `npm run demo` is a finite test harness, with explicit mock processing and no automatic timers other than process lifetime limits. The word nightly identifies a synthetic second snapshot only. No future work is activated.
- D17: Person 1 owns `device/` and `apps/ios/`; Person 2 owns `services/backend/`, `services/processing/`, and `infra/`. One coordinator owns shared contracts, fixtures, lockfiles, root tools, and STATUS. These lanes may begin from the accepted P03 foundation; P04 and later are still unimplemented.

## P04 backend and infrastructure decisions (2026-11-07)

Owner: Person 2 lane (backend/infra), branch `p04-backend`. These refine the P00 proposals for AWS; they do not change the v1 wire contract. Items marked "proposal" need the coordinator.

- D18: The engine uses an async storage port with a version-conditioned unit of work over four tables (`accounts`, `devices`, `journal`, `operations`). User content lives under `USER#<owner>` partitions (`#DAY#<day>`, `#CAPTURES`, `#RECEIPTS`, `#CAPGRANTS`) so deletion can find it by owner without scans. Operational records (syncs, snapshots, grants, outbox, deletion ledger, cursors) are keyed by their own IDs and hold no photo or text. Supersedes D14's whole-state JSON persistence for the engine; the file-backed memory store remains the local adapter with the same 100-write and item-size bounds as DynamoDB.
- D19: A snapshot of up to 200 captures cannot fit one 100-action DynamoDB transaction. Completion therefore commits the snapshot acceptance, sync transition, idempotency receipt and an outbox entry atomically; capture, moment and day records are then projected by idempotent outbox work, guarded per day by an `APPLIED#<snapshot>` marker. The receipt acknowledges durable acceptance, which the outbox guarantees will be projected. Known limit: two concurrent snapshots carrying the same capture ID with different metadata both accept; the second projection is excluded and logged as a conflict.
- D20: Upload IDs derive from (snapshot, kind, capture), job IDs from (owner, day, input revision, pipeline version), and outbox IDs from their cause, so retries and duplicate dispatch converge. Sync, snapshot, deletion and cursor IDs are random.
- D21: Tombstones are typed (`ACCOUNT`, `DAY#<id>`, `CAPTURE#<id>`). P03 shared one namespace, so `DELETE /v1/captures/account` deleted the whole account; fixed and covered by a test. A deletion response now reports `deleting_cloud` at commit; cleanup advances the job to `waiting_for_clients` with `cloudComplete: true`. Clients poll `GET /v1/deletion-jobs/{jobId}`.
- D22: Signed URLs are never persisted. Grant and read-URL idempotency receipts store the response without URLs and re-sign on replay with the original expiry, after re-checking ownership and tombstones.
- D23: The frozen v1 grant sends `X-Clippy-SHA256` as hex, which S3 does not interpret. Presigned PUTs sign `Content-Type` and `If-None-Match` only, the bucket policy denies uploads without `If-None-Match`, and completion reads and hashes every object (5 MB bound). Proposal: an additive contract change adding S3's base64 `x-amz-checksum-sha256` to `requiredHeaders` so S3 also rejects bad bytes at upload time.
- D24: Devices use MQTT through an IoT topic rule and Lambda, as `docs/contracts.md` section 4 already specifies. Trusted identity comes from rule functions (`topic(4)`, `clientid()`, `principal()`); payload fields are selected individually. The HTTP device routes remain a local-only adapter. Proposal: freeze the request envelope `{schemaVersion, requestId, type, snapshotId, body}` and response `{schemaVersion, requestId, type, status, body}` on `clippy/v1/devices/<thing>/responses/<requestId>` in `contracts/` for P05.
- D25: `PATCH /v1/me/preferences` accepts `journalTimeZone: "UTC"` only. Non-UTC journal days need the boundary-preserving migration in D10 first.
- D26: The outbox stream trigger and the IoT request rule are synthesized disabled and enabled only by explicit context flags for an approved deployment. No schedules, retention expiry or reconciliation jobs exist. Recovery is an operator-run, finite command.
- D27: The Cognito user pool lives in the retained Data stack because replacing it would change every owner subject. Development users are admin-created only; the app client is public with authorization code and PKCE.
- D28: Point-in-time recovery and S3 versioning are off in development so explicit deletion removes the only copy. Enabling either requires a deletion-ledger replay procedure and an approved retention window.
- D29: One media bucket with server-assigned `u/<owner>/s/<snapshot>/<upload>` keys. There are no S3 event triggers, so no processing loop exists; P08 decides whether derived artifacts get a separate prefix or bucket.
