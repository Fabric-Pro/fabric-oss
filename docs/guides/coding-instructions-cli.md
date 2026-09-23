# Developer Guide: Coding Instructions on the Command Line

How `fabric instructions check | sync | push | init` keeps a checkout current with a project's published coding instructions, how a local edit gets suggested back, and what each command is allowed to touch.

- **Audience**: engineers working on `@fabricorg/cli`, `@fabricorg/sdk` or the v1 REST surface; developers setting a project up on their own machine
- **Owner**: Projects / Platform team

## What this is for

A project publishes a tree of coding instructions in Fabric — `AGENTS.md`,
`.claude/` or `.codex/` skills, rules, and settings. These commands put that tree into a working
copy and keep it current, so a coding agent reads the same instructions
everyone else does without anybody pasting anything.

The intended trigger is a Claude Code or Codex `SessionStart` hook: every
session asks whether the published version moved, and either says so or applies
it.

Working on the project is also when the instructions are most obviously wrong,
so the traffic goes both ways: `fabric instructions push` sends the checkout's
edits back as a **proposal** an editor approves in the tab, or — with
`--publish`, and a key granted that separate authority — as a new version
directly. An agent with no CLI can only propose: the MCP tools
`fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson`
have no publish mode and no scope that would reach one. All of it lands in the
same place and runs the same checks as a folder upload from the browser.

## Install and authenticate

Install or update the CLI before running the coding-instructions commands:

```bash
npm install -g @fabricorg/cli
```

Then authenticate against the deployment that hosts the project. The Connect
dialog supplies the key and exact deployment URL:

```bash
fabric auth login --key <api-key> --base-url https://example.com
```

An explicit `--base-url` is stored with the active CLI profile, so later
commands and generated hooks use the same deployment. `FABRIC_BASE_URL` remains
an execution-time override when it is set.

## The commands

### `fabric instructions check --project <id> [--dest <dir>] [--verify] [--hook]`

Compares the digest in `<dest>/.fabric/instructions.lock` with the published
one and reports the difference. One request, no download, nothing written.
Exits 0 in every outcome — it is informational.

Without `--verify` it reads no local file at all, which is why "published
coding instructions unchanged" is the wording: it means the published version
has not moved, not that your copy still matches it. `--verify` also hashes
every file the lock names and reports the ones that drifted — edited,
deleted, chmod-ed or replaced by a symlink. It stays informational and still
exits 0.

### `fabric instructions sync --project <id> [--dest <dir>] [--dry-run] [--hook]`

Applies the published version. It plans against the working tree rather than
the lock alone, so it can tell a file it wrote from a file the developer
edited, and reports which is which:

| Report line | What happened |
|---|---|
| added | the file was not there |
| updated | the file matched the lock, so the sync's own copy moved forward |
| replaced local edits | the file matched neither the lock nor the published bytes |
| removed | the file left the snapshot and still matched the lock |
| kept, modified locally | the file left the snapshot but had been edited, so it stayed |
| kept, renamed in the published snapshot | the lock names it under one spelling and the manifest under another that means the same file — the write covers it, so the old spelling is left alone |

`--dry-run` prints that plan and downloads nothing.

A `sync` never accepts the server's "unchanged" on its own, and the ledger it
checks is validated before it is read: a lock naming `../outside`, a reserved
path, or two paths one filesystem cannot tell apart stops the run rather than
directing a read. That answer is
about the published snapshot, so before acting on it the command verifies the
lock's own ledger against the working tree; if anything drifted it asks for
the full manifest and plans normally, which puts edited files back, restores
deleted ones and repairs modes. An edited file comes back as **replaced local
edits**, because that is what overwriting it is.

Every response is checked for the project's source of truth, not just the
first one, so a project switched to a repository while a sync was already in
flight stops that hook too. A repository-backed project (source of truth
`REPOSITORY`) can still be synced by hand — for someone without access to that repository, a download is the
only way to read the instructions at all. A `--hook` sync stops instead, with
one line on stderr, because a hook writing into a checkout that `git pull`
also writes is the second writer `init` refuses to create.

`--format json` prints one JSON object instead of prose. Any other value —
`table`, `yaml`, `csv`, the defaults the rest of the CLI uses — prints text,
because these commands have no other shape. The flag resolves the way
Commander resolves it: `fabric --format table instructions check` beats
`FABRIC_FORMAT=json`, because the environment is the root option's default and
an explicit flag replaces a default.

