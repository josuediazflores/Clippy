# Interface contracts

Status: v1.0.0 frozen in P01. [Executable contracts](../contracts/README.md), [OpenAPI](../contracts/openapi.json), and [JSON Schema](../contracts/schema.json) are authoritative. The original proposal below is retained as architecture context; use executable fixtures rather than its illustrative IDs/hashes. P03 implements only the local subset marked in OpenAPI.

## 1. Common conventions

- Use UTF-8 JSON with an explicit `schemaVersion`. Reject unsupported major versions. Additive optional fields require compatibility tests.
- Identifiers are opaque, globally unique strings. Device capture IDs remain stable across restarts and retransmission. Do not derive identity solely from a wall-clock timestamp.
- Timestamps use RFC 3339 UTC with an explicit `Z`; IANA timezone and original offset are separate fields. Sequence numbers provide ordering when the clock is uncertain.
- API routes use the authenticated subject for user scope. There is no public request field that can override `userId` authorization.
- Mutations use an `Idempotency-Key` scoped to actor, route, and payload digest. Reusing a key with a different payload returns a conflict. Keep operation receipts long enough to cover client retry windows; P01 freezes the duration.
- Mutable user records expose `revision`; updates require `expectedRevision`. A mismatch returns current revision metadata and a conflict, never an unconditional last-write-wins update.
- List responses use an opaque, scoped cursor and bounded page size. Reject cursors from another user, resource, or filter.
- Errors contain `code`, a safe `message`, `requestId`, and whether retry is appropriate. No stack traces, provider secrets, or personal source contents reach generic errors/logs.
- Proposed application limits: 20 upload grants per response, 5 MB per normalized photo, and 200 captures per snapshot. These are conservative Clippy defaults, not AWS service limits. Split backlog across snapshots; P01 measures and freezes them.

Example error:

```json
{
  "schemaVersion": 1,
  "error": {
    "code": "DEVICE_UNREACHABLE",
    "message": "Connect the device to Wi-Fi or move within Bluetooth range.",
    "requestId": "req_example_01",
    "retryable": true
  }
}
```

## 2. Domain objects

**UserProfile:** authentication subject mapping, journal timezone, capture/sync preferences, privacy policy version, consent revisions, retention choices, and account deletion state.

**DeviceIdentity:** device ID, IoT thing/certificate binding, owner, ownership epoch, supported protocol/firmware versions, claim state, and revoked/reset state. Certificate private material is never part of an API response.

**DeviceState:** capture state, battery percentage if supported, charging state, queued capture count/bytes, storage state, clock quality, connectivity, applied config revision, and `observedAt`. Unknown fields stay unknown rather than zero.

**Capture:** capture ID, device/epoch, sequence, captured instant/timezone/quality, S3 object reference after verification, SHA-256, byte length, content type, optional location sample, and tombstone state. Exact GPS coordinates are not embedded in public object names or logs.

**Day:** opaque day ID, timezone, UTC start/end, coverage ranges, input revision, latest recap revision, processing status, calendar freshness, and open/closed-for-scheduled-recap state. Closed is a presentation milestone; late data can still revise the day.

**Observation:** capture ID, immutable model/prompt/preprocessing versions, visible facts, optional inferred activity, uncertainty, structured extraction status, and source references. Observation success is independent of recap success.

**Recap:** day ID, input revision, recap revision, through-time, coverage/gaps, summary, highlights, optional reflection prompt, optional suggestion, valid source IDs, model/prompt versions, and generation state.

**Correction / Reflection:** user-authored content with operation ID, record revision, source/day target, timestamps, and deletion state. These are never embedded as mutable fields that the model owns.

**CalendarSnapshot:** source generation, selected-calendar IDs, declared UTC window, pages, occurrence records, completion digest, permission/consent revision, and refresh time. A complete empty snapshot differs from a failed refresh.

## 3. Proposed app API

All routes except the identity provider's own authentication flow require a valid access token. Resource access is checked again by the handler. P01 defines exact response schemas and status codes in OpenAPI.

