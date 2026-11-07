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