### `fabric instructions push --project <id> [--dest <dir>] [--add <path>] [--publish] [--dry-run]`

Suggests this checkout's edits back to the project. By default it opens a
**proposal**: nothing changes for anybody reading the instructions until
somebody who can edit them approves it in the Coding Instructions tab, where
each changed file is reviewed as a unified diff of its two sides. `--publish`
sends the same change set as a new version with nobody in between — see
"publishing takes its own key" below for the key it needs.

The diff is computed against `<dest>/.fabric/instructions.lock`, so `sync` has
to have run here first — without that ledger there is nothing to diff against,
and the command says so rather than guessing. Three outcomes per locked path,
and nothing else is ever sent:

| Outcome | What happened |
|---|---|
| sent as a change | the local bytes differ from the hash the lock recorded |
| sent as a deletion | the lock names the file and nothing is there any more |
| skipped | the local bytes still equal the lock |

**A file the lock does not name is sent only when you name it**, with `--add
<path>` (repeatable). That is the one case the ledger cannot discover, and the
alternative — walking the checkout — would mean inventing a rule about which of
your repository's files are instruction files. The exclusion rules that decide
that live on the server, with the project's frozen settings, and the CLI has no
copy of them.

At most 50 changes in one push. A change set larger than that is a replacement
rather than an edit, and the tab's folder upload is the operation for it — it is
also the only path that re-reads the project's exclusion rules.

**Publishing takes its own key.** `--publish` is a different authority, not a
mode of the same one. The key the Connect dialog mints carries
`instructions:write`, which it offers to read-only roles and describes as
review-gated; publishing from that key would make the description untrue for
anybody holding `INSTRUCTION_CREATE`, and a scope has to mean the same thing
whoever mints it. So `--publish` calls a different route behind a different
scope, `instructions:publish`, which the Connect dialog never mints. To get
one, create an organization API key in **Settings → API keys** and tick
**Instructions Publish**; a read-only role cannot be granted it. The server
then checks, on every call, that the key's creator still holds
`INSTRUCTION_CREATE` on that project — the scope alone publishes nothing, and
a demotion takes effect at once. A key without the scope gets
`Missing required scope: instructions:publish` and exit code 5.

**A publish is not instant, and `READY` does not by itself mean it landed.**
What comes back is a version whose checks have just started: the same verify
→ secret-scan → publish run a folder upload goes through decides, and the
auto-publish that follows is a separate step that normally completes AFTER
this command has already returned. So the command reports "Published version
N" only once it has actually observed that — never inferred from the checks
alone — and otherwise says the version has been sent and publishes on its own
once its checks pass, pointing at the project's Coding Instructions tab to see
its state. That covers the ordinary case (the publish lands a moment later)
and the one worth naming explicitly: a concurrent edit's own publish can win
the race first, in which case this version stays `READY` and unpublished —
intact, not lost — and the tab's History is where to see that and publish it
deliberately if it is still wanted. The lock is not rewritten on either path —
run `fabric instructions sync` afterwards to bring the checkout onto the
version that landed.

`--dry-run` prints the change set and sends nothing; with `--publish` it says
so, because the two do different things.

**Nothing is read until the lock is verified against the server.** `push` fetches
the published manifest first and refuses before opening a single file if the
lock names a version that is no longer published, or if its ledger is not that
version's file list. The lock is a plain JSON file in your checkout: anything
that can write to the working tree can add a path to it, and a command that
trusted the ledger would read that file and upload it. The manifest decides
which paths may be touched; `--add` is the only way to send anything else.

**The lock is never written by a push**, on any outcome, `--publish` included.
It names the published version, which is what `sync` compares against, and a
proposal does not change what is published. A publish does, but only once its
checks pass — after this command has returned — and what lands is the server's
manifest, inherited files and all, which this side cannot compute. Either way
`fabric instructions sync` is what brings the checkout, and the lock, forward.

Two refusals are worth recognising:

- *"published instructions moved past your last sync"* — somebody published
  while you were working. The server refuses rather than rebasing your change
  onto a version you never saw (the spec's `PULL_FIRST` rule; there is no
  server-side merge in any version). Run `sync`, re-apply the edit, push again.
- *the project's instructions come from its repository* — source of truth is
  `REPOSITORY`, so the files are changed in git and mirrored into Fabric. Commit
  and push to the repository instead. Nothing was sent.

### `fabric instructions init --project <id> --tool <claude-code|codex> [--dest <dir>] [--apply] [--lessons]`