- `GET /v1/me` and `PATCH /v1/me/preferences`: profile and versioned preferences.
- `POST /v1/device-claims`: reserve a bounded claim session for an authenticated user.
- `POST /v1/device-claims/{claimId}/confirm`: submit phone possession proof; completion waits for verified device proof.
- `GET /v1/devices`: owned device references.
- `GET /v1/devices/{deviceId}`: identity-safe metadata, last state, desired/applied config, and active sync.
- `PATCH /v1/devices/{deviceId}/configuration`: expected revision plus changed settings; response distinguishes queued configuration from device acknowledgement.
- `POST /v1/devices/{deviceId}/sync-requests`: create/coalesce a manual request. Return `202` with request ID and status, or the existing active request; do not report uploading before device acknowledgement.
- `GET /v1/sync-requests/{syncRequestId}`: command, upload, verification, and processing state separately.
- `POST /v1/sync-requests/{syncRequestId}/cancel`: request cancellation of remaining transfer work. Uploaded/verified data and already-started processing follow explicit cancellation policy; do not pretend cancellation erases data.
- `GET /v1/days?from=&to=&cursor=`: bounded History metadata.
- `GET /v1/days/{dayId}`: current authorized recap plus freshness/coverage and user edits.
- `GET /v1/days/{dayId}/moments?cursor=`: paginated timeline and evidence references.
- `POST /v1/captures/{captureId}/read-url`: issue a short-lived read URL after tombstone/ownership checks. URL TTL is a P01 policy value.
- `PUT /v1/days/{dayId}/reflections/{reflectionId}`: create/update with stable operation ID and expected revision.
- `PUT /v1/moments/{momentId}/corrections/{correctionId}`: correction with provenance and expected revision.
- `POST /v1/calendar/snapshots`: begin a permitted coverage-window refresh.
- `PUT /v1/calendar/snapshots/{snapshotId}/pages/{pageNumber}`: idempotently stage a page.
- `POST /v1/calendar/snapshots/{snapshotId}/complete`: verify page set/digest, atomically publish a source generation, and request affected-day refreshes.
- `DELETE /v1/integrations/{integrationId}`: stop new ingestion and initiate the chosen stored-data removal policy.
- `PUT /v1/push-installations/{installationId}` and `DELETE /v1/push-installations/{installationId}`: register/revoke a push token for the authenticated installation. Never accept an arbitrary SNS endpoint ARN as authorization.
- `DELETE /v1/captures/{captureId}`, `DELETE /v1/days/{dayId}`, and `DELETE /v1/me`: tombstone promptly and return a deletion operation receipt.
- `GET /v1/deletion-jobs/{jobId}`: authorized cleanup progress, including pending device acknowledgements.

Mail routes are deferred until P12 defines a supported provider, scopes, secret handling, and disconnect contract.

## 4. Device messages and authentication

Proposed topic layout:

```text
clippy/v1/devices/{thingName}/requests
clippy/v1/devices/{thingName}/responses/{requestId}
clippy/v1/devices/{thingName}/commands
clippy/v1/devices/{thingName}/acknowledgements
```

The device certificate is attached exclusively to its thing, and connection/topic policies bind the MQTT client ID to that identity. A device may publish requests/acknowledgements and subscribe only to its own responses/commands. An IoT Rule passes trusted routing identity to the backend separately from untrusted JSON; the handler must not accept a payload that overrides that identity.

Requests include `claim.prove`, `sync.begin`, `upload.grants`, `sync.complete`, and `state.report`. Commands include `sync.now`, `configuration.apply`, and an explicitly authorized cleanup/reset command. Every command has a unique ID, ownership epoch, issued time, expiration, and payload version. Reject an old epoch, expired command, unsupported version, or replayed command. Persist acknowledgements so MQTT redelivery does not repeat an action.

BLE carries equivalent local control semantics after owner authentication. Local pairing/session tokens never become general cloud credentials. Cloud identity and BLE possession proof must converge on the same device/epoch before control is permitted.

```json
{
  "schemaVersion": 1,
  "commandId": "cmd_example_01",
  "type": "sync.now",
  "deviceId": "dev_example_01",
  "ownershipEpoch": 1,
  "issuedAt": "2026-11-07T18:00:00Z",
  "expiresAt": "2026-11-07T18:05:00Z",
  "payload": {
    "syncRequestId": "sync_example_01",
    "trigger": "manual"
  }
}
```

Five minutes here is an example policy for a manual command, not a required AWS timeout. An acknowledgement contains command ID, accepted/rejected state, safe reason code, and observed device state time. Accepted means the command is durable, not that upload or processing has finished.

## 5. Snapshot and upload protocol

`sync.begin` allocates a server-owned snapshot ID and object namespace after checking device ownership. The device sends the capture sequence bounds, expected count, trigger, and current config revision. The server limits outstanding snapshots and returns any matching existing snapshot for a retry.

`upload.grants` supplies a bounded list of capture IDs, sizes, SHA-256 values, and content types. The server assigns exact S3 keys and returns signed PUT URLs plus required headers, expiration, and upload IDs. Clients cannot request an arbitrary bucket/key. Sign/enforce `If-None-Match: *` for new objects and the selected checksum header. Verify the exact SDK/header behavior in P04's cloud integration test.

