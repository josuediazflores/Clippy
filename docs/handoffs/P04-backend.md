# Phase handoff: P04

## Identity and scope

- Phase/work package: P04 cloud foundations, API, and ingestion.
- Owner: Person 2 lane (backend/infra), implemented with Claude Code at Josue's request.
- Starting commit: `5907ba9` (accepted P03 on `main`).
- Result branch: `p04-backend`. Code milestones `297cdfd` (async engine), `5c7ba45` (dependencies), `290d295` (DynamoDB adapter), `c16fc51` (AWS adapters), `7ae0c5f` (CDK). The final commit adds this handoff, the deployment packet and decisions.
- Files owned/changed: `services/backend/**`, `infra/**`, `docs/deployment/P04-dev-packet.md`, this handoff, a P04 section appended to `docs/decisions.md`.
- Coordinator-owned files touched (please review): `package-lock.json`, `infra/package.json` and `services/backend/package.json` (commit `5c7ba45` only); root `package.json` (one script, `test:dynamodb`); `tools/scenario.ts` (engine construction and state branching only); new `tools/test-dynamodb.sh`. No contract, schema, fixture, generated model, Xcode or STATUS change.
- Dependencies checked: P03 `local_complete` at `5907ba9`; baseline `npm run check` and `npm run scenario` passed before any change.
- Status: **local_complete**, ready to ship pending deployment approval. No service evidence exists.

## Result

The backend now runs on an async storage port shaped like the planned DynamoDB access patterns. Every write goes through a unit of work that conditions each item on the version it read, with bounded optimistic retries. Two adapters implement the port: a file-backed memory store (local server, scenario, unit tests) and a DynamoDB store. They share a conformance suite, and the full engine suites pass on both.

What the next consumer can rely on:

