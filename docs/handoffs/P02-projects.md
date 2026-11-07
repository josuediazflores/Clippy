# Phase handoff: P02

## Identity and scope

- Phase/work package: reproducible local projects.
- Owner: Codex coordinator.
- Starting commit: `cb3ed600dc3d0dac80c3987698d38e65124b5c81` (accepted P01).
- Result commit/branch: commit titled `Establish P02 local Swift TypeScript and Python projects` on `foundation/p01-p03`; exact SHA recorded in P03.
- Files owned/changed: root toolchain/lock/config files, `apps/ios/`, `device/`, `services/`, `infra/`, `tools/`, setup/status documentation.
- Dependencies checked: P01 schema/OpenAPI gate, 32 fixtures, 363 transition cases.
- Status: local_complete.

## Result

The repository now has a buildable SwiftUI simulator app, shared Swift package, TypeScript workspaces, a finite Python capture simulator, and a CDK app that synthesizes zero resources without credentials. Domain protocols separate platform services. Codable/TypeScript shapes are generated from the frozen schema; validators enforce structure and semantic fixture rules in all three languages. Setup and finite commands are in `docs/local-development.md`.

## Decisions and compatibility

- Pin Node 22.23.4/npm 11.8.0, CPython 3.12.13/uv 0.11.21, TypeScript 5.9.3, and exact locked dependencies. Xcode 26.6 / Swift 6.3.3 builds minimum iOS 18 using iOS 26.5 SDK.
- Committed Xcode project generated with XcodeGen 2.44.1; no signing setup needed for Simulator.
- No wire format changes. Generated Swift `ZoneName` avoids a Foundation type collision.
- No production data or migration.

## Verification evidence

- `npm run check`: passes contract/shape drift, both Python and TypeScript fixture gates (32 + 363 cases each), strict TypeScript build, backend test, lint/format, Python simulator test, Swift tests (32 + 363 plus typed day), and zero-resource CDK synth.
- `bash tools/ios-build.sh`: passed generic iOS Simulator Debug build with signing disabled, arm64 and x86_64.
- `uv run clippy-device --output .local/device --count 2`: produces two deterministic synthetic PNG captures with matching byte counts/hashes.
- `git diff --check`: passed.
- Local/simulator evidence only. P03 verifies a clean export of the completed source as a final reproducibility check.
- Service/hardware evidence: none. Empty CDK synth is not a deployment or AWS permission test.
- UI/artifact inspection: minimal fixture screen builds; rendered journey inspection belongs to P03 and is not claimed here.
- Fixed initial failures: formatter modified generated models; Python editable install preceded package creation; simulator fixture root was one directory too high; generated `TimeZone` shadowed Foundation. All were corrected before gate acceptance.
- CDK initially warned that an empty template cannot be deployed. The empty local app disables built-in CloudFormation resource validation; explicit zero-resource/zero-lookup assertions remain.

## Remaining work and risks

- First unmet acceptance condition: P03 local ingestion and end-to-end UI journey.
- Blockers: none for P03. Physical iOS 18 behavior, real authentication, Pi interfaces, and cloud durability are unverified.
- Synthetic bytes only; no encryption guarantee or active retention/scheduler.
- No shipping artifact or environment has been approved.

## Next agent instructions

Start P03 in `services/backend/`, `services/processing/`, `device/`, and iOS adapters/views. Reuse frozen identities and user edit revisions. Add failure tests and an explicit finite scenario command with UI evidence. Keep shared lock/config/schema ownership coordinated. Stop before P04.
