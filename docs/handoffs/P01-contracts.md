# Phase handoff: P01

## Identity and scope

- Phase/work package: executable contracts and interface decisions.
- Owner: Codex coordinator.
- Starting commit: `db4b6c192150ec80ce09b0a08601598d4d065728`.
- Result commit/branch: `cb3ed600dc3d0dac80c3987698d38e65124b5c81` on `foundation/p01-p03`.
- Files owned/changed: `contracts/`, `fixtures/`, `tools/validate_contracts.py`, contract/adapter/decision/status docs.
- Dependencies checked: P00 documentation read; current remote was still the P00 baseline.
- Status: complete (contract gate only).

## Result

OpenAPI 3.1 and JSON Schema 2020-12 define device identity/state, capture, begin/grants/manifest/receipt, sync/commands, observation/recap, day/moment, calendar snapshots, user edits, deletion, pagination, errors, and later app routes. Legal transition matrices and shared fixtures cover version/identity/epoch rejection, strict ownership fields, duplicate/missing manifest entries, incomplete calendar pages, midnight/travel/DST/untrusted clocks. Explicit semantic rules supplement structural schemas.

## Decisions and compatibility

- D08-D12 added. Local defaults settle minimum iOS, limits, idempotency retention, revisions, time policy, and pause/retention metadata.
- Initial wire version is 1.0.0; no existing runtime data migration.
- Consumers: Python reference gate now; Swift and TypeScript checks are P02.
- Hardware, BLE, key protection, and location details remain explicit adapters, with P05/P07 ownership.

## Verification evidence

- `uv run --python 3.12.13 --with jsonschema==4.25.1 --with openapi-spec-validator==0.7.2 python tools/validate_contracts.py`: passed OpenAPI/schema validation, 32 shared fixtures and 363 exhaustive state/revision cases, plus canonical identical/changed request digest checks.
- `git diff --check`: passed.
- Evidence level: document reviewed and locally tested contract semantics. Synthetic PNG checksums correspond to committed bytes.
- Service/hardware evidence: none, intentionally outside this phase.
- UI/artifact inspection: JSON definitions and fixture cases reviewed; no app exists at this phase gate.
- Deliberately unrun: real ownership, cloud conditional writes, BLE, EventKit, hardware clock, and media behavior. Later phases own these gates.

## Remaining work and risks

- First unmet downstream acceptance condition: build and decode the same fixtures in Swift and TypeScript (P02).
- Blockers: none for local P02. Hardware configuration, secure pairing and real-data key protection are unresolved for later gates.
- Known limits: structured schema validation alone cannot check bytes, ownership, stored revisions, or publication races. P03 must exercise these against local adapters.
- No deployment, schedule, paid calls, real data, or installation; no rollout to undo.

## Next agent instructions

Read `contracts/README.md` and `docs/hardware-adapters.md`. Build the three projects, pin dependencies and finite commands, and prove shared decoding. Keep shared schemas/lockfiles under coordinator ownership. STATUS can advance P02 to in_progress. No work beyond P03 is authorized in this task.
