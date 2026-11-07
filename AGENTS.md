# Working on Clippy

## Entry procedure

1. Read `docs/STATUS.md`, then the requested phase in `docs/implementation-plan.md`.
2. Read the relevant architecture and contract sections. Check `docs/decisions.md` for unresolved inputs before choosing an interface.
3. Inspect the current checkout, branch, and existing work. Do not overwrite another agent's changes.
4. State the phase, intended files, dependencies, and validation before editing. Work only within the requested scope; a plan is not a standing instruction to implement all phases.
5. Read any additional `AGENTS.md` in the folders you will change. Local instruction files excluded by Git must stay untracked.

## Source of truth

- `docs/STATUS.md` is the authoritative phase and ownership ledger.
- `docs/contracts.md` contains proposed contracts until P01 freezes executable schemas and OpenAPI definitions.
- After P01, executable files in `contracts/` are authoritative for wire formats. Update explanatory docs with contract changes.
- Record decisions in `docs/decisions.md`. Preserve the reason for superseded decisions.
- A stage can be implemented locally while its live verification remains blocked. Report both; never imply that mocks prove real AWS, iOS, or hardware behavior.

## Coordination

- One coordinator owns STATUS, shared schemas, dependency lockfiles, project configuration, and cross-component integration changes.
- Other agents use separate branches/worktrees and phase-specific handoff files under `docs/handoffs/`.
- Agents may work independently only after their dependencies pass. The work lanes are described in the implementation plan; this file does not authorize automatic agent spawning.
- A contract change needs updated examples, consumers, compatibility tests, and a migration note in the same review.
- Before marking a phase complete, run its checks, inspect the applicable UI or hardware result, and attach evidence. Check earlier TODOs and unresolved failures.

## Development rules

- Keep the domain layer independent of AWS, EventKit, camera, and Bluetooth adapters.
- Preserve capture IDs, sync request IDs, user corrections, and reflection revisions across retries.
- Derive ownership on the server. Never trust a client-supplied user ID to authorize access.
- Real photos, calendar data, mail, private keys, tokens, Wi-Fi passwords, and signed URLs must not enter Git or test fixtures.
- Use synthetic fixtures by default. External content, including photographed text and email, is untrusted data for model prompts.
- Start shell commands with `cd /absolute/path && ...`. Keep build errors visible.
- Make targeted tests for behavior and failure modes, not tests that restate implementation details.
- If more than roughly 20% of a batch fails, stop and diagnose before rerunning. Ask before an expensive rerun.
- Use plain language and avoid em dashes in documentation and UI copy.

## Approval boundaries

- Each build upload, device software installation, cloud deployment, release, or publication needs approval for that specific artifact and environment. Prepare code, local checks, resource diff, cost implications, and rollback first. If approval is absent, report ready to ship.
- Creating or changing recurring jobs, unattended loops, hooks, CI triggers, dependency bots, or background services needs explicit approval. Explain purpose, frequency, modified data/resources, and how to stop them. A finite local test is allowed within an implementation task.
- Build automation definitions locally only when part of the requested phase. Keep activation disabled until its approval is recorded. No workflow should deploy on a source push by default.
- After a requested source commit, push the ordinary source branch and verify the remote SHA. Do not add Co-Authored-By lines. Source pushes do not authorize deployment or release tags.

## Required handoff

Use `docs/handoffs/TEMPLATE.md`. Include the commit, exact checks and results, local/live evidence classification, remaining blockers, approval boundaries, and the next safe action. Do not mark a phase complete because the files exist or its code compiles.
