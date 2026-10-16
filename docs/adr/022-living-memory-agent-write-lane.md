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
exception to propose-only. It reaches only the folders an administrator has
named as write folders: a `PULL_REQUEST` folder still has a person merge before
Living Memory reads the files, and a `DIRECT_PUSH` folder is where the exception
bites. Every other grant keeps the ceiling in `oauth-scopes.ts`.

This ADR covers the model, the admission rules and, in the next section, the
write workflow. The MCP tool, the CLI and the UI follow separately.

## Phase 2: the write workflow

`memoryWrites.submit` admits a write and starts one Temporal workflow for it,
`memory-write-<writeId>`, on the queue the instruction direct-commit workflow
uses (its activities run on `fabric-worker`, the worker image that has git). The
workflow owns every git write. It has none of the instruction machinery: no
snapshots, retention, caps, member branches or settlement.

**Staging bytes.** A request body cannot carry a write, so bytes live in storage
between the request and the commit. `createUploadUrls` signs one short-lived PUT
(ten minutes) per file, for text of at most 2 MiB, with the declared size part of
the signature, under `memory-writes/<projectId>/<uuid>` in the bucket the
instruction uploads use. `submit` takes each PUT either as inline `content` (at
most 3 MiB of inline text per request) or as `{stagedKey, sha256, bytes}`. The
server reads a staged object back and checks its size and hash, and judges the
request on the real bytes, so the secret scan and the content rules see what
will be committed. It stages inline text itself, under a key no URL was ever
signed for, so the workflow always reads from storage and a Temporal payload
carries ids, never text. A signed URL stays usable until it expires, so the
workflow verifies size and hash again before it hashes anything into a commit.
The staged bytes of a write that landed are removed; those of a conflict, a
refusal or a failure stay, because the caller may send the same request again,
and the bucket's lifecycle is what ages out the rest.

**The receipt, dedupe and the cap.** An admitted write stores its receipt, with
the folder, mode, branch, repository integration and target version frozen. The
same member sending the same request (the digest covers the project, target
version, message, paths, operations, `ifMatchOid` and content hashes, so it is the
same whether the bytes came inline or staged) within two hours gets the existing
receipt back with `deduplicated: true`, if that receipt is still pending or
landed. A receipt that was refused, conflicted or failed is not returned: sending
the request again after fixing the cause is a new write. A member may have five
writes pending in a project (`TOO_MANY_PENDING_WRITES`), counting only receipts
from the last three hours, longer than the workflow can run, so a receipt whose
workflow died does not lock a member out. Calls through the API itself record
`via: APP`.

**Live re-check.** The workflow reads the receipt (it must be `PENDING`) and then
every fact it relies on again: the target exists at the same version
(`TARGET_CHANGED`), the sync is on the same branch and integration
(`SYNC_CHANGED`) and still ingesting (`SYNC_NOT_INGESTING`), the project is not
read-only, the member and the member automatic runs act as still hold
`CONTEXT_CREATE`, and the folder still passes the rule that admitted it
(`TARGET_STALE`). It checks again immediately before it pushes. The pure rules
(`target-rules.ts`, `evaluate.ts`) live in `@repo/temporal`, with the API
importing them from there, so admission and the workflow judge with the same
functions.

**The tip checks, and the batch is atomic.** The workflow clones the sync's
branch blobless with the integration's fresh credential and reads the tip. A PUT
without `ifMatchOid` requires the path to be absent. With `ifMatchOid`, the blob
there must be exactly that one. A DELETE requires an existing path holding the
blob it names. The selected folder's `.contextignore` at the tip is applied, so a
rule added after admission still leaves a path out (`PATH_EXCLUDED`); an ignore
file the sync could not evaluate refuses the write. A folder, a link or a
submodule where a file should be, or a file where a folder should be, is
`PATH_NOT_A_FILE`. Every path is judged and the write is applied whole or not at
all: one problem settles the write with a verdict per path and nothing is
committed. It is a `CONFLICT` when any path changed under the caller, carrying
the blob now at the path so the caller can read it and send the write again with
a fresh `ifMatchOid`; otherwise it is `REFUSED`. A PUT that already holds its
bytes writes nothing, and a write with nothing to change is `REFUSED` as
`NO_CHANGE`.

