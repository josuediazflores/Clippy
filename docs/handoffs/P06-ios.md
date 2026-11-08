# Phase handoff: P06

## Identity and scope

- Phase/work package: P06 native iPhone experience.
- Owner: Person 1 lane (iOS), implemented with Claude Code at James's request for the hackathon.
- Starting commit: `3581ecd` (`origin/p04-backend`, P04 local_complete). Branched from P04 so the app runs against the finished local backend, then rebased onto `main` after P04/P08 merged.
- Result branch: `p06-ios`, pushed and fast-forwarded to `main` at the user's request.
- Files owned/changed: `apps/ios/App/**`, handwritten `apps/ios/Core/Sources/ClippyCore/*` (not generated `Wire.swift`), `apps/ios/Core/Tests/**`, `apps/ios/UITests/**`, this handoff, a P06 section in `docs/decisions.md`.
- Coordinator-owned files touched (please review): `apps/ios/project.yml` and the regenerated `Clippy.xcodeproj/project.pbxproj` and `App/Info.plist` (display name, camera usage string, `clippy` URL scheme, empty Cognito keys, portrait only). Signing changed from `CODE_SIGNING_ALLOWED: NO` to automatic signing with team `9UMCCFSYB9` so the app can run on a phone from Xcode; simulator scripts still pass `CODE_SIGNING_ALLOWED=NO`. XcodeGen 2.46.0 was used; the repository notes 2.44.1. No contract, schema, fixture, lockfile, backend, or STATUS change.
- Dependencies checked: P03 local_complete; P04 local_complete on `p04-backend`.
- Status: **local_complete** pending coordinator review. Cloud sign-in is configured for the deployed development environment; no end-to-end Cognito sign-in, physical-iPhone run, or TestFlight evidence yet.

## Result

A four-tab SwiftUI app (Today, History, Device, You) in a monochrome, low-text style.

- **Sign-in:** Cloud (Cognito PKCE, hidden until configured), Local server, or Demo. Launch environment forces a mode for tests.
- **Today / History / day detail:** shared recap layout with status, coverage, summary, a moment timeline, and a reflection editor. History lists days with state and moment count and supports swipe-to-delete with confirmation.
- **Moment detail:** photo through a 60-second read grant (bearer only for the same-origin local server, never for presigned URLs), time, user or generated title, correction sheet, and photo deletion.
- **Edits:** every reflection and correction goes through a persistent outbox. Operation IDs survive retries and restarts. Conflicts keep the user's text and offer Keep mine / Use theirs. Offline saves queue and show a count. A refresh or regenerated recap never replaces a dirty draft or queued text.
- **Offline:** validated `Day` values cached in Application Support; the P03 cache is imported once.
- **Device:** connectivity, last seen, camera state, battery and queue (dimmed and labeled "Last known" when older than 30 minutes), settings applied/pending, Sync now with step progress and cancel, capture settings editor, pairing entry.
- **Pairing:** QR scan with VisionKit (manual entry on simulator), claim, 6-digit device code, done or an honest failure. Camera denial shows a Settings link.
- **You:** time zone, photo retention (1 to 30 days via `PATCH /v1/me/preferences`), Apple Calendar "Soon", sign out, delete everything with job polling. No mail UI.
- **Demo mode:** in-memory simulated backend and wearable; labeled "Demo".

## Decisions and compatibility

- Decisions added: D41 to D49 (renumbered from D30 to D38 because P08 used D30 to D40). D41 (QR payload) and D42 (6-digit proof placeholder) are proposals for P05/P07. D47 records a contract gap: no read route for device configuration. D49 enables self sign-up.
- Contract/schema changes: none. Wire stays v1.0.0.
- Consumers: Swift only. The P05 device should render the D41 QR payload.
- Migration: P03 `Documents/synthetic-day.json` is imported into `Application Support/Clippy/journal-v1.json` and removed. Synthetic data only.

## Verification evidence

Environment: macOS, Xcode 27.2 (27B52), iPhone 17 Pro simulator (iOS 26 runtime), Node 22.23.1 (repo pins 22.23.4), XcodeGen 2.46.0.

- `CLIPPY_SIMULATOR_ID=<iPhone 17 Pro> npm run demo`: **pass** on the final code. All 3 UI tests pass and the harness verifies, server-side on the P04 local server, that the iPhone wrote `UI correction saved` and `UI reflection saved` at revision 2.
  - `testLocalJourneyAgainstServer`: recap, moment photo through a read grant, correction, reflection, History, Sync now ("Waiting for Clippy"), honest pairing failure (501), offline cached reading, offline edit queued and still queued after restart.
  - `testRenderedDomainStatesAndLargeText`: empty/pending/partial/failure/ready fixtures, accessibility XXXL text, no-device state.
  - `testDemoPairingSyncAndSettings`: demo sync to Uploaded, QR manual entry, claim, 6-digit code, paired, account screen.
