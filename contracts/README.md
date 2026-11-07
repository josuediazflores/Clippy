# Contract v1.0.0

`openapi.json` (OpenAPI 3.1) and `schema.json` (JSON Schema 2020-12) are authoritative wire definitions. `transitions.json` defines legal state changes. `fixtures/index.json` declares accepted/rejected examples; `fixtures/transitions.json` tests every state pair plus a stale revision. JSON Schema covers structure; the semantic constraints below are also mandatory. `tools/validate_contracts.py` is the initial executable semantic reference. P02 adds TypeScript/Swift agreement checks.

## Compatibility and limits

`schemaVersion: 1` is required on envelopes and records. Requests and v1 fixtures reject unknown fields, unknown enum values, and other major versions. A minor release may add optional response fields only after all three consumer compatibility tests are updated; until then closed schemas apply. Breaking changes need `/v2`, new fixtures, and a migration note. This is the initial freeze, with no production data migration.

IDs match `[a-z][a-z0-9_]{2,95}` and are opaque. Local examples use readable IDs; adapters must not infer authorization from their spelling. Integers stay within JavaScript's safe range. JSON uses UTF-8. Timestamps are second-resolution RFC 3339 UTC (`Z`), with a valid IANA timezone and its offset at that instant. No secrets, owner override, path, bucket, or arbitrary object key is accepted in device payloads.

Photos are PNG/JPEG, at most 5,000,000 bytes; grants have 1-20 items; snapshots contain at most 200 captures; sequence span is at most 10,000. JSON requests/manifests are at most 1,000,000 bytes. P03 normalizes only synthetic PNGs. Production image decoding/normalization is P05/P08. A declared content type is not proof of safe image content.

## Ownership and authentication

App handlers derive the owner from a validated access-token subject. Device handlers receive trusted device identity from a transport adapter and resolve the current owner/epoch. Both validate resource ownership on every access. A client `deviceId` must match the trusted transport identity. A revoked/unknown device cannot begin, grant, upload, or complete. Old epochs cannot finish an upload. Cross-owner resources return `NOT_FOUND`; invalid device binding returns `FORBIDDEN`/`STALE_EPOCH` without disclosing an owner.

P03 uses an explicit loopback-only synthetic token registry. It is not JWT verification or IoT security. HTTP device routes model IoT message types (`sync.begin`, `upload.grants`, `sync.complete`); they are not a proposal to ship device bearer secrets. Pairing's `proofHandle` is an opaque adapter result, never a serial-number ownership proof. P07 must define and verify transport cryptography and physical confirmation.

## Idempotency and revision rules

All JSON mutations and deletes require `Idempotency-Key`. Scope is authenticated actor, HTTP method, canonical path, and key. Store a SHA-256 canonical payload digest and the successful status/body for at least 30 days. Canonical JSON recursively sorts object keys, preserves array order, uses UTF-8 without escaped non-ASCII characters or whitespace, and accepts only schema-bounded finite numbers. Avoid fractional values in identity-bearing payloads. Same key and payload returns the receipt without another revision change; changed payload returns 409 `CONFLICT`. Failed validations do not reserve the key. A deleted/revoked resource overrides an old receipt and must not disclose deleted content. P03 keeps receipts in a persisted local JSON store; production transactions/expiry are P04.

A new key does not allow overwriting immutable capture bytes or metadata. A matching active sync coalesces; captures beyond its cutoff wait for the next snapshot. Retrying a frozen snapshot must reuse its begin key. After 30 days clients reconcile resource IDs and current revisions rather than replaying an old mutation blindly.

User edits are separate records from generated recaps. Create with `expectedRevision: 0`; update/delete with the current revision. `operationId` equals `Idempotency-Key` for edits. A conflict returns 409 `REVISION_CONFLICT` with `currentRevision`; no last-write-wins. A deleted edit retains a revision tombstone with empty text. Corrections invalidate generation input; reflections do not require regenerating observations. Stable moment identity is per capture, not its array position. Recap publication checks input revision and deletion generation atomically. Old results become `SUPERSEDED`.

## Upload and acknowledgement