**The commit.** One commit on the tip, authored as the member (the display name
and the deployment's `noreply@` address) and committed by Fabric, with the
caller's message and two trailers, `Fabric-Memory-Write: <writeId>` and, when the
write came through an OAuth client, `Fabric-Agent: <client id>`. A message with a
line that spells one of Fabric's own trailers, or that holds a credential, is
refused, so the trailers can be trusted.

**Direct push, retry and busy.** The push is leased on the tip it was built on.
Before each pass the workflow looks for a commit that carries this write's
trailer as the last paragraph of its message, so a push whose acknowledgement was
lost is found and settled, never pushed twice. A lost lease redoes the checks and
the commit on the new tip (a path that changed in the meantime now surfaces as a
conflict instead of being overwritten), up to five passes with a jittered backoff,
and then the write is `FAILED` as `BRANCH_BUSY`, retryable. An activity retry that
finds the live checks refusing still looks for a commit an earlier attempt
pushed, since that is a fact they do not undo.

**Protection falls back to a pull request.** A branch that refuses the push
(protection, a hook, no write permission) does not fail the write: the same commit
is pushed to its own branch and a pull request is opened, with `reason:
"protected"`.

**A pull request per write.** For a `PULL_REQUEST` folder, and for that
fallback, the commit is pushed to `fabric/memory/<writeId>` create-only, behind
its own ref guard (`assertMemoryWriteBranch`), and a pull request is opened from
it into the synced branch through the provider adapters. The title is the
message's subject; the body is the message's body, the files, and an "Opened from
Fabric by <member>" footer, escaped and with mentions neutralised, since the
message is an agent's. A branch that exists must carry the write's trailer, and
the pull request is looked up before it is opened, so a retry reuses both. There
is no merge watcher: once the pull request is merged, the existing Living Memory
poll or webhook ingests it like any other change. The outcome is `{url,
externalId, branch, reason}`, with `reason` `configured` or `protected`.

**Taking the commit into Living Memory.** After a `COMMITTED` outcome is recorded,
the workflow starts an automatic Living Memory sync for the row the write was made
against (`startAutomaticContextSync`). If a run is already open, it records the
pushed head the way the push webhook does (`recordPendingHead`), so the open run's
completion re-checks the branch. A kick that fails is logged and is not a write
failure: the poll covers it.

**Settling.** The outcome is a typed value (`COMMITTED`, `PULL_REQUEST`,
`CONFLICT`, `REFUSED` or `FAILED`), recorded with the status, `settledAt` and the
`project.context.memory_write_settled` audit row in one transaction. Recording is
idempotent and retried for a long time, because a commit on the branch cannot be
un-pushed; a record that gives up is reported and the receipt is marked `FAILED`
as `SETTLE_FAILED`, never left pending. `memoryWrites.get` reads the receipt: the
status, the outcome, the paths and operations, and the timestamps, never a
message or a staged key. Admission is audited as
`project.context.memory_write_submitted`.

**No README seed.** The first write into a new folder does not create the folder's
README or any other seed file. A write folder is always inside a selected path,
and a selected path that does not exist makes the sync report `PATHS_MISSING`
whether or not anything is written, so the write cannot be the cause. Git creates
the folder with its first file.

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

Vercel Function request bodies are capped at 4.5 MB, so the write path stages
file bytes through direct-to-storage uploads, as instruction uploads do through
`create-upload-urls.ts`, and keeps inline text to 3 MiB a request. Admission then
judges the bytes that were staged, not what the request carried. The `validate`
route takes content inline, so in practice a whole request to it is bounded by
that cap, whatever per-file and per-request limits it enforces itself.

Staged bytes are not removed for a write that did not land, and the staging prefix
(`memory-writes/`) has no sweeper of its own: its objects age out through the
bucket's lifecycle rules. A receipt whose workflow died stays `PENDING`; it stops
counting toward the member's cap after three hours, and no reaper closes it yet.

## Phase 3: agent and CLI access

Phase 3 gives agents and the Fabric CLI the write lane. It adds no admission
rule and no workflow: the doors below call the same `submitMemoryWriteRequest`
as the app's `submit` procedure (admission, the receipt, the audit row, the
workflow start), so a rule changed in one place changes everywhere.

**The scope.** `memory:write` is the deliberate exception to propose-only that
the first section reserved. It is a scope the authorization server understands
and is never a default: it is absent from `OAUTH_DEFAULT_SCOPES`, so an agent
asks for it by name and the consent screen says the worst case, that Fabric may
commit to the synced branch where a project admin allowed direct push. It is
added to the provider's scope lists, to the installed `oauth_resource` policy
rows by migration (the provider seeds resources insert-only, so existing
deployments would otherwise never offer it), to the organization API key
vocabulary and picker, to the CLI's sign-in request and `CLI_SCOPES`, and to the
key the Connect dialog mints for coding instructions. An organization key
holding `mcp:write` satisfies every gateway tool as it always has; OAuth never
issues that scope.

**The scope alone grants nothing.** Every REST route and MCP tool re-checks the
caller's live permission on the project: CONTEXT_CREATE to stage and submit,
CONTEXT_READ to read. That is why a viewer may mint a key carrying the scope
(the Connect dialog puts it on every coding-instructions key, and refusing it
would refuse the dialog to that role): the key can name the scope and never use
it. A credential bound to one project reaches that project alone.

