# Local development

P01-P03 use synthetic data only. There is no cloud setup step, CI trigger, hook, recurring task, device installation, or paid provider. Run commands from the repository root.

## Pinned prerequisites

- Node 22.23.4 (`.nvmrc`), npm 11.8.0. Use your version manager; installation is separate from checks.
- CPython 3.12.13 (`.python-version`), uv 0.11.21. `uv sync --locked` installs the project and exact `uv.lock` dependencies.
- macOS with Xcode 26.6 (17F113), Swift 6.3.3, iOS Simulator SDK/runtime 26.5. iOS deployment minimum is 18.0. Signing is disabled for simulator builds. iOS 18 runtime behavior is not verified by building with minimum target 18.
- XcodeGen 2.44.1 only when changing `apps/ios/project.yml`. The generated `.xcodeproj` is committed, so normal setup does not need XcodeGen.
- TypeScript 5.9.3, CDK library 2.275.0 / CLI 2.1148.0, and all other JavaScript dependencies are pinned in `package-lock.json`.
- No external Swift packages. The local Swift package contains generated Codable models, validation, domain ports, and later HTTP/fixture adapters.

## Clean checkout

```sh
npm ci --no-audit --no-fund
uv sync --locked
npm run check
bash tools/ios-build.sh
uv run clippy-device --output .local/device --count 2
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
uv run python -m unittest discover -s device/tests -v
swift test --package-path apps/ios/Core
npm run synth
```

After changing a contract, update its fixtures and semantic validators, regenerate models with `uv run python tools/generate_models.py`, and run the three-language gate. Generated models are excluded from Prettier; edit the schema, not generated shapes. OpenAPI's inlined schemas must agree with the shared definitions. `npm run format` formats handwritten TypeScript. `uv run ruff format device tools/*.py` formats Python. No formatter or dependency task runs automatically.

To regenerate the Xcode project explicitly:

```sh
xcodegen generate --spec apps/ios/project.yml
```

The P03 handoff adds the finite end-to-end/UI command and its exact simulator evidence. Do not point local adapters at real accounts or expose the loopback synthetic token registry to the network.
