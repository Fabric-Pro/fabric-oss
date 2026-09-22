---
"fabric-app": patch
---

MCP clients can now update a project context's source type and AI instructions with the new `fabric_update_project_context` tool, matching the edit available in the project Context tab.

The tool needs an API key with the `projects:write` scope, and every call also re-checks that the key's owner still holds the permission to edit context sources on that project, so it never reaches further than the Context tab would for the same person. It edits those two fields only; a context's title, type and content stay out of reach, as they are in the app. `fabric_list_project_contexts` and `fabric_get_project_context` now return both fields so a caller can see what it is about to change.

Neither surface can silently overwrite the other any more. The tool requires the values the caller last read, and the Context tab's Source details dialog now sends the values it opened with; if someone else has saved in between, nothing is written, the tool returns the current values, and the dialog shows the other version and keeps your text so you can decide. Every change from either surface is recorded in the audit log with the values before and after, and the dialog shows who last edited a source's details and when.
