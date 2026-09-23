---
"@fabricorg/cli": patch
"@fabricorg/sdk": patch
"fabric-app": patch
---

The Fabric CLI can now sync a folder of knowledge files into a project's Context with `fabric context push <dir> --project <id>`, sending only the files that changed since the last push and never overwriting a version someone else changed on the server.

Each text file (Markdown, plain text, JSON or YAML) is pushed by its path relative to the folder. A lock file in the folder's `.fabric/` directory records what the server confirmed, so an unchanged folder makes no requests and a changed file names the version it replaces; if that version has since changed on the server, the push reports a conflict with who changed it and when, and `--force` replaces it once. Symlinks, binary files, files over 2 MiB and coding-instruction files (`CLAUDE.md`, `AGENTS.md`, `.claude/`, skills, agents, hooks, rules and scripts) are never sent, and nothing on the server is deleted. `.contextignore` and `--exclude` add gitignore-style exclusions, `--dry-run` shows the plan without sending anything, and `--hook` makes the command safe to run from a session or git hook. The push goes through a new `PUT /api/v1/projects/{projectId}/contexts/synced-files` route that needs an API key with the `projects:write` scope and re-checks, on every call, that the key's creator can still add context sources to that project. The SDK gains `contexts.upsertSyncedFile`, which reports a conflict as a `FabricContextConflictError` carrying the stored version's hash and editor, and SDK errors now keep the structured `data` of an error response.

A push that names the version of a file that was deleted on the server since is now a conflict with no current version, rather than silently recreating the file; this applies to the new route and to the `fabric_upsert_project_context` MCP tool alike. Sending the file again without a version recreates it, or answers `duplicate` instead if that content already exists elsewhere in the project; that resend is what `--force` does in the CLI.
