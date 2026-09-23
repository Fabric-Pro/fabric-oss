---
"@fabricorg/cli": patch
"@fabricorg/sdk": minor
"fabric-app": patch
---

`fabric context push` now renames a moved or renamed file in the project's Context instead of leaving a second copy behind, and a new `--prune` flag deletes the server entries of files removed from the folder, but only in the version the folder last pushed.

A file moved without changing is sent as one rename that names its old path and last pushed version, so the stored source keeps its history and is re-indexed under its new path; if the old path changed on the server since, the move is a conflict and nothing is renamed. `--prune` is off by default: a file changed on the server since the last push is reported as a conflict and not deleted, `--force` deletes the reported version once, and `--dry-run` lists what would be deleted. Deleting needs the same permission to delete context sources that the Context tab checks, and each deletion is recorded in the audit log as "Synced context file deleted". This adds `DELETE /api/v1/projects/{projectId}/contexts/synced-files`, a `movedFromSourcePath` field on the synced-file upsert (also accepted by the `fabric_upsert_project_context` MCP tool), the SDK method `contexts.deleteSyncedFile`, and a `moved` result from `contexts.upsertSyncedFile`. The exported `SyncedContextFileResult.status` union gains the new member `"moved"`, so code that switches over it exhaustively needs a case for it. `contexts.deleteSyncedFile` can also answer `in-progress` (HTTP 202) when the deletion is still running on the server; calling again confirms it.
