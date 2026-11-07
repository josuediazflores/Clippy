# Local development

P01-P03 use synthetic data only. There is no cloud setup step, CI trigger, hook, recurring task, device installation, or paid provider. Run commands from the repository root.

## Pinned prerequisites

- Node 22.23.4 (`.nvmrc`), npm 11.8.0. Use your version manager; installation is separate from checks.
- CPython 3.12.13 (`.python-version`), uv 0.11.21. `uv sync --locked` installs the project and exact `uv.lock` dependencies.
- macOS with Xcode 26.6 (17F113), Swift 6.3.3, iOS Simulator SDK/runtime 26.5. iOS deployment minimum is 18.0. Signing is disabled for simulator builds. iOS 18 runtime behavior is not verified by building with minimum target 18.
- XcodeGen 2.44.1 only when changing `apps/ios/project.yml`. The generated `.xcodeproj` is committed, so normal setup does not need XcodeGen.
- TypeScript 5.9.3, CDK library 2.275.0 / CLI 2.1148.0, and all other JavaScript dependencies are pinned in `package-lock.json`.
- No external Swift packages. The local Swift package contains generated Codable models, validation, domain ports, and HTTP/fixture adapters.

## Clean checkout

```sh
npm ci --no-audit --no-fund
uv sync --locked
npm run check
bash tools/ios-build.sh
bash tools/device.sh --output .local/device --count 2
```

`npm run check` is finite: generated-model drift, Python/OpenAPI contracts, TypeScript fixtures/types/tests/lint/format, Python lint/tests, Swift package tests, and local CDK synthesis. `ios-build.sh` builds the committed project for both simulator architectures. Build stderr stays visible. Outputs go into ignored `.local/`, `.build-local/`, and Swift `.build/`. The CDK app intentionally has zero resources and no providers/assets/lookups. It is not a deployable stack.

Targeted commands:

```sh
uv run python tools/validate_contracts.py
npm run check:contracts
npm run build
npm test
npm run lint
npm run format:check
uv run ruff check device tools/*.py
PYTHONPATH="$PWD/device" uv run python -m unittest discover -s device/tests -v
swift test --package-path apps/ios/Core
npm run synth
```

After changing a contract, update its fixtures and semantic validators, regenerate models with `uv run python tools/generate_models.py`, and run the three-language gate. Generated models are excluded from Prettier; edit the schema, not generated shapes. OpenAPI's inlined schemas must agree with the shared definitions. `npm run format` formats handwritten TypeScript. `uv run ruff format device tools/*.py` formats Python. No formatter or dependency task runs automatically.

To regenerate the Xcode project explicitly:

```sh
xcodegen generate --spec apps/ios/project.yml
```

## Full local demonstration

```sh
npm run scenario
npm run demo
```

`scenario` runs the device in separate Python processes, interrupts/resumes the first snapshot, verifies HTTP ingestion, exercises deterministic partial/failure branches, saves edits, repeats a second snapshot, and validates the resulting three unique moments. It rewrites deterministic synthetic `fixtures/ui/*.json` and writes `.local/evidence/P03-report.json`.

`demo` adds the iPhone simulator journey, verifies the iPhone's correction/reflection writes in server state, tests cached offline reading, renders all six states and large text, and exports `.local/evidence/screenshots/` plus `P03-ui.xcresult`. It uses loopback port 8787, closes its server in a finally block, caps commands at finite deadlines, and enables no service or schedule. The default creates/reuses the task's simulator recorded in `.local/simulator-id`. To use an available simulator:

```sh
CLIPPY_SIMULATOR_ID=<simulator-uuid> npm run demo
```

For a finite manual inspection after a scenario, use `CLIPPY_LOCAL_DATA=.local/scenario CLIPPY_LOCAL_MAX_SECONDS=180 npm run local`, then open the app in Simulator. The server exits after 180 seconds or Ctrl-C. Maximum allowed lifetime is 900 seconds. No launch agent, watcher, or automatic processing loop is installed. `/local/process` is an explicit driver hook; it is not a production API or cloud worker.

Python launchers explicitly set `PYTHONPATH` to this checkout's `device/`. On this Mac, hidden flags on `.pth` files caused CPython to skip the editable-package path after installation. This explicit path keeps the finite commands independent of that filesystem behavior. It does not change global Python settings.

A complete fresh source-export check, including a new simulator build, is available as:

```sh
uv run python tools/clean-check.py
```

It copies tracked and nonignored source into a temporary directory under `.local`, runs locked installs, `npm run check`, a fresh iOS build, and the local scenario, then removes that export. Allow several GB of free disk space for Xcode and Simulator. Build stderr remains visible. To include UI tests in that fresh export, select an existing simulator and run:

```sh
CLIPPY_CLEAN_UI=1 CLIPPY_SIMULATOR_ID=<simulator-uuid> uv run python tools/clean-check.py
```

This retains the accepted export's reports, screenshots, and xcresult in `.local/evidence/clean-ui` before deleting the temporary source tree. No recurring checks are activated.

Do not point local adapters at real accounts or expose the synthetic token registry to the network. The local data format is disposable, single-process JSON/files. It is not DynamoDB, a durable distributed outbox, an encrypted hardware queue, or a production account store. Reset only this task's generated data by removing `.local/scenario` and the simulator app's local synthetic cache. Retain source fixtures and evidence. Production migrations and rollback are later phases.