A `412` from a retried conditional PUT is not sufficient proof of successful upload: reconcile the existing object with the expected size/checksum via the authenticated backend. Renew expired URLs without changing capture identity. A mismatched existing object is a conflict and cannot silently replace the source.

Manifest entries identify server-granted upload IDs rather than arbitrary paths. This single-capture example is complete for its stated sequence range:

```json
{
  "schemaVersion": 1,
  "snapshotId": "snap_example_01",
  "syncRequestId": "sync_example_01",
  "deviceId": "dev_example_01",
  "ownershipEpoch": 1,
  "trigger": "manual",
  "startedAt": "2026-11-07T18:00:00Z",
  "cutoffAt": "2026-11-07T18:00:02Z",
  "sequenceStart": 42,
  "sequenceEnd": 42,
  "captureCount": 1,
  "captures": [
    {
      "captureId": "cap_example_42",
      "sequence": 42,
      "capturedAt": "2026-11-07T17:55:00Z",
      "timeZone": "UTC",
      "utcOffsetSeconds": 0,
      "clockQuality": "synchronized",
      "uploadId": "upload_example_42",
      "byteLength": 250000,
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "contentType": "image/jpeg",
      "location": null
    }
  ],
  "gaps": []
}
```

The checksum is illustrative and not a real fixture checksum. P01 replaces example identifiers/hashes with consistent synthetic fixtures. A gap identifies intentionally absent sequences and their reason; verification must not assume every missing sequence is an uploaded capture. Include explicit skipped/corrupt capture records rather than inventing images.

`sync.complete` references the server-granted manifest upload, hash, and snapshot ID. Verification checks the active ownership epoch, all grants, counts, sequence bounds, supported content, per-object checksum/length, and deletion tombstones. It returns a durable receipt with accepted capture IDs and verification time, or a bounded missing/invalid list. A recognized tombstoned capture gets an explicit suppressed/deleted receipt so it cannot resurrect and need not stall unrelated captures forever. P01 must define the verified effective capture set and its digest after suppression. Processing starts only for a verified snapshot.

Processing input contains small references, not raw images or the entire day. Use `(owner, dayId, inputRevision, pipelineVersion)` for a durable job identity. A dispatch outbox provides recovery if starting Step Functions fails after database commit.

## 6. State machines

**Capture state:** `capturing`, `paused`, `storage_full`, `camera_error`, `disabled`. Connectivity is independent. Persist explicit resume policy and pause state.

**Upload run:** `requested -> waiting_for_device -> preparing -> uploading -> verifying -> uploaded`. Branches are `waiting_for_network`, `waiting_for_power`, `cancel_requested`, `cancelled`, `failed_retryable`, and `failed_terminal`. Define legal recovery transitions in P01; a retry resumes the same logical request when its snapshot is unchanged.

**Recap job:** `queued -> observing -> assembling -> synthesizing -> validating -> publishing -> ready`. Branches are `partial`, `superseded`, `cancelled_by_deletion`, `failed_retryable`, and `failed_terminal`. Job records include coverage and safe error codes.

**Device configuration:** `desiredRevision` and `appliedRevision`; the UI shows Pending until acknowledged. Settings that affect capture/privacy do not appear applied solely because the cloud accepted them.

**Deletion:** `requested -> tombstoned -> deleting_cloud -> waiting_for_clients -> complete`, with bounded retry/error states. A cloud-cleanup milestone can complete while device cleanup is pending; do not conflate them.

P01 must create transition tests for every legal path and rejection tests for invalid/stale transitions. Keep UI labels separate from stable protocol enum values.

## 7. Calendar snapshots and evidence

A snapshot includes consent revision, source generation, selected calendar IDs, coverage start/end, page count, and a completion digest. Event occurrences include opaque source event identity, occurrence start, title, start/end, timezone, all-day flag, and optional location. Do not infer attendee presence from these fields.

A successful replacement of a source/window removes cancelled or deselected records within that covered window. An incomplete snapshot leaves the previous version intact. Permission revocation or source-account replacement triggers a distinct operation, not an accidental empty response.

Recap evidence uses typed references such as `capture`, `calendar_occurrence`, and `user_correction`. The backend resolves IDs and validates ownership/existence; it never trusts a model-supplied URL. A deleted or expired source is labeled unavailable or removed according to policy. Recap citations must remain scoped to the input revision used for generation.

## 8. Contract freeze checklist

P01 is complete only when schemas define identifiers, field nullability, bounded sizes, retry semantics, authorization context, version compatibility, errors, state transitions, and data deletion behavior. Test the same fixtures in TypeScript, Swift, and Python once those runtimes exist. Unknown major versions, forged ownership fields, duplicate capture IDs, stale epochs, bad checksums, incomplete calendar pages, and invalid state transitions must fail consistently.