For a published snapshot, takes the first copy before writing a `SessionStart`
hook. Claude Code writes `<dest>/.claude/settings.local.json` — never
`settings.json`; Codex writes `<dest>/.codex/hooks.json`. A failed first sync
leaves no new or updated hook behind. If nothing is published yet, it installs
the hook so it can report the first version when it arrives. The hook runs
`fabric instructions check` by default, so rules are not swapped under a
developer mid-task; `--apply` makes it run `sync` instead. Running `init`
again replaces its own entry rather than adding a second one.

After starting Codex in the checkout, use `/hooks` to review and trust its
project hook. `init` does not change that trust decision, and the hook's stdout
becomes developer context in Codex.

It refuses a project whose source of truth is `REPOSITORY`: those instructions
arrive with `git pull`, and a sync hook would fight it. If the project is
switched to a repository later, the installed hook stops applying anything and
says so rather than becoming that second writer.

An explicit `--org <slug>` is carried into the generated hook command. These
commands read no stored default context, so a slug supplied once on the
command line has nowhere else to live.

#### `--lessons`: a Stop hook that asks for a lesson

With `--lessons`, `init` also writes a Claude Code `Stop` hook running
`fabric instructions lesson-prompt --project <id> --hook`. A lesson is a
mistake the team should not repeat, written down as
`Lessons/<date>-<slug>.md` so it becomes a rule instead of a memory. The hook
turns the end of a piece of work into the moment it gets written:

- It asks **at most once per session**, and only after the assistant has
  edited files in that session; a session that only answered questions is
  never interrupted. Once-per-session is tracked in a marker directory next to
  the CLI's own config file, keyed by a hash of the session and project, never
  by the raw ids.
- It makes **no network calls** and needs no API key. It reads the hook's
  stdin and the session transcript, and either prints nothing or prints one
  `{"decision":"block","reason":…}` object that tells the assistant to ask the
  developer the question — *was there a mistake in this session the team
  should not repeat?* — and, only after the developer confirms a draft, to
  call the MCP tool `fabric_add_instruction_lesson`. The tool opens a
  proposal; a person approves it in the tab.
- It **never fails the stop**: malformed input, an unreadable transcript or a
  missing marker directory all exit 0 with nothing on stdout, and a stop the
  assistant is already continuing through (`stop_hook_active`) is passed
  straight through so the hook cannot loop. To see why it stayed quiet, set
  `FABRIC_DEBUG=1`: the reason goes to stderr as one line, which Claude Code
  does not treat as hook output on exit 0.

Running `init` again without `--lessons` removes the Stop entry and leaves the
`SessionStart` one alone; `init` describes the hooks you want, not the ones you
have. `--lessons` is refused with `--tool codex` for now: a Codex hook for
lesson capture is not wired.

## What these commands will not do

These are guarantees, and the tests under `packages/cli/__tests__/` exist to
keep them:

- **`--hook` never fails, and never runs long.** Network, auth, timeout, HTTP
  error, a damaged lock, a retired context default — every failure becomes one
  line on stderr and exit 0. Hook mode also has one absolute deadline (10
  seconds) covering the manifest call and the bundle download together, with
  SDK retries disabled, so it cannot outlive the hook timeout Claude Code
  applies to it. A session that will not start is worse than instructions one
  version stale.
- **The hook command never carries the key.** It names a project. The CLI
  reads its credential from `FABRIC_API_KEY` or its own per-user config file,
  and `init` refuses to write the hook at all if that config file resolves
  inside the destination.
- **Nothing is written outside `<dest>`.** Absolute paths, `..` segments,
  backslashes, control characters, Windows device names (`NUL`, `COM1`, …),
  names containing `< > : " | ? *`,
  segments ending in a dot or space, and colons are refused; two paths that a
  case-insensitive or Unicode-normalising filesystem would treat as one file
  are refused as a pair. The destination is canonicalised with `realpath`, the
  resolved path must sit inside it, and no segment on the way down may be a
  symlink. That holds for the instruction files, the lock and the settings
  file alike — they share one writer.
- **Nothing is written on a checksum mismatch.** Every file's sha256 is
  verified against the manifest before the first byte is written, so a
  corrupt bundle leaves the tree and the lock exactly as they were.