- **Ingestion.** `complete` verifies the manifest and every object, then atomically commits snapshot acceptance, the sync transition, the idempotency receipt and an outbox entry. Projection into captures, moments and day revisions is idempotent outbox work. A crash between commit and projection is repaired exactly once by the outbox (stream dispatcher in AWS, inline locally, or the explicit recovery command). Missing objects return one retryable `MISSING_OBJECTS` listing every missing upload.
- **Ownership.** The owner comes from the authenticated subject (Cognito `sub` in AWS). Device requests take identity from the IoT rule, bound to client ID and, once provisioned, the certificate. Cross-owner access returns 404 across every resource family. Tombstones are typed per target.
- **Uploads.** Upload IDs are deterministic per snapshot and capture, so renewal keeps identity. S3 grants sign the exact key, `Content-Type` and `If-None-Match`. The bucket rejects uploads without `If-None-Match`. Completion hashes the bytes server-side (D23). Signed URLs are never stored.
- **Processing hand-off.** Day revisions from snapshots, corrections and capture deletion create `day.process` outbox entries. Dispatch skips superseded revisions and starts one job per (owner, day, revision, pipeline) through an idempotent `JobStarter`. P08 supplies the state machine; until then those entries stay pending by design.
- **Deletion.** Deletion tombstones immediately and invalidates recaps in the same commit. Cleanup removes journal items, observations, jobs, capture-grant indexes, receipts (except the deletion's own) and S3 objects, then marks the job `waiting_for_clients`.
- **Routes.** The P04 routes are now implemented: `GET /v1/me`, `PATCH /v1/me/preferences` (UTC only, D25), and `POST /v1/captures/{id}/read-url` (60 seconds).
- **AWS adapters.**
  - API Lambda: re-checks `token_use`, `client_id`, scope and subject format after the JWT authorizer, and logs route templates only.
  - IoT device Lambda: runs the MQTT envelope (D24), idempotent by request ID, and publishes only to the thing's own response topic.
  - Stream dispatcher: handles outbox inserts only and reports failures per record.
  - Step Functions starter: names each execution by job ID and passes references only.
- **CDK.**
  - Retained Data stack and a Runtime stack. 25 template assertions run on every synth, covering retention, encryption, public access, If-None-Match enforcement, JWT and scope on every route, no device or local routes, no schedules, IAM wildcards and unscoped resources, access-log contents, IoT SQL and policy shape, and the stream filter.
  - The outbox stream and the IoT rule are disabled unless explicitly enabled (D26).

## Decisions and compatibility

- Decisions added: D18 to D29 in `docs/decisions.md`. D18 supersedes D14 for the engine's persistence.
- Contract/schema changes: none. Wire version stays v1.0.0. UI fixtures are byte-identical to P03 (`npm run scenario` leaves `fixtures/ui` unchanged).
- Behavior changes visible to clients:
  - `DELETE` responses report `deleting_cloud` (revision 3); the job reaches `waiting_for_clients` (revision 4, `cloudComplete: true`) after cleanup. Locally that happens before the response returns, so `GET /v1/deletion-jobs/{id}` is immediately settled.
  - Illegal sync transitions now return 409 `INVALID_STATE` instead of a generic 500.
- Proposals for the coordinator: freeze the MQTT envelope (D24); additive `x-amz-checksum-sha256` grant header (D23).
- Migration: none. No production data exists.

## Verification evidence

Environment: macOS, Node 25.6.0 (the repository pins 22.23.4; Node 22 is not installed on this machine, so npm warns `EBADENGINE`), npm 11.8.0, uv 0.11.21, Docker 29.4.1, `amazon/dynamodb-local:3.3.2` (`sha256:6ada631e...`), CDK 2.275.0, AWS SDK v3 3.1159.0.

- `npm run check`: all checks pass. Covers contracts in Python/TypeScript/Swift (32 fixtures, 363 state cases each), strict TypeScript, ESLint, Prettier, Python lint and tests, Swift package tests, and synth with 25 template assertions (12 Data + 64 Runtime resources, both event triggers disabled).
- `npm test`: 53 tests, 52 pass, 1 skipped (the DynamoDB placeholder when no emulator is configured). They include:
  - the 24 ported P03 tests;
  - a regression test for the reserved-ID deletion bug;
  - crash after acceptance, crash between projection and day bump, and outage before the outbox write;
  - concurrent edits, sync taps and publication;
  - recovery idempotency and superseded revisions;
  - deferred deletion, profile and preferences, read grants (receipts never contain the URL), and AWS router mode exposing no device or local routes;
  - multi-object `MISSING_OBJECTS`;
  - store conformance on the memory adapter;
  - offline AWS adapter tests: presigned URL shape, S3 response mapping, the claim matrix, API cross-owner isolation across 9 resource routes, the MQTT upload protocol with forged identity, client/thing mismatch and certificate mismatch, stream filtering and partial failures, Step Functions idempotency, and log redaction.
- `npm run test:dynamodb`: a finite loopback container, always removed, with all `AWS_*` variables cleared. Results:
  - 9 adapter tests pass (6 conformance plus 3 engine flows);
  - the shared flow, HTTP and P04 suites re-run on DynamoDB Local: 41 pass, 2 skipped (the fault-injection tests need memory hooks);
  - the synthesized API Lambda bundle (not the source) passes a smoke run against DynamoDB Local.
- `npm run scenario`: passes with UI fixtures unchanged.
- `npm run demo`: passes. Both UI tests pass on the task simulator ("Clippy P03", iOS 26.5 runtime) against the refactored local server. The HTTP read/write results the iPhone wrote are verified server-side, and screenshots are exported to ignored `.local/evidence/`. No iOS source changed.
- IAM was reviewed by hand from the synthesized template; summarized in the [deployment packet](../deployment/P04-dev-packet.md#5-iam-and-access-summary).
- Service evidence: none. Hardware evidence: none. UI: no UI change in P04.
- Not run: any AWS deployment, bootstrap, Cognito sign-in, S3, IoT or Step Functions call (no approval). DynamoDB Local does not certify IAM, KMS, real transaction contention, GSI propagation delay or stream filtering.

Incident note: two early local smoke runs of the bundled Lambda picked up the developer shell's `AWS_PROFILE` (an SSO profile), because SDK v3 prefers a profile over static environment keys. The DynamoDB calls went to DynamoDB Local, which explains the `ResourceNotFoundException`: it stores tables separately per access key. Resolving the profile likely called IAM Identity Center `GetRoleCredentials` once per run, a read-only token exchange. No AWS resource was read, created or changed. Every local AWS test now clears `AWS_*` variables and points config files at `/dev/null`.

## Remaining work and risks

- First unmet acceptance condition: live evidence (JWTs, IoT policies and rule SQL, S3 signed headers and bucket-policy denial, KMS, real transactions, stream filter, recovery) needs the approved packet in `docs/deployment/P04-dev-packet.md`.
- Approvals required, separately:
  - account and region choice;
  - CDK bootstrap;
  - Data deploy;
  - Runtime deploy;
  - dispatcher activation;
  - device rule activation;
  - synthetic identities and certificate.
- Known limits and TODOs:
  - History pagination reads all of a user's day metadata per page. Fine at journal scale; revisit past a few thousand days.
  - In AWS, the History index is eventually consistent, so a just-written day can be briefly absent and a cursor can see a spurious 409. Gates never use the index.
  - Account deletion runs in one dispatcher invocation (300 s). Very large accounts need a continuation step; the stream retries the idempotent work if it times out.
  - The concurrent conflicting-metadata snapshot race (D19) is logged, not rejected.
  - The stage throttle is the only rate limit. There are no per-user quotas yet.
  - Alarms have no actions until an owner is named.
  - Node 22 was not available locally; CI or the coordinator should run the checks on the pinned 22.23.4.
- Consumers:
  - P05 must adopt the MQTT envelope and S3 PUTs that send exactly `requiredHeaders` without a bearer token. The Python simulator's HTTP transport remains local-only.
  - P06 should poll deletion jobs. It authenticates with the PKCE client (`clippy://auth/callback`, scope `clippy/journal`).
  - P07 writes device identity records with `certificateId`, attaches the `clippy-<env>-device` policy, and owns claims.
- Cost, data and rollback: see packet sections 8 to 10. About USD 2/month idle, no model spend.

## Next agent instructions

First safe action: review the coordinator-owned changes listed above and decide on the D23 and D24 proposals. Then read the [deployment packet](../deployment/P04-dev-packet.md) and choose an account and region (with P08's Bedrock needs in mind). Rerun `npm ci`, `npm run check`, `npm run test:dynamodb` and `npm run scenario` on Node 22.23.4.

Wait for explicit approval before any bootstrap, deploy, activation or credential creation. P08 can proceed locally from this branch now: it consumes `JobStarter`, `Engine.prepareJob`, `publish` and the observation cache, and supplies the state machine ARN to the Runtime stack.

Proposed STATUS update: `P04: local_complete. Person 2, branch p04-backend. Live verification blocked on account/region selection and deployment approval (packet ready). P08: ready (local), depends on P04 local_complete.`