- `npm run check`: contracts (3 languages, 32 fixtures, 363 cases), TypeScript build, 53 backend tests (52 pass, 1 skipped), lint, Prettier, Python lint/tests pass. `swift test` runs 19 Core tests: 17 pass here; the 2 tests that persist to disk (`testOfflineEditSurvivesRestart...`, `testImportsP03Cache...`) failed only because this agent's command sandbox denies Foundation's atomic-write temp file (`mktemp ... Operation not permitted`). Both passed in an earlier run in this session, and the same atomic persistence passes on the simulator (queued edit survives restart, offline cache reload). **Rerun `swift test --package-path apps/ios/Core` outside the sandbox before accepting.** `npm run synth` was run separately and passes.
- Core unit tests cover: outbox replay with the same operation ID across restart, conflict keep/discard, rejected targets, expired sign-in stopping the flush, draft preservation over a regenerated recap, cache migration and unknown formats, QR parsing, PKCE (RFC 7636 vector), token refresh and forced sign-in, stale battery, sync progress, loopback-only HTTP.
- UI inspection: all exported screens reviewed in light mode, plus Demo Today in dark mode. Fixed before acceptance: time column wrapping, per-mode storage leak (a Local queued edit showed in Preview), large-text wrapping of status and pills, red destructive text, fixed-size titles not scaling.
- Screenshots: `.local/evidence/screenshots/` (ignored, synthetic data only).
- Not run: physical iPhone, real camera/QR scan, camera-denied path, end-to-end Cognito sign-in and AWS API calls with a real token. VoiceOver listening pass not performed.
- Service evidence (account 666809320017, us-east-1, read-only unless noted): `ClippyData-dev` and `ClippyRuntime-dev` are `CREATE_COMPLETE`. The HTTP API `https://7oarnrv3b5.execute-api.us-east-1.amazonaws.com` (`$default` stage) exposes 17 user routes, each with a JWT authorizer and scope `clippy/journal`; an unauthenticated `GET /v1/me` returns 401. The Cognito client matches the app (callback `clippy://auth/callback`, code flow, no secret, scopes `openid email clippy/journal`), and the hosted authorize page answers the app's exact PKCE request. Device-claim and configuration routes are not deployed; the app maps API Gateway's bare 404 to "Not available yet".
- Deployment (approved by James in this session): `npx cdk deploy ClippyData-dev` enabling self sign-up (D49). The pre-deploy `cdk diff` change set showed only `AdminCreateUserConfig.AllowAdminCreateUserOnly` modified in place. After the deploy, the pool reports `AllowAdminCreateUserOnly: false` and the `/signup` page returns 200. No user has been created by this work.
- Device signing: a `generic/platform=iOS` Debug build signs with the team's Apple Development identity and automatic provisioning. Installation on the phone was done by the user in Xcode.

## Remaining work and risks

- First unmet acceptance condition: live behavior. an end-to-end Cognito sign-up/sign-in and authenticated API calls from the app have not been run, nor physical-iPhone camera scanning.
- P04 returns 501 for device claims and configuration PATCH. The app shows "Pairing isn't live yet" / "Not available yet". P07 owns claims; configuration PATCH needs a backend route and a way to read desired configuration (D47).
- Not implemented: Wi-Fi provisioning and BLE transport (P07), Apple Calendar selection and EventKit (P09), push notifications (P10), onboarding explainer screens beyond sign-in.
- Not verified: iOS 18 runtime (only the installed iOS 26 simulator), VoiceOver listening pass, real camera denial, real QR scan.
- The Device tab shows the first owned device only.

## Next agent instructions

Coordinator: review the project.yml/pbxproj changes and D41/D42/D47. Rerun `swift test --package-path apps/ios/Core` and `npm run demo`.

To try it: open `apps/ios/Clippy.xcodeproj`, run the Clippy scheme on an iPhone simulator, and pick Demo. For Local, run `npm run local` first.

Wait for approval before any TestFlight upload, further deployment, or a different environment's Cognito keys.

Proposed STATUS update: `P06: local_complete. Person 1, on main. App configured for the us-east-1 development deployment with self sign-up (D49, deployed). End-to-end cloud sign-in and physical-iPhone verification pending.`
