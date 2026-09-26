# @fabricorg/cli

## 0.4.0

### Minor Changes

- eed28ee: Coding instructions synced from a repository now stay current on their own: Fabric picks up a pushed change right after each push to GitHub, and otherwise normally 15 to 20 minutes after a push (longer while the poll works through a backlog or a sync is backing off after failures), publishes a new version only when the files changed, and pauses with a message in the tab if the branch is deleted or the member it publishes as can no longer publish.
- aa7dcff: `fabric instructions doctor` reports whether a machine is set up the way a project's published coding instructions expect, and the MCP gateway gains a `fabric_instruction_checks` tool that returns the same checks so an agent can self-diagnose at session start.
- f2040ef: The `fabric instructions` session hook and `init` now work in a checkout of a project's instruction repository, reporting when the configured branch has newer published instructions instead of refusing.

### Patch Changes

- ad1e1c1: A project's Living Memory can now be synced from selected folders and files of a repository connected to the project: Sync from repository picks the repository, a branch and the paths to read, checks that the branch and paths exist, and Sync now reads them again at the branch's current commit, creates, updates and removes knowledge files to match, and reports what it kept, what it skipped and why.
- c44f8e4: A coding-instructions version that only changes a file's executable bit now gets a new digest, so `sinceDigest` callers and `fabric instructions sync` pick it up instead of reporting no change. The CLI still installs versions published before this change; an older CLI release refuses a newly published version that contains an executable file until it is upgraded.
- 17dc24e: Coding Instructions now exclude `CLAUDE.local.md` at any depth from every snapshot, whether it arrives by folder upload or by repository sync, and the CLI never writes, deletes, or pushes that file, matching how `.claude/settings.local.json` is already kept out. Claude Code reads `CLAUDE.local.md` as machine-personal notes in any directory, so publishing one shared a file that was only ever meant for the machine it was written on.
- d279597: A coding agent can now record a lesson from a session — a mistake the team should not repeat — as a proposed coding-instructions file with the new MCP tool `fabric_add_instruction_lesson`, and `fabric instructions init --lessons` installs a Claude Code Stop hook that asks the developer once per session whether there is one worth keeping.
- bab1886: Suggesting a change to coding instructions on a repository-backed project now opens a pull request in the connected repository.
- 8f45162: The published-instructions API, SDK, CLI lock file, `check`/`doctor` commands and MCP gateway now report the repository, branch, root path and commit a repository-published snapshot came from.
- 2a8962e: `fabric instructions push` no longer sends a change again when one of your open proposals already carries it, listing each file it leaves out with that proposal's version and pull request, and a new `--include-proposed` flag sends them anyway.
- Updated dependencies [bab1886]
- Updated dependencies [8f45162]
- Updated dependencies [2a8962e]
  - @fabricorg/sdk@0.4.1
  - @fabricorg/sdk-mcp@0.1.9

## 0.3.7

### Patch Changes

- 08da8e3: `fabric context push` now renames a moved or renamed file in the project's Context instead of leaving a second copy behind, and a new `--prune` flag deletes the server entries of files removed from the folder, but only in the version the folder last pushed.
- Updated dependencies [08da8e3]
  - @fabricorg/sdk@0.4.0
  - @fabricorg/sdk-mcp@0.1.8

## 0.3.6

### Patch Changes

- 5bb7b31: The Fabric CLI can now sync a folder of knowledge files into a project's Context with `fabric context push <dir> --project <id>`, sending only the files that changed since the last push and never overwriting a version someone else changed on the server.
- Updated dependencies [5bb7b31]
  - @fabricorg/sdk@0.3.5
  - @fabricorg/sdk-mcp@0.1.7

## 0.3.5

### Patch Changes

- 9857fb1: A developer can now publish a coding-instructions change straight from the command line with `fabric instructions push --publish`, using an API key granted a new organization scope, `instructions:publish`, that is separate from the one the Connect dialog issues.
- Updated dependencies [9857fb1]
  - @fabricorg/sdk@0.3.4
  - @fabricorg/sdk-mcp@0.1.6

## 0.3.4

### Patch Changes

- 628963f: Fabric coding instructions can now configure a local Codex session hook alongside Claude Code for users to review and trust.

## 0.3.3

### Patch Changes

- 03c57c1: Publishing a project's coding instructions now pre-builds the download archive, and the builder fetches the snapshot's files concurrently instead of one at a time, so the first `fabric instructions sync` or `init` of a newly published version no longer times out on a large instruction tree.
- Updated dependencies [03c57c1]
  - @fabricorg/sdk@0.3.3
  - @fabricorg/sdk-mcp@0.1.5

## 0.3.2

### Patch Changes

- 46cf1d6: A developer's local coding agent can now suggest an edit to a project's coding instructions without opening the browser, through the new `fabric instructions push` command or the MCP tool `fabric_propose_project_instruction_change`.
- c7210f3: A coding-instruction proposal that is sent twice — a client retrying after a timeout, or the same push repeated — now returns the pending proposal that already exists instead of opening a duplicate that holds a second review slot, and the browser tab refuses an identical pending proposal with a message naming the version to review or cancel. Because a repeated push is now safe, the CLI and the SDK retry a transient network failure on `instructions push` again rather than failing on the first one.
- Updated dependencies [46cf1d6]
- Updated dependencies [c7210f3]
  - @fabricorg/sdk@0.3.2
  - @fabricorg/sdk-mcp@0.1.4

## 0.3.1

### Patch Changes

- 6c575f1: The CLI now saves an explicitly selected Fabric deployment with the active profile, and coding-instructions setup syncs a published snapshot before installing its session hook. The SDK now defaults requests to `https://fabric.pro` while preserving explicit and `FABRIC_BASE_URL` overrides.
- ac88b17: The CLI now reports its installed version, distinguishes authentication failures from deployment errors during sign-in, and includes installation in coding-instructions setup.
- Updated dependencies [6c575f1]
  - @fabricorg/sdk@0.3.1
  - @fabricorg/sdk-mcp@0.1.3

## 0.3.0

### Minor Changes

- ed95a0b: The Fabric CLI can now keep a working copy current with a project's published coding instructions: `fabric instructions init --project <id> --tool claude-code` adds a session-start check and takes the first copy, `fabric instructions check` reports what changed, and `fabric instructions sync` applies it. A sync also repairs a working copy that drifted from the published version — an edited, deleted or chmod-ed instruction file is put back on the next run, without waiting for anyone to publish again — and `fabric instructions check --verify` reports that drift without changing anything.

### Patch Changes

- Updated dependencies [ed95a0b]
  - @fabricorg/sdk@0.3.0
  - @fabricorg/sdk-mcp@0.1.2

## 0.2.1

### Patch Changes

- Updated dependencies [94ab06a]
  - @fabricorg/sdk@0.2.0
  - @fabricorg/sdk-mcp@0.1.1

## 0.2.0

### Minor Changes

- e9dfb8b: The command-line client retires personal context
