# P00 architecture plan handoff

Date: 2026-11-07.

## Scope and result

The supplied GitHub repository was empty. This initial documentation set defines the intended iPhone/device/AWS system, draft API/device contracts, data and processing design, 14 implementation phases, a progress ledger, decisions, verification gates, and agent handoff instructions.

The source revision is the initial documentation commit containing this file. Use the repository commit history for its exact SHA; the document does not embed its own commit hash.

## Confirmed requirements carried forward

Daily recap/reflection, iPhone app, user-designed wearable hardware, AWS backend, QR pairing, local camera pause, daytime Sync now, preferred nightly automatic sync, Apple Calendar, and optional Mail if supported.

## Evidence

- Repository inspection: metadata and contents confirmed an empty repository before authoring; no existing repository instructions or application code were present.
- Platform research: official AWS and Apple sources linked in the source notes; EventKit permissions, iOS background timing, iCloud account access, IoT provisioning, conditional S3 writes, and DynamoDB concurrency/TTL informed the design.
- Documentation checks: relative Markdown targets, JSON examples, phase references, dependency consistency/acyclicity, required phase sections, and prohibited em dash usage checked locally before finalizing the source commit.
- Runtime evidence: none. No app builds, cloud tests, paid model evaluations, or hardware tests are claimed for a documentation-only phase.

## Open work

P01 must convert prose contracts into executable schemas and fixtures. The proposed stack, limits, retention, day/time policy, and hardware pairing details need the stated implementation decisions. Mail remains optional and unverified for this project. The plan does not authorize automatic schedules or deployments.

## Next agent

Read AGENTS, STATUS, contracts, and decisions. Claim P01, define schemas and state transition examples, identify the minimum missing hardware inputs, and keep work local. Do not skip directly to creating AWS infrastructure or installing a Pi background service.
