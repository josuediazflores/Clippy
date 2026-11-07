# Clippy

Clippy is a wearable camera companion and iPhone journal. It captures selected moments during the day, uploads them on demand or overnight, and produces a daily recap that the user can correct and reflect on.

This repository currently contains the architecture and implementation plan. Application code, cloud infrastructure, device firmware, and automated jobs have not been implemented or deployed.

## Start here

1. Read [current progress](docs/STATUS.md) to find the next available phase.
2. Read the [architecture](docs/architecture.md) for the system design and responsibilities.
3. Follow the [implementation plan](docs/implementation-plan.md), one phase or assigned work package at a time.
4. Use the [contracts](docs/contracts.md) for app, backend, and device boundaries.
5. Check the [verification and release gates](docs/verification.md) before calling a phase complete.

Agents must also read [AGENTS.md](AGENTS.md). Use the [handoff template](docs/handoffs/TEMPLATE.md) when passing work to another agent. [Decisions](docs/decisions.md) distinguishes confirmed requirements, proposed defaults, and unresolved inputs. [Sources](docs/sources.md) records the platform documentation behind the plan.

## Product scope

- Native iPhone app with Home, History, and Device tabs.
- Daily recap and reflection as the primary experience.
- Periodic photos, optional location context, and a local privacy pause gesture.
- Automatic nightly upload with a user-controlled schedule and a daytime Sync now action.
- Apple Calendar integration through EventKit and explicit permission.
- Optional mail integration only after provider access and permissions are validated.
- AWS device identity, storage, processing, API, and notifications.

The hardware owner designs the enclosure, Raspberry Pi configuration, camera, IMU, screen, battery, charging, and location hardware. Software work begins with adapters and a simulator so it can proceed before the physical prototype is ready.

## First complete demonstration

A user pairs one device, records a small set of sample moments, pauses capture, triggers Sync now, sees Today so far, corrects a moment, and writes a reflection. A simulated nightly sync adds new moments to the same day without duplicates or losing the user's edits. The approved hardware/cloud integration later repeats this flow on real equipment.

## Operating boundaries

The plan describes future behavior. It does not activate schedules, install background services, create cloud resources, or authorize a release. Prepare and verify each concrete deployment or installation before requesting its specific approval. Source changes and their review are separate from deployment.
