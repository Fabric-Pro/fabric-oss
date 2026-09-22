# @fabricorg/sdk

## 0.3.4

### Patch Changes

- 9857fb1: A developer can now publish a coding-instructions change straight from the command line with `fabric instructions push --publish`, using an API key granted a new organization scope, `instructions:publish`, that is separate from the one the Connect dialog issues.

## 0.3.3

### Patch Changes

- 03c57c1: Publishing a project's coding instructions now pre-builds the download archive, and the builder fetches the snapshot's files concurrently instead of one at a time, so the first `fabric instructions sync` or `init` of a newly published version no longer times out on a large instruction tree.

## 0.3.2

### Patch Changes

- 46cf1d6: A developer's local coding agent can now suggest an edit to a project's coding instructions without opening the browser, through the new `fabric instructions push` command or the MCP tool `fabric_propose_project_instruction_change`.
- c7210f3: A coding-instruction proposal that is sent twice — a client retrying after a timeout, or the same push repeated — now returns the pending proposal that already exists instead of opening a duplicate that holds a second review slot, and the browser tab refuses an identical pending proposal with a message naming the version to review or cancel. Because a repeated push is now safe, the CLI and the SDK retry a transient network failure on `instructions push` again rather than failing on the first one.

## 0.3.1

### Patch Changes

- 6c575f1: The CLI now saves an explicitly selected Fabric deployment with the active profile, and coding-instructions setup syncs a published snapshot before installing its session hook. The SDK now defaults requests to `https://fabric.pro` while preserving explicit and `FABRIC_BASE_URL` overrides.

## 0.3.0

### Minor Changes

- ed95a0b: The Fabric CLI can now keep a working copy current with a project's published coding instructions: `fabric instructions init --project <id> --tool claude-code` adds a session-start check and takes the first copy, `fabric instructions check` reports what changed, and `fabric instructions sync` applies it. A sync also repairs a working copy that drifted from the published version — an edited, deleted or chmod-ed instruction file is put back on the next run, without waiting for anyone to publish again — and `fabric instructions check --verify` reports that drift without changing anything.

## 0.2.0

### Minor Changes

- 94ab06a: Wait for a project's context to finish arriving before generating a document, instead of generating against a half-built picture of it