**REST routes**, under `/api/v1/projects/:projectId/memory`, each requiring
the scope:

- `GET targets`: the write folders with mode and version, the branch, the
  repository (provider, owner, name) and the commit the sync last applied.
- `GET files?targetId=&after=&limit=`: what Living Memory holds under one
  folder, from the rows the sync manages (`sourcePath`, `sourceBlobOid`,
  `contentHash`, stored size), paged by path, with `lastAppliedCommitSha`, the
  commit the listing reflects. The repository may be ahead of it, and a
  pull-request write is absent until it is merged and a run has read it. A
  `blobOid` is null for a row no run has stamped yet. Content is not in the
  listing, so a page stays small under the 4.5 MB response cap.
- `GET file?targetId=&path=`: one such file with its text. A path outside the
  folder is not found.
- `POST upload-urls`, `POST writes` and `GET writes/:writeId`: the staging
  URLs, the submit and the receipt of phase 2, with the same bodies. A submit
  answers 202 with the receipt, 400 with every problem in `error.data.problems`,
  429 at the pending cap (`error.data.limit`). The error `data` is where the SDK
  reads a refusal's structured half.
  The write is recorded `via: CLI`, and with the OAuth client's row id when the
  credential is a signed-in agent.

**MCP tools**, in their own gateway module: `fabric_memory_targets` and
`fabric_memory_write_status` are reads, `fabric_memory_write` is a write.
All three name `memory:write`; the reads are `kind: "read"`, so an `mcp:read`
credential can see the folders and receipts (the Context tab shows a reader the
same facts) and cannot write. A write takes inline text only, bounded as in
phase 2, and records `via: MCP` and the OAuth client. The descriptions say what
an agent cannot discover for itself: a file without `ifMatchOid` is create-only,
a replace or delete needs the blob id now at the path (a refused write reports
it as `currentOid`), a pull-request write is invisible to Living Memory until
it is merged, and coding-instruction files go through the proposal tool. The
tools are available on a project-bound session. The gateway's handshake gets
one line naming them.

**Not in this phase.** No tool or route lists a folder's files over MCP, and
nothing mirrors a folder to disk. The CLI mirror and its hooks (phase 4) build
on `files`, `file` and the receipt.

## Phases 4 and 5: the memory mirror and plugin delivery

Phase 3 gave agents and the CLI the write lane. These phases make it invisible:
a developer no longer clones the instructions repository, and an agent writes
memory as plain files with its ordinary file tools.

**The mirror.** `fabric memory pull|push|status` keeps each write folder in the
working tree at its repository-relative path, so a skill that names
`docs/ai/spec.md` works as written. `.fabric/memory.lock` records, per path, the
blob the server held and the sha256 of the content when the two last agreed,
plus an outbox of writes not yet seen to end. A push names the lock's blob as
`ifMatchOid` (a new file names none), so it replaces exactly the version the
folder last saw. A pull never overwrites or deletes a file whose bytes differ
from the lock, and neither command touches a path the developer's repository
tracks. A write's end (a commit, a pull request, a conflict with the blob now
at each path, a refusal, a failure) is folded in by the next `status` or `pull`;
a problem stays in every report until the files are back in step or the person
dismisses it. The hooks never fail a session: one absolute deadline, one line,
no content.

**The plugin.** Instructions reach Claude Code as a plugin whose directory
`fabric instructions render` builds from the project's instructions at the
current pin, deterministically, so a command-source plugin's hash-based version
moves only when the instructions or the write folders do. `CLAUDE.md` is handed
to the session by a `SessionStart` hook, cut at the 10,000 characters a session
start carries with a pointer to the whole file. Codex gets the same skills in a
plugin registered in the personal marketplace, and, having no plugin slot for
always-on text, a git-excluded `AGENTS.override.md` that puts the tracked
`AGENTS.md` first.

**One approval, by the person.** Claude Code runs a command plugin source only
after the person has reviewed the exact command and accepted it, and refuses
that acceptance from anywhere but their own terminal, coding sessions included.
That is a guard against exactly what an agent would otherwise do, so Fabric does
not work around it: `init` registers a marketplace folder (a `directory` source,
as `claude plugin marketplace add --scope local` writes it; an inline `settings`
marketplace is not resolved by `claude plugin install`), hands the terminal to
`claude plugin install` (or prints the lines), and the command is approved once
per change of its text. Plugin is the default for a bare `init`; the clone setup
is kept for `--clone` and for a folder that already is a clone. The plugin
carries the MCP gateway, so `init` adds no second registration and removes the
earlier local Claude Code one of the same name.

**The mirror's boundary.** `fabric memory` writes files and edits
`.git/info/exclude`, so it works only inside the folder `init` marked
(`.fabric/project.json`, found by walking up from the working directory) and
only in the git work tree recorded there. A folder under no mark, or inside a
different repository, is refused before anything is written.
