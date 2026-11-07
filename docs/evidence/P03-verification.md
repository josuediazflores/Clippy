# P03 local verification

Date: 2026-11-07. Evidence class: local synthetic adapters and iPhone Simulator only.

The phase handoff records commands, toolchains, failure coverage, and limitations. `P03-local-report.json` records the deterministic two-snapshot result and the UI run's server-side write assertions. The final revision record identifies the accepted code commit.

## Accepted checks

The final command was `CLIPPY_CLEAN_UI=1 CLIPPY_SIMULATOR_ID=80875337-2700-4A9B-A21A-8465504042B0 uv run python tools/clean-check.py` with the pinned Node 22.23.4 directory first on PATH. It exited 0 on 2026-11-07. The source export had fresh dependency/build directories and included the final source changes awaiting commit. It ran:

- `npm ci --no-audit --no-fund` and `uv sync --locked`: passed.
- `npm run check`: 32 fixtures and 363 state/revision cases in each language; 24 backend/HTTP tests; Python simulator test; two Swift package tests; generated-model drift, schema/OpenAPI, type/lint/format checks; empty CDK synthesis. All passed.
- `bash tools/ios-build.sh`: fresh arm64 and x86_64 Simulator build passed.
- `npm run demo`: deterministic two-snapshot HTTP scenario and two native UI tests passed. iPhone-written correction and reflection text and revision 2 were independently verified in backend state.

The scenario finishes with three unique moments from two overlapping snapshots, preserved user edits, and successful interrupted-upload recovery. Server endpoints close after the finite harness. Xcode emitted debugger-version diagnostics and a skipped AppIntents metadata warning; no accepted build/test failed. The temporary Clippy iPhone 17e simulator was deleted with Josue's explicit permission after its screenshots were saved. Other project caches and simulators were not deleted.

Final source review passed `git diff --check`, 56 relative Markdown link targets, and checks across 140 source/evidence files for private-key/token/signed-URL patterns, machine-local paths/instructions, generated caches, and automation files. No findings remained. Local synthetic bearer labels are deliberately public test identities, not credentials for any service. No implementation TODO/FIXME remains in this phase; later work is explicitly assigned in the handoff.

Full logs and xcresult remain local under `.local/evidence/`; the compact report and synthetic screenshots are committed here. The failed disk-full build and earlier UI/edit bugs were resolved before this clean run.

## Rendered evidence

- [Ready recap](ui/01-ready.png): three unique moments, explicit UTC coverage, synthetic-data label.
- [Saved reflection](ui/02-saved-edits.png): user text saved through the HTTP repository, independently checked in backend state.
- [Offline cached recap](ui/03-offline.png): cached content visible with offline label and disabled writes.
- [Empty](ui/state-empty.png), [pending](ui/state-pending.png), [partial](ui/state-partial.png), and [failure](ui/state-failure.png): distinct domain states, without treating missing observations as complete coverage.
- [Large text](ui/large-text-ready.png): wrapping and scrollable content; no fixed-height truncation in the inspected screen.

The first accepted screenshots use iPhone 17e / iOS 26.5. The final clean-source run passed both UI tests on iPhone 17 Pro Max / iOS 26.5. Inspected screenshots: [Home](ui/large-01-ready.png), [saved edits](ui/large-02-saved-edits.png), [History](ui/large-history.png), [Device and waiting sync](ui/large-device.png), [offline](ui/large-03-offline.png), [empty](ui/large-state-empty.png), [pending](ui/large-state-pending.png), [partial](ui/large-state-partial.png), [failure](ui/large-state-failure.png), and [large text](ui/large-large-text-ready.png). History shows pending after a correction invalidates generated input; the saved recap and separate edits remain readable while regeneration is pending. Accessibility identifiers and large text are tested; spoken VoiceOver behavior is not certified here.

## Boundaries

No real photographs, private calendar data, mail, account credentials, AWS resources, model calls, app uploads, device software installation, CI triggers, hooks, watchers, or nightly jobs were used. Local test servers are bounded and shut down at completion. Native Simulator application installation is part of local UI testing, not a physical-device installation or app upload.

The local store is not an AWS emulator. A successful checksum/ownership test does not certify S3 policy enforcement, IoT policy enforcement, Cognito token validation, DynamoDB transactions, or cloud deletion. Those tests remain explicit later-phase gates.
