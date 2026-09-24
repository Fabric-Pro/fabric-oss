# Developer Guide: Syncing Knowledge Files into Project Context

How `fabric context push <dir>` keeps a local folder of knowledge files and a project's Context in step, what it sends, what it refuses to send, how it handles moved and deleted files, and what the lock beside the folder records.

- **Audience**: engineers working on `@fabricorg/cli`, `@fabricorg/sdk` or the v1 REST surface; developers who keep a project's reference docs in a folder
- **Owner**: Projects / Platform team

## What this is for

A project's **Context** tab holds the knowledge sources Fabric's AI features
read from. The docs that belong there usually already exist as files: an
architecture note, a glossary, an API description. `fabric context push`
sends every text file in one folder into the project's Context, keyed by the
file's path relative to that folder, and on later runs sends only what
changed.

This is project Context. It is not `fabric ctx`, which switches the CLI's
default organization and never talks to a project.

Install and authenticate as for the coding-instructions commands (see
[Coding Instructions on the Command Line](coding-instructions-cli.md)):

```bash
npm install -g @fabricorg/cli
fabric auth login --key <api-key> --base-url https://example.com
```

## The command

```bash
fabric context push <dir> --project <id> [--org <slug>] [--force] [--prune] \
  [--dry-run] [--exclude <pattern>]... [--hook] [--format json]
```