1. Begin freezes device/epoch, trigger, sequence range, count, and cutoff. The server assigns snapshot/sync IDs. Manual commands expire in 5 minutes; a started snapshot can finish after command expiry. Unstarted commands must be requested again.
2. Grant requests bind each immutable object to snapshot, capture (or manifest), type, byte count, and SHA-256. Grant lifetime is 15 minutes. Renewal preserves the upload ID and metadata. Local PUT requires device authentication, `If-None-Match: *`, `X-Clippy-SHA256`, and the granted content type. P04 maps the checksum header to S3's base64 SHA-256 header and signs exact headers.
3. Upload images, then a manifest as an ordinary immutable grant. Complete references that manifest upload ID and its hash. Every manifest entry must match a capture grant in the same snapshot and identity. Capture/sequence/upload IDs are unique. Capture count must equal entries. Every sequence in the bounded range has one capture or a nonoverlapping explicit gap. Synchronized/estimated capture times cannot exceed the cutoff. Start cannot follow cutoff. Empty snapshots use a nonempty gap range; a completely empty device does not begin a snapshot.
4. Verify stored bytes, sizes, hashes, range, identity, and tombstones. A 412 PUT response proves only that bytes exist; complete performs authenticated reconciliation. Missing objects return retryable `MISSING_OBJECTS` with IDs, never a success acknowledgement. Changed bytes/metadata cannot overwrite existing uploads.
5. Receipt `acceptedCaptureIds` and `suppressedCaptureIds` are sorted unique IDs. Tombstones suppress known captures without blocking unrelated valid captures. `effectiveDigest` is lowercase SHA-256 of accepted IDs joined by LF, no trailing LF (empty set hashes empty bytes). Processing sees only this effective set. A receipt acknowledges durable local/server ingestion, not a ready recap or permission to delete the local queue immediately.

Grant renewal, cancellation, and resumed completion retain logical identities. Cancellation stops unverified remaining work; it does not erase accepted data. `cancel_requested -> uploaded` permits a completion already committed before cancellation. Cloud atomicity/outbox recovery is P04. Local filesystem replace provides a single-process persisted adapter for P03 only.

## Time and day ownership

The synthetic profile has a frozen UTC journal zone and midnight boundaries. Capture timezone is provenance, not automatic day reassignment. Backlogs are assigned by capture instant, never upload date. Travel does not rewrite earlier day boundaries. DST examples include both repeated fall-back instants and the spring jump. P04/P06 must preserve explicit established day intervals when preferences change. Untrusted-clock captures may upload but are quarantined from recap/day assignment until a future explicit correction flow; do not silently assign a 2000 capture to today's day. Sequence determines snapshot membership independently of clock quality.

## Calendar and evidence

Calendar snapshots stage one source generation, consent revision, selection, and coverage window. At least one page is required, including a complete empty page. Pages are numbered from zero without gaps and ordered for completion. Page hash is SHA-256 of canonical page JSON; completion digest hashes page hashes joined by LF without a trailing LF. All pages must match the snapshot ID. Occurrences have unique IDs, selected calendar IDs, nonempty intervals overlapping the window, and valid timezones. Incomplete/mismatched pages leave the published window untouched. A complete empty snapshot may remove prior events only in that window. Source generation/consent checks and revocation are mandatory before P09 publication. No EventKit reads are implemented in P03.

Evidence is a typed owned ID, never a model URL. Processing validates capture IDs against the frozen effective set. Stable moment IDs and user edits survive recap refresh. Deleted source evidence invalidates the generated recap immediately; in-flight generations cannot republish it.

## States, pagination, errors, deletion

State changes require `expectedRevision == revision`, an edge in `transitions.json`, and then increment the revision. Same-state replays return their existing receipt; they are not transitions. Capture recovery always returns to paused before an explicit resume. Device configuration distinguishes desired from applied revisions. Sync, capture, recap, and calendar freshness remain separate.

List limits default to 20, range 1-100. `from` inclusive and `to` exclusive filter day start instants. Opaque cursors bind owner, route, filters, limit, and a result revision; reject malformed, cross-owner, or changed-filter cursors with 400 `INVALID_REQUEST`, and changed datasets with 409 `CONFLICT`. P03 uses persisted random cursor handles, not trusted client offsets.

Errors use the `Error` schema. 400: invalid/version/schema/state requests; 401: missing/invalid authentication; 403: device identity/epoch mismatch; 404: inaccessible resource; 409: identity/payload/revision/superseded conflict; 410: deleted/expired resource; 412: conditional PUT already exists; 422: size/checksum/manifest errors; 503: retryable missing objects or provider failure; 501: frozen later-phase route not implemented locally. A safe generic 500 never includes exception text. Retry only when `retryable` is true, or after reconciling a documented conflict; preserve operation IDs. Local clients have finite attempts, no background retry loop.

Deletion tombstones immediately, increments deletion generation, removes generated content and applicable source/observation/object bytes, and scrubs content-bearing operation receipts. Day deletion removes its edits; capture deletion removes corrections targeting that capture but preserves unrelated reflections/corrections. Account deletion removes all owned content. Tombstones remain to prevent resurrection. `cloudComplete` in a local receipt means the local server cleanup milestone only; offline device cleanup remains `waiting_for_clients`. P03 does not claim physical erasure, cloud backups, or device acknowledgement. Read URLs later expire after 60 seconds and must never bypass tombstone checks when issued.

## Local gate

Run `uv run --python 3.12.13 --with jsonschema==4.25.1 --with openapi-spec-validator==0.7.2 python tools/validate_contracts.py` for P01. P02 pins these in the workspace lock and adds `npm run check:contracts` and Swift fixture tests. No command deploys or schedules work.
