# ADR-022: Agents write to Living Memory through admin-configured repository folders

Let agents land files in Git and in Living Memory without a local clone, through folders an administrator names.

- **Audience**: Projects and platform engineers
- **Owner**: Projects / Platform team
- **Status**: Accepted
- **Date**: 2026-10-15
- **Deciders**: The product owner, Projects / Platform team
- **Relates to**: [ADR-021](021-direct-repository-coding-instructions.md) — it covers coding instructions only and leaves Living Memory ingestion unchanged; this decision builds on that boundary

## Context

Plugin delivery means an agent has no local clone of the project's repository.
It still produces files that belong in Git and in Living Memory: specs, task
breakdowns and working notes. Today they reach the repository through the clone
the agent works in; without one, nothing carries them there.

Living Memory already reads one branch (`ref`) of a connected repository. A
project's repository sync, `ProjectContextRepositorySync`, ingests selected
folders of that branch into the project's context, so a file committed there
reaches every reader without a separate upload path.

ADR-021 deals with coding instructions only. It reads them straight from Git and
leaves Living Memory ingestion unchanged, so it offers an agent nothing for
memory files.

The product rule behind the existing agent surfaces is that a person stands
between one agent's edit and the next agent's read. The OAuth scope ceiling in
`packages/auth/lib/oauth-scopes.ts` grants read and propose-for-review, and
nothing that publishes. The instruction tool in
`apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts` always proposes and
never publishes, so an agent cannot edit the instructions the next agent reads
with nobody in between. A write lane for memory has to say precisely where it
keeps that rule and where it does not.

## Decision

Fabric adds a write lane for Living Memory. A project administrator names one or
more write folders, and agent files are written into them by Fabric, not by the
agent.

**Where files may go.** A write target is a folder inside the sync's selection,
on the sync's `ref`. Fabric commits with the repository integration's
server-held credential. The credential never reaches the agent or the plugin. A
destination outside the sync's branch or selection is not a valid target, because
Living Memory could never read it back.

**How they land.** Each target has a mode, per folder:

- `PULL_REQUEST` (the default) opens a pull request against the sync's `ref`.
  Nothing reaches Living Memory until a person merges it and the next sync run
  reads it.
- `DIRECT_PUSH` commits to the sync's `ref` itself. The next sync run, or the
  push webhook for an automatic sync, brings the files into Living Memory.

**Who may turn on direct push.** Creating or editing a target needs
`CONTEXT_CREATE`, like configuring the sync. Setting a target to `DIRECT_PUSH`
additionally needs `PROJECT_SETTINGS_EDIT` (project administrator and up), checked
on the result of the change. Fabric records who enabled direct push and when, and
clears both when the mode goes back to `PULL_REQUEST`. Direct push is an explicit
administrator opt-in per folder, and the product owner approved it on 2026-10-15.

**What can never be a target.** Instruction folders. A folder that overlaps the
coding-instructions root of a sync on the same repository integration, in either
direction, is refused. So is anything the sync itself would leave out: a folder
the default exclusion rules drop, and a left-out path of the sync. A sync has at
most ten targets, and no two of them overlap by path prefix.

**Reserved folders.** The repository root, and any folder with a path segment that
starts with a dot, are never targets, whatever the sync selects. That rules out
`.github`, `.gitlab`, `.azuredevops`, `.circleci`, `.devcontainer`, `.vscode`,
`.husky`, the Fabric CLI's `.fabric`, and every other hidden folder, without a
list that could go stale. The same rule applies to each path written inside a
target: a path with a dot-prefixed segment below the target folder is refused.
CI and tool configuration must never be agent-writable. A build system or an
editor runs those files, so a workflow file committed by a direct push would turn
a memory write into code execution with the repository's CI privileges. The rule
is checked when a folder is created or edited and again at admission, so a target
that is no longer valid is refused as stale.

**What admission checks.** Admission performs only the static checks: the
project's mode, the sync's state, the caller's rights, the target's validity
against the current configuration, path and content rules, a secret scan, and the
sync's headroom. It does not read the repository. Everything that depends on the
branch tip happens in the write workflow, because the tip can move after
admission anyway: create-only versus `ifMatchOid` for each path, the folder's
`.contextignore` at the tip, and per-path conflicts.

**A later scope.** A new OAuth scope, `memory:write`, will be the one deliberate
exception to propose-only, and it reaches only folders an administrator has put
in `DIRECT_PUSH`. Every other grant keeps the ceiling in `oauth-scopes.ts`.

This ADR covers the model and the admission rules. The write workflow, the MCP
tool, the CLI and the UI follow separately.

## Alternatives Considered

- Generalising the instruction git-intents. `ProjectInstructionGitIntentEntry` is
  tied by foreign key to `ProjectInstructionSnapshot`, and carries instruction
  versions, retention and proposal caps that mean nothing for memory files.
  Reusing it would either bend that model or put memory files into the
  instruction version history.
- A destination outside the sync's branch. Living Memory reads one branch of the
  selected folders, so files written elsewhere would never be ingested.
- Agent upserts straight into Living Memory. The files would exist only in
  Fabric and never reach Git, so the repository would stop being the single
  author of record for the folders the sync manages, and everyone who works from a
  checkout would never see them.
- A plugin-local outbox. It puts the files back on the machine that has no
  checkout, has no server-held credential, and leaves nothing a reviewer can see
  until the plugin retries.

## Consequences

On a `DIRECT_PUSH` folder, the next agent reads writes that nobody has reviewed.
We accept this for memory: it is working material, an administrator chose the
folder knowingly, and every change is a Git commit that can be reverted. We never
accept it for coding instructions, which is why their folders can never be
targets.

Branch protection decides what happens when Fabric cannot push. A protected
`ref` refuses the direct commit, and the write degrades to a pull request rather
than failing or bypassing the rule.

A pull-request write is invisible to Living Memory until it merges. Readers and
the next agent see the old state in the meantime, and the interface has to say so.

Write receipts outlive their targets, as sync run receipts outlive a disconnect.
Deleting a target, or its sync, removes the configuration and not the history of
what was written through it, so each receipt freezes the folder, mode, `ref` and
repository integration it was admitted against.

Because admission is static, a request can pass admission and still end in a
conflict or a refusal at the tip. The receipt records that outcome, and the caller
is expected to read it.

Vercel Function request bodies are capped at 4.5 MB, so the write path in the next
phase must stage file bytes through direct-to-storage uploads, as instruction
uploads do through `create-upload-urls.ts`, not through inline request bodies.
Admission then hashes the bytes that were staged, not what the request carried.
The first phase's `validate` route takes content inline, so in practice a whole
request is bounded by that cap, whatever per-file and per-request limits it
enforces itself.