| Flag | What it does |
|---|---|
| `<dir>` | The folder to push. Required: the command never defaults to the working directory, because pushing a repository root by accident would send every text file in it. |
| `--project <id>` | The project whose Context receives the files. |
| `--org <slug>` | Binds the request to an organization explicitly. The project already decides which organization it is in; a slug that is not the project's own is a 404. |
| `--force` | On a conflict, replace the server's version with this folder's, once. With `--prune`, also deletes a file that changed on the server, once. See below. |
| `--prune` | Deletes the server entry of every file removed locally, but only in the version this folder last pushed. Off by default. See [Deleting with `--prune`](#deleting-with---prune). |
| `--dry-run` | Prints what would be sent, moved and (with `--prune`) deleted. Sends nothing and writes no lock. |
| `--exclude <pattern>` | Leaves out paths matching a gitignore pattern. Repeatable. |
| `--hook` | Hook mode: one absolute 10-second deadline, no retries, and every failure becomes one line on stderr with exit code 0. |
| `--format json` | Prints the plan and every result as one JSON object. File contents are never included. |

Files are sent one request at a time: moves first, then the other files in
sorted path order, then (with `--prune`) the deletions. The report groups
them by outcome with a count on each group, one line per file for every
outcome except `unchanged`, which is only counted:

| Outcome | What happened |
|---|---|
| created | a new path; stored and queued for indexing |
| updated | the stored version was the one this folder last pushed, and it was replaced |
| unchanged | the server already holds exactly this content, or the lock shows the file has not changed and nothing was sent |
| moved `<old> -> <new>` | a file moved or renamed without changing; the stored source was renamed in place |
| not moved | a move the server did not apply, saying why and what was stored at the new path instead (see [Moves](#moves)) |
| duplicate of `<path>` | a new path whose content is already stored under `<path>`; nothing was stored |
| conflict | the server holds a version this folder did not name, or deleted the version it named; nothing was written, moved or deleted |
| changed during the run | the file changed after it was planned and before it was sent; it was not sent, and the next push sends it |
| failed | that request failed; the other files were still sent |
| deleted | `--prune` only: removed locally, and its server entry was deleted |
| already gone | `--prune` only: removed locally, and the server had no entry at that path any more |
| deletion still running | `--prune` only, and only from an older server: its deletion had not finished when it answered; the lock entry is kept |
| removed | removed locally; the server entry is kept (without `--prune`) |
| skipped | not something this command sends, with the reason |

Exit code 0 when every file sent was stored or confirmed and every deletion
asked for happened. A remaining conflict, including a file `--prune` did not
delete because it changed on the server, exits 1. A failed request exits with
the code its error maps to (a 400 is 7). A refusal that would repeat for every
file — an invalid key, a missing scope, a missing permission (including the
delete permission `--prune` needs), an unknown project, the rate limit, an
unreachable server — stops the run at once, after recording what had already
landed.

## What gets sent

Every regular file under `<dir>` that the ignore rules leave in and that
passes these checks, which mirror the server's own so nothing is sent only to
be refused:

| Skip reason | Meaning |
|---|---|
| `unsupported-type` | not `.md`, `.markdown`, `.txt`, `.json`, `.yaml` or `.yml` (compared case-insensitively), or not a regular file |
| `binary` | not valid UTF-8, or contains a NUL character |
| `empty` | no bytes, or only whitespace |
| `too-large` | more than 2 MiB |
| `invalid-path` | a path the server would refuse, with the server's reason word (`control-character`, `too-long`, …), two files the server would store under one path, or two files whose paths differ only in case (`case-only collision`), which a case-insensitive filesystem cannot hold apart |
| `symlink` | a symbolic link; never followed and never read |

The stored path is the server's spelling: Unicode NFC, `/` separators. The
file's text is sent exactly as it is on disk, byte-order mark included, so the
hash the server stores is the hash of the file.

### The ignore rules

These are always left out and cannot be re-included:

- `.git/`, `.fabric/` (where the lock lives), `node_modules/`;
- coding-instruction files and folders: `CLAUDE.md`, `AGENTS.md`,
  `GEMINI.md`, `.claude/`, `.cursor/`, `.codex/`, and any directory named
  `skills`, `agents`, `hooks`, `rules` or `scripts` at any depth;
- the ignore file itself.

Add your own with gitignore syntax in `<dir>/.contextignore`, or with
`--exclude`. Both are applied after the defaults; a `!` pattern can re-include
something your own rules left out, never something the defaults did. Matching
is case-insensitive.

Point the command at a knowledge folder, not a repository root: every text
file that is not excluded is sent, including a `.json` file that holds
credentials.

## The lock

`<dir>/.fabric/context.lock` records what the server confirmed at the last
push:

```json
{
  "version": 1,
  "projectId": "project-id",
  "pushedAt": "2026-09-22T10:00:00.000Z",
  "files": {
    "docs/architecture.md": { "sha256": "…", "contextId": "…" },
    "notes/copy.md": { "sha256": "…", "state": "duplicate" }
  }
}
```

- A file whose sha256 matches its lock entry is not sent at all, so a second
  push of an unchanged folder makes no requests.
- A changed file is sent with its lock entry's hash as the version it replaces.
- A file the lock does not name is sent with no version, so it can create a
  new source or confirm an identical one but never overwrite anything.
- A duplicate is recorded with `"state": "duplicate"` and no `contextId`,
  because the server stores its content under another path and has no source
  for this one. It is not sent again while it is unchanged; once it changes it
  is sent with no version, like a new file. If the file is deleted, its entry
  is dropped, since there is no server entry to keep.
- A file moved or renamed without changing, including one renamed only in
  case, is sent as a move (see [Moves](#moves)). A file that was renamed and
  edited in the same step is reported as removed under its old path and sent
  as a new file under its new one. Whether a path is still there is decided
  from the names in the folder listing, so a case-insensitive filesystem
  cannot make the old spelling look present.
- Each file is read again just before it is sent. If it no longer matches
  what the plan hashed, it is reported as changed during the run and not
  sent, and its lock entry is left as it was.
- The lock is written after the last request. It records `created`,
  `updated` and `unchanged` with their source, and duplicates as above. A
  `moved` answer moves the entry to the new path. A `--prune` deletion that
  happened, or that found the path already gone, drops the entry. A
  conflict, a file changed during the run, or a failure leaves its entry as
  it was. `--dry-run` never writes it.
- A run that ends with failures or conflicts still writes the lock before it
  exits non-zero. So does a run stopped early by a refusal that would repeat
  for every file. In both cases the lock gains every result the server
  confirmed, and files that failed or were never sent keep their previous
  entries. A run killed before its last request, or stopped by the `--hook`
  deadline, writes nothing and leaves the previous lock. The next run then
  completes the job: content the server already holds is answered
  `unchanged` and recorded.
- A lock written for another project is refused with exit code 7, naming both
  project ids. A damaged lock is refused too, rather than treated as a first
  push.

The lock is a plain file in the folder and is not authenticated. It decides
what is skipped, which version a push states, which moves are sent, and, with
`--prune`, which version a deletion states. It never causes a read outside
the folder. Every version it states is checked by the server before anything
is written, moved or deleted, and nothing is deleted without `--prune`.

## Conflicts and `--force`

A synced file is replaced only when the push names the version it replaces.
If someone changed the file on the server since your last push, or if the
path already holds different content on a first push, the answer is a
conflict and nothing is written:

```text
conflict (1)
  docs/architecture.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push
```

Compare the two in the project's Context tab. To keep this folder's version
anyway, run again with `--force`: the file is sent once more, naming the
version the conflict reported. If it changed yet again in between, that is
reported as a conflict too, and there is no third attempt. A stored version
without a content hash cannot be named, so `--force` cannot replace it.

If the file was deleted on the server since your last push, the push is
also a conflict (`deleted on the server since your last push`) and nothing
is written. The server does not recreate a source someone deleted. Its lock
entry stays, and `--force` sends the file once more with no version, which
recreates it, or answers `duplicate` instead if that content already exists
elsewhere in the project.

A path a Living Memory repository sync owns is not a conflict: a create, a
replace, either side of a move, or a `--prune` delete all answer the same
way, and the file is reported once under `skipped`:

```text
skipped (1)
  docs/architecture.md is synced from example-org/handbook @ main; change it in the repository and run Sync now.
```

Nothing was written, the lock entry for that path is left exactly as it
was, and `--force` never retries it — there is no version to replace; the
file changes in the connected repository, and "Sync now" on the project's
Context tab brings the change in.

## Moves

A lock path that is gone from the folder and a new file with exactly the
same content are a move. Pairs are made one to one and deterministically:
the gone paths in sorted order, each taking the first unpaired new file (in
sorted order) with its hash. Paths left unpaired stay removed or new.

A move is one request: the file is pushed at its new path, naming the old
path as `movedFromSourcePath` and the old path's lock hash as the version. If
the server still holds exactly that version at the old path and nothing is
stored at the new one, it renames the stored source in place. The source keeps
its history and its place in the Context tab, is re-indexed under its new
path, and the lock entry moves:

```text
moved (1)
  notes/glossary.md -> docs/glossary.md
```

The server renames only a source that holds the version you named and that
nothing already occupies the new path of. Otherwise it answers as for an
ordinary push of the new path and says why it did not rename:

| Line under `not moved` | What happened |
|---|---|
| `<old>: gone on the server; <new> pushed as created` | nothing was stored at the old path any more, so the new path was stored as a new file; the old lock entry is dropped |
| `<old>: not moved, <new> is already on the server; <new> pushed as unchanged; <old> kept` | the new path already had its own source; that answer is recorded, and the old path stays on the server and in the lock, and later runs report it as removed (or, with `--prune`, this run deletes it) |
| `<old>: not moved, the server's version of it differs from <new>; …; <old> kept` | only after `--force`: the old path holds someone else's edit, so this folder's version was stored at the new path and the edited source kept |

If the old path changed on the server since your last push, the move is a
conflict. Nothing is written or renamed, and both lock entries stay as they
were:

```text
conflict (1)
  notes/glossary.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push; not moved to docs/glossary.md
```

If the new path already holds different content, that is a conflict about
the new path, as on a first push, and `--force` replaces that version while
the old path stays. If the old path is gone from the server as well, the
conflict line ends `<old> gone on the server` and the old lock entry is
dropped, so the next run sends the new path as an ordinary file instead of
planning the same move again.

`--force` on a conflict about the old path sends the move once more, naming
the version the conflict reported. A move never replaces content, so if that
version differs from yours, your version is stored at the new path and the
edited source stays under the old path. If the old source was deleted in the meantime, `--force`
pushes the new path as an ordinary new file and drops the old entry. A move
whose new file changes before it is sent is reported as changed during the
run: nothing is sent for it, and both lock entries stay.

Moves need a server that supports them. A server from before them ignores
the old path and answers the new one as if the version it named had been
deleted. The CLI recognizes that answer and reports
`<old> -> <new>: the server does not support moves yet; <old> kept, <new> not pushed`.
It sends nothing more for that move, even with `--force`, keeps the old
path's lock entry and does not delete it with `--prune`, and exits 1. The
move is sent again on the next push.

## Deleting with `--prune`

Without `--prune`, a file deleted locally is reported as *removed locally;
server entry kept*, and its lock entry stays. Deleting server entries is
opt-in, per run.

With `--prune`, after every move and push, each removed path's server entry
is deleted, but only in the version its lock entry names. This is a
compare-and-set, like a replace. If someone changed the file on the server
since your last push, it is not deleted and the run exits 1:

```text
conflict (1)
  docs/old.md: changed on the server by Example Editor at 2026-09-22T09:30:00.000Z since your last push; not deleted
```

`--force` deletes it anyway, once, naming the version the conflict reported.
If it changed yet again in between, that is reported too, and there is no
third attempt.

- A path the server no longer has is reported as *already gone on the
  server*, and its lock entry is dropped.
- Every deletion answer is final. An older server could answer that a
  deletion had not finished within about 45 seconds; the CLI still reports
  that as *deletion still running on the server; run again to confirm*: the
  lock entry is kept, it counts as not deleted, the run exits 1, and it is
  never retried with `--force`.
- Only sources pushed by path are addressable. A file, link or note added
  in the Context tab has no path and is never deleted.
- The old path of a move the server did not apply because the new path was
  already there is deleted in the same run.
- The deletions come last, so a run stopped early by a refusal deletes
  nothing it had not reached.
- The source is deleted, its search-index entries are queued for removal,
  and the deletion is recorded in the organization's audit log as *Synced
  context file deleted*, all in one step on the server: either all of it
  happens or none of it does. The server then removes the index entries
  straight away when it can, and a background sweep removes whatever it
  could not; a search never returns a deleted source's text in between.
- The key's creator needs the permission to delete context sources in that
  project, the same one the Context tab checks. Without it, the first
  deletion answers `No permission to delete context sources from this
  project`, exits 5, and stops the run after recording what had already
  landed.
- `--dry-run --prune` lists the paths it would delete under `would delete`.

## What it will not do

- **Delete anything you did not ask it to.** Without `--prune`, nothing is
  deleted on the server. With it, only a path the lock names is deleted, and
  only in the version this folder last pushed (or, with `--force`, the
  version a conflict reported).
- **Send binaries.** Images, PDFs and other non-text files are skipped.
- **Send coding instructions.** `CLAUDE.md`, `AGENTS.md`, `.claude/` and the
  rest are excluded whatever your ignore rules say. They reach a project
  through `fabric instructions push`, which opens a proposal someone reviews.
- **Follow symlinks.** Every entry is checked with `lstat`, and every read
  goes through the same guarded reader `fabric instructions` uses, which
  refuses a symlinked component anywhere on the path.

## The key it needs

`projects:write`, the same scope the MCP tool `fabric_upsert_project_context`
requires. The read-only key that **Connect your agent** mints cannot push,
and a member with the read-only viewer role cannot put this scope on an
organization key. `--prune` needs no other scope.

The scope is a ceiling, not a grant. On every call the server also checks that
the key's creator can still add context sources to that project in the app
(or, for a `--prune` deletion, delete them), with the same permission and
project-visibility checks the Context tab uses.
A wildcard `*` key is checked the same way. A missing scope answers
`Missing required scope: projects:write` and exits 5. A missing permission
answers a different sentence and also exits 5.

## Running it from a hook

`--hook` never fails and never runs past its deadline. A hook can therefore
push on every session end without being able to block one. A Claude Code
`Stop` hook in `.claude/settings.local.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "fabric context push docs/knowledge --project <id> --hook",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
```

The same command works in a git `post-commit` hook. The hook command names a
project and a folder, never a key: the CLI reads its credential from
`FABRIC_API_KEY` or its own config file.

`--prune` works with `--hook` too, because it is still explicit. If anything
was not stored or not deleted, the one line on stderr says how many files
were deleted, already gone and not deleted, for example
`fabric: context push failed: --prune: 1 deleted, 0 already gone, 1 not deleted. …`.
A file the run meant to delete but never reached, because a refusal stopped
it first, counts as not deleted.
A prune that outlasts the hook's 10-second deadline is skipped for that run:
the line says the push gave up, the lock is left as it was, and the next run
reconciles it (a deletion the server finished in the meantime is answered
*already gone*).

## What it talks to

| Layer | Where |
|---|---|
| CLI command | `packages/cli/src/commands/context/index.ts` |
| Walk, ignore rules, classification, plan, lock, report | `packages/cli/src/lib/context-sync/` |
| Guarded reads and writes | `packages/cli/src/lib/instructions/safe-write.ts` |
| SDK resource | `packages/sdk/src/resources/contexts.ts` (`client.contexts.upsertSyncedFile`, `client.contexts.deleteSyncedFile`) |
| REST routes | `PUT` and `DELETE /api/v1/projects/:projectId/contexts/synced-files` in `packages/api/modules/v1/contexts.ts` |
| Shared server logic | `packages/api/modules/projects/lib/upsert-synced-context.ts`, `packages/api/modules/projects/lib/delete-synced-context.ts` |
| Compare-and-set queries | `upsertContextBySourcePath` and the delete's `deleteSyncedContextRow`, in `packages/database/prisma/queries/projects/contexts.ts` |
| Index cleanup after a delete | `createPendingVectorCleanup` in `packages/database/prisma/queries/projects/pending-vector-cleanup.ts`, drained by the request and by the scheduled sweep through `drainPendingVectorCleanup` in `packages/temporal/src/lib/delete-channel-context.ts` |
| Path rules (server) | `packages/database/prisma/queries/projects/context-source-path.ts` |

The REST route is the key-backed twin of the session-only oRPC procedure
`projects.contexts.upsertSyncedFile` and of the MCP tool
`fabric_upsert_project_context`. All three call the same function for
validation, the write, indexing and the audit row, so none can answer
differently for the same file. The `DELETE` route and the oRPC procedure
`projects.contexts.deleteSyncedFile` share one function the same way. The project decides which organization the file
is written under. This keeps an invited project guest working, and an
organization key cannot reach another organization's project.

## Related

- [Coding Instructions on the Command Line](coding-instructions-cli.md)
- [API standards](../../fabric/standards/backend/api.md)