- **No file the sync did not write is ever deleted.** A path must be in the
  lock, and still match the hash the lock recorded, before it can be removed —
  and that hash is checked again immediately before the unlink, not only when
  the plan was made. A file edited while the bundle was downloading is
  reported as *kept, modified locally* instead of removed. `.git/**` and
  `.fabric/**` are refused outright, from the manifest and from the lock
  alike. The root-level hook files `init` owns —
  `.claude/settings.local.json` and `.codex/hooks.json` — are additionally
  always excluded from uploads, even when project ignore settings or
  `.fabricignore` otherwise exclude nothing. The CLI also refuses them from a
  manifest or lock; the rest of `.claude/` and `.codex/`, including nested
  same-name paths, is ordinary instruction content.
- **Only ordinary files are touched, and every read is guarded as well as
  every write.** Manifest paths, delete paths and the lock's own ledger paths
  all go through the same per-segment walk: nothing resolving outside the
  destination, no symlinked component anywhere on the way down, and a regular
  file or nothing at all at the end. A symlink, a directory or a device node
  standing where a file should be refuses the whole sync rather than being
  written through, followed, hashed or unlinked — including when the link is
  an ancestor directory rather than the file itself.
- **A manifest is complete or it is a refusal.** Every entry's path, hash,
  size and mode is checked, no two entries may name the same file, the entry
  count must match the snapshot's, and the digest is recomputed locally from
  the entries and compared. A response that says "published" and carries no
  manifest is an error, never an empty one. The manifest is also held to the
  published snapshot limits — at most 5000 files, 5 MiB each, 50 MiB in total
  — so a malformed response cannot describe an unbounded download.
- **The download is bounded by the manifest, not by the response.** The
  archive size is capped at what the (already validated) manifest describes
  plus 1 MiB of framing; a larger `Content-Length` is refused before the body
  is read, and a body that grows past the cap is abandoned mid-stream. The cap
  scales with the entry count and path lengths, the way zip framing does, so a
  legitimate snapshot of thousands of small files is not refused for being
  mostly structure.
- **A lock belongs to one project.** Running `sync --project B` in a tree
  synced from project A is refused rather than allowed to use A's ledger to
  decide what to delete — and `push --project B` there is refused for the same
  reason, before a byte leaves the machine.
- **A push sends only what you can name.** Every path it reads goes through the
  same guarded walk the writes use, so a symlink standing where an instruction
  file belongs refuses the push rather than being followed, hashed and
  uploaded. Reserved paths (`.git/**`, `.fabric/**`,
  `.claude/settings.local.json`, `.codex/hooks.json`) are refused from the
  lock and from `--add` alike.
- **The same push twice is the same proposal.** The change route identifies a
  proposal by its content — the version it is stated against plus the set of
  paths, operations and hashes it applies — so a request whose response was
  lost comes back with the proposal the first attempt opened rather than a
  second one against the cap of five. Retries are therefore on, here and in the
  SDK, and repeating a push that failed is safe.
- **A failed push is closed out rather than left hanging.** A proposal that
  gets as far as a row and then fails before its validation is started — a
  storage outage mid-upload, an unreachable workflow service — is marked
  rejected by the same request, instead of sitting open for the six hours the
  server's abandonment sweep waits. It still occupies one of your five active
  proposals until the next cleanup sweep clears its staged files, which is
  what keeps those files findable; what changes is hours, not the count. Once
  validation has been started the row is left alone, because by then it may
  belong to a run already reading it.
- **A name that will not install is refused on the way in.** Windows device
  names (`CON.md`, `nul.txt`), names with a trailing dot or space, and NTFS
  names containing any character Windows will not put in a filename
  (`< > : " | ? *`, the colon also naming an NTFS alternate data stream) are
  refused by the server as well as by this CLI, and two spellings of one name
  that differ only by Unicode normalisation are treated as the collision they
  are. A version that stores
  is a version that installs. Files your ignore rules already exclude are
  never judged on their names, and a file that predates these rules can
  always still be **deleted** — that is how such a name gets fixed.
- **A `sync` never reports success over a tree it has not checked.** An
  unchanged published digest is verified against the ledger before it is
  accepted, so an edited or deleted instruction file is repaired on the next
  sync rather than surviving until someone happens to publish again.
- **Nothing outside `<dest>` decides which organization a request names.** A
  stored default context and `FABRIC_ORG` are not consulted: the project
  decides, which is what keeps an invited guest — whose own organization is
  never the project's host — able to sync at all. `--org` still binds a
  request explicitly.
- **Writes are atomic.** Each file is written to a temp name in its own
  directory and renamed into place, with the published mode applied on POSIX.
  Only `0644` and `0755` are accepted; anything else in a manifest is a
  refusal rather than a mode to apply.

### What these guarantees do not cover

