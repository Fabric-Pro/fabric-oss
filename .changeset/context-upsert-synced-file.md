---
"fabric-app": patch
---

MCP clients and the API can now push a text file into a project's Context by its path, with unchanged files skipped and changed files re-indexed in place instead of duplicated.

The new `fabric_upsert_project_context` MCP tool and the matching `projects.contexts.upsertSyncedFile` API procedure key each file by the project and its relative path. Pushing the same content again changes nothing; content already present in the project under another synced file is reported as a duplicate rather than stored twice. Replacing a file requires the `contentHash` of the version you last read, so two people pushing different versions of the same path get a conflict naming who changed it last instead of one silently overwriting the other. A replaced file's old search chunks are removed before it is re-indexed. Both need the permission to add context sources on the project, and every create or replace is recorded in the audit log with the path and content hashes, never the content. `fabric_list_project_contexts` and `fabric_get_project_context` now return each synced file's path and `contentHash`.
