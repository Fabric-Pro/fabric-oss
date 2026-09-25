---
"fabric-app": patch
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
---

The published-instructions API, SDK, CLI lock file, `check`/`doctor` commands and MCP gateway now report the repository, branch, root path and commit a repository-published snapshot came from.

Each published snapshot carries a `source` (`{ kind: "UPLOAD" }` or `{ kind: "REPOSITORY", ref, commitSha, current }`, where `current` says whether the snapshot still matches the project's present sync configuration), and the response and SDK type gain a top-level `repository` (provider, host, path, ref, root path and generation) for the project's current repository sync, `null` when the project is not repository-backed or has no sync row. `fabric instructions check`, `doctor` and the MCP `fabric_instruction_checks`/bundle tools surface both; the lock file (now version 3) records only the snapshot's own `source`, never the repository, since that is the project's current configuration rather than the snapshot's.
