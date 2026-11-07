# Clippy

Clippy is a wearable camera companion and iPhone journal. P01-P03 now provide a local foundation: executable contracts, three runnable projects, and a synthetic capture-to-recap flow with corrections, reflections, resumable uploads, and simulator UI evidence.

No AWS resources, real account connections, device installations, app uploads, paid model calls, or recurring jobs are active.

## Run locally

Use the pinned prerequisites and clean-checkout steps in [local development](docs/local-development.md).

```sh
npm ci --no-audit --no-fund
uv sync --locked
npm run check
npm run demo
```

`npm run demo` runs two synthetic snapshots through the Python simulator and local TypeScript ingestion/processing service, builds/tests the SwiftUI iPhone app, verifies its edits on the server, and exports screenshots and a report. It stops its server when finished. No nightly job is activated; `nightly` is only the second snapshot's test trigger.

## Start here

- [Current progress and evidence](docs/STATUS.md)
- [Two-person handoff and ownership](docs/handoffs/P03-local-flow.md)
- [Implementation plan](docs/implementation-plan.md) and [architecture](docs/architecture.md)
- [Executable contract rules](contracts/README.md), [OpenAPI](contracts/openapi.json), and [JSON Schema](contracts/schema.json)
- [Decisions and remaining inputs](docs/decisions.md)
- [Verification and release gates](docs/verification.md)

Agents must read [AGENTS.md](AGENTS.md). Shared contracts and project configuration stay under one coordinator. Person 1 can begin P05 device software and P06 iPhone work. Person 2 can begin P04 backend/infra, then P08 processing once P04's local gate passes. P07 pairing and P09 Calendar remain coordinated dependency work. P04 and later were not implemented by this foundation task.

## Product scope

The intended product captures periodic photos, supports daytime Sync now and an optional nightly routine, and produces daily recaps the user can correct and reflect on. Apple Calendar is the first optional integration. Mail remains deferred pending provider feasibility.

Real camera/IMU/location/display/BLE, secure local storage, Cognito/IoT/S3/Step Functions/Bedrock, EventKit, notifications, and production retention are later adapters and gates. [Hardware boundaries](docs/hardware-adapters.md) identify their owners and missing inputs. Local mocks do not verify live service permissions or hardware reliability.