Two residuals, stated rather than hidden.

**Concurrent mutation of the destination by the same user.** The guards are
`lstat`-then-act: a directory replaced by a symlink between the check and the
write, or a file edited between its hash and its unlink, is a window that
narrows but does not close. Shutting it entirely needs handle-relative
syscalls (`openat`, `renameat`) that Node does not expose. Someone editing the
tree while their own sync runs is out of scope; someone else editing it is a
question of who can write to the checkout, which is the same question the lock
raises below.

**CPU time inside the deadline.** Hook mode's 10-second bound covers waiting —
the manifest request, the download — because that is what a timer can
interrupt. Decompression and hashing are synchronous and hold the event loop,
so the promise race cannot preempt them. The bundle is bounded so that work
stays small, and Claude Code's own hook timeout is the hard stop for it.

## The lock

`<dest>/.fabric/instructions.lock` records the snapshot that was applied and
every path it wrote or verified:

```json
{
  "version": 1,
  "projectId": "project-id",
  "snapshotId": "snapshot-id",
  "snapshotVersion": 7,
  "digest": "<sha256 over the sorted path+hash lines>",
  "syncedAt": "2026-09-17T10:00:00.000Z",
  "files": { "AGENTS.md": { "sha256": "…", "mode": 33188 } }
}
```

It is rewritten last, after every write has succeeded. A lock naming files
that are not there would authorise deleting whatever is in their place on the
next run.

### The lock is a content ledger, not an authenticated one

It is a plain JSON file inside the checkout, so anything that can write there
can write it.

The threat model this reflects: the lock lives at `<dest>/.fabric/` because
that is where the card places it, and a ledger inside the tree cannot
authenticate itself against anyone who can write to the tree. It does not have
to. An attacker who can edit `.fabric/instructions.lock` can already edit —
and delete — every file the lock could name, directly and without waiting for
a sync to run. The lock does not extend their reach; it only means a sync
might perform a deletion they could have performed themselves. What would
change that is a ledger kept outside the checkout, keyed by canonical
destination and project, or one the server signs with a secret repository
content cannot reach. Neither is in scope here, and neither is necessary to
make the lock safe against the reach it actually has.

That bounds what a tampered lock can do rather than preventing it, and the
bound is worth stating plainly:

- it can cause the DELETION of a file whose *current* content hash it names
  correctly — so a file the tampering party can already read and already
  modify;
- it cannot cause a write anywhere new, because the bytes and paths that get
  written come from the server manifest;
- it cannot name `.git/**`, `.fabric/**`, `.claude/settings.local.json` or
  `.codex/hooks.json` at all;
- it cannot cause the deletion of a file whose content has changed since the
  plan was made, because the hash is rechecked immediately before the unlink;
- it cannot be partially honoured: a lock that fails schema validation stops
  the run rather than being read as far as it parses.

Treat `.fabric/instructions.lock` with the same care as any other file in the
tree.

`.fabric/`, `.claude/settings.local.json`, and `.codex/hooks.json` are local
to one machine. Add the paths you use to your own ignore rules if the
repository does not already; `init` does not edit `.gitignore`.

## What it talks to

| Layer | Where |
|---|---|
| CLI commands | `packages/cli/src/commands/instructions/index.ts` |
| Filesystem modules | `packages/cli/src/lib/instructions/` |
| The one guarded writer | `packages/cli/src/lib/instructions/safe-write.ts` |
| Push plan (local diff against the lock) | `packages/cli/src/lib/instructions/push.ts` |
| SDK resource | `packages/sdk/src/resources/instructions.ts` |
| REST routes | `packages/api/modules/v1/instructions.ts` |
| The shared server entry point behind a change | `packages/api/modules/projects/procedures/instructions/submit-change.ts` |
| MCP proposal tool | `apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts` |
| MCP lesson tool (file name and frontmatter) | `apps/web/modules/saas/mcp/lib/gateway/instruction-lessons.ts` |
| Stop hook command (`lesson-prompt`) | `packages/cli/src/lib/instructions/lesson-prompt.ts` |

Three scopes, one per authority:

| Scope | Reaches | Live permission re-checked per call |
|---|---|---|
| `instructions:read` | `GET .../instructions/published`, `POST .../published/download` — `check`, `sync`, `init` | `INSTRUCTION_READ` |
| `instructions:write` | `POST .../instructions/changes` — `push`, and the MCP tools `fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson` | `INSTRUCTION_READ` |
| `instructions:publish` | `POST .../instructions/versions` — `push --publish` | `INSTRUCTION_CREATE` |

