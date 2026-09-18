# @fabricorg/sdk

## 0.3.0

### Minor Changes

- ed95a0b: The Fabric CLI can now keep a working copy current with a project's published coding instructions: `fabric instructions init --project <id> --tool claude-code` adds a session-start check and takes the first copy, `fabric instructions check` reports what changed, and `fabric instructions sync` applies it. A sync also repairs a working copy that drifted from the published version — an edited, deleted or chmod-ed instruction file is put back on the next run, without waiting for anyone to publish again — and `fabric instructions check --verify` reports that drift without changing anything.

## 0.2.0

### Minor Changes

- 94ab06a: Wait for a project's context to finish arriving before generating a document, instead of generating against a half-built picture of it
