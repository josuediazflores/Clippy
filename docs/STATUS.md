# Current implementation status

Updated: 2026-11-07.

## Current position

- **Completed work:** P00 plan, P01 executable contracts, P02 runnable projects, and P03 local capture-to-recap flow. P02/P03 evidence is local only.
- **Next work:** Person 1 can begin P05 device and P06 iPhone work; Person 2 can begin P04 backend/infra, then P08 after P04's local gate. P04 and later implementation has not started.
- **Foundation owner:** Codex coordinator, source branch `foundation/p01-p03`, starting at `db4b6c1`. Josue requested merging the accepted work into `main`. See [P03 verification](evidence/P03-verification.md) for the accepted source revision.
- **Repository baseline:** the current repository contains versioned contracts/fixtures, SwiftUI and Swift package code, TypeScript local backend/processing/CDK workspaces, Python device simulation, and finite verification commands. The initial empty-repository observation belongs to P00.
- **Local evidence:** clean source export with locked installs, 32 shared fixtures and 363 state/revision cases in three languages, 24 backend/HTTP tests, Python/Swift tests, lint/types/format, zero-resource CDK synth, fresh iOS Simulator build, two UI tests, and rendered UI inspection passed. See [P03 handoff](handoffs/P03-local-flow.md).
- **Live state:** no physical-device installation, AWS deployment, account connection, paid model call, app upload, or recurring job was created. Simulator tests use synthetic data and bounded loopback servers.

## Phase ledger

- P00: `complete`. Architecture, draft contracts, staged plan, decisions, verification gates, and handoff guidance prepared. Evidence: [P00 handoff](handoffs/P00-plan.md).
- P01: `complete`. Executable v1 contracts and semantic rules validated. Evidence: [P01 handoff](handoffs/P01-contracts.md).
- P02: `local_complete`. Projects build, shared fixtures agree in three languages, empty CDK synth passes. Evidence: [P02 handoff](handoffs/P02-projects.md).
- P03: `local_complete`. Two snapshots preserve edits and deduplicate moments; upload failures, authorization, stale results, deletion, and native UI pass. Evidence: [P03 handoff](handoffs/P03-local-flow.md).
- P04: `ready`. Person 2, backend/infra. P03 local dependency accepted; no implementation started.
- P05: `ready`. Person 1, device. P03 local dependency accepted; real hardware decisions still required.
- P06: `ready`. Person 1, iPhone. P03 local dependency accepted; no P06 implementation started.
- P07: `not_started`. Depends on P04, P05, P06.
- P08: `not_started`. Depends on P04.
- P09: `not_started`. Depends on P04, P06.
- P10: `not_started`. Depends on P07, P08, P09.
- P11: `not_started`. Depends on P10.
- P12: `deferred`. Optional mail implementation depends on P11; capability research can occur earlier.
- P13: `not_started`. Depends on P11; P12 is optional.

## Status meanings

`ready` means prerequisites permit the next local work package. `in_progress` names its owner/branch. `local_complete` means required local evidence passes but live/hardware gates remain pending. `blocked` must name a concrete missing input/approval/dependency and safe independent work. `complete` requires all evidence required by that phase's gate. `deferred` is an intentional scope decision.

For local implementation, a dependency at `local_complete` or `complete` is sufficient when its contracts/artifacts are stable. For live integration, the relevant service/hardware evidence must also be satisfied. A coordinator must not turn a missing live approval into a claim of live completion.

## Ownership and updates

Only the coordinator updates this ledger during parallel work. Contributors submit phase-specific handoffs. When claiming work, add owner, branch/worktree, starting commit, narrow file scope, dependencies, and intended checks. Update the next phase after accepting evidence, not merely after receiving an agent's completion message.

## Open inputs

No missing input blocks the next local work packages. iOS 18 minimum, UTC journal days, bounded uploads, and synthetic capture defaults are documented in [decisions](decisions.md) and [hardware adapters](hardware-adapters.md). Real Pi/OS/camera/IMU/display/power/location, pairing transport and possession proof, pause gestures, local key protection, AWS account/region/budget/model access, production retention, and mail authorization feasibility remain open. These block their later live/hardware gates, not local adapter implementation. iOS 18 runtime and physical-iPhone behavior remain unverified.

## Next safe action

Branch from accepted `main`, read the three phase handoffs and [local setup](local-development.md), and run `npm run check` plus `npm run demo` once. Person 1 owns `device/` and handwritten `apps/ios/` implementation; Person 2 owns `services/backend/`, `infra/`, and later `services/processing/`. One nominated coordinator owns contracts, shared fixtures/tools, dependency locks, generated models, Xcode project configuration, and this ledger. The [P03 handoff](handoffs/P03-local-flow.md#next-agent-instructions) lists exact starting files and boundaries. Deployment, account connection, hardware installation, model spending, and schedule activation still need their applicable approval.