The scope is a ceiling and never a grant: every route independently re-checks
that the key's creator still holds the permission the Coding Instructions tab
requires for the same action, so the command line is neither broader nor
narrower than the browser.

`instructions:write` reads as a write scope a read-only role should not have,
and it is deliberately one a viewer may carry. What it reaches is the proposal
path — a suggestion somebody with edit rights approves or rejects — which is
exactly what a viewer can already do in the tab on `INSTRUCTION_READ`.
Withholding it would make the key narrower than the browser for the same
person. It cannot publish: `POST .../instructions/changes` has no mode to ask
for, and the publishing route refuses it by scope.

`instructions:publish` is the opposite case, and is described that way where
it is granted: **it creates a new version of a project's coding instructions
that publishes without review once its checks pass, for callers who could
publish in the tab, and it is never issued by the Connect dialog.** A key carrying it is created by hand
in the organization's API-key settings by a member or above — a read-only role
is refused it, because `INSTRUCTION_CREATE` is not a viewer permission — and
every call re-checks that the key's creator still holds `INSTRUCTION_CREATE`
on that project at that moment. Holding only this scope means a key can
publish but cannot open a proposal, and holding only `instructions:write`
means the reverse; a key may of course carry both. No MCP tool asks for it:
`fabric_propose_project_instruction_change` and `fabric_add_instruction_lesson`
are proposal-only and an agent cannot publish.

**The publish route requires an organization key by TYPE, not only by scope
name.** A personal (`fab_*`) key is refused here even when it happens to
carry `instructions:publish`-equivalent access through a wildcard `*` scope —
a legacy key from before this scope existed satisfies the scope check on `*`
alone, so the route re-checks the key's type before it looks at anything
else and refuses a personal key outright, with a 403 that says so. An
organization (`org_*`) key is the only credential that can reach this route,
whatever scopes it carries.

The Connect dialog mints `mcp:read`, `instructions:read` and
`instructions:write` for the coding-instructions flow, and says before the key
is created that a tool holding it can suggest a change held for review. It
never mints `instructions:publish`, which is what keeps that sentence true for
every key it has ever issued.

The `GET .../instructions/published` route mirrors the MCP
`fabric_get_project_instruction_bundle` tool's delta semantics: an equal
`sinceDigest` is answered before any file row is read, and an unknown base
answers `changes: null`, meaning "take a full copy".

`POST .../instructions/changes` carries the changed files' bytes inline rather
than through signed uploads — a change set is a handful of small text files, so
a round trip per file buys nothing — and refuses a set over 50 changes or ~2 MB
of content. It computes each file's size and sha256 itself; a client-supplied
hash would only ever be a way to make the stored row disagree with the stored
object. Everything after that is the tab's own path: the same derived-snapshot
query, the same staging keys, the same validation workflow — whose publish
step this route never enables — so the secret gate reads every file including
the inherited ones. A refusal carries a
`code` the CLI branches on — `PULL_FIRST`, `REPOSITORY_SOURCE_OF_TRUTH`,
`NOTHING_PUBLISHED`, `PROPOSAL_PROPOSER_LIMIT`, `PROPOSAL_PROJECT_LIMIT`.

`POST .../instructions/versions` is the same body, the same validation and the
same refusal codes, with the publish step enabled and no review state — the
two proposal caps do not apply, because a version is not a proposal. It is a
sibling route rather than a mode on the one above so that a key's scope list
alone says which of the two it can do. Its one behavioural difference worth
knowing: a proposal is deduplicated by the content of its change set, so a
retried request comes back with the proposal the first attempt opened, while a
version is not — the SDK therefore sends `publishChange` once and never
retries it, and a response lost in transit is reported rather than repeated.

The project supplies the tenant, which is what keeps an invited project guest
working: they hold a `ProjectMember` row and no membership in the host
organization, so a membership-based context check would refuse them for a
project they can open in the app. An explicit `?org=<slug>` still binds — it
is resolved without a membership check and must equal the project's own
organization, 404 otherwise — and `?personal=1` is refused, because coding
instructions are an organization surface with no personal arm to select. That
slug is only resolved after the caller's permission on the project has been
checked, and an unknown slug and a mismatched one get the same generic 404, so
no key can use `?org=` to discover which organizations exist.

## Related

- [Coding instructions design](../superpowers/specs/2026-09-16-coding-instructions-design.md)
- [API standards](../../fabric/standards/backend/api.md)
