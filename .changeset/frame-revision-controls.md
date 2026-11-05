---
"fabric-app": patch
"@fabricorg/sdk": minor
"@fabricorg/cli": minor
---

Add reviewed-revision checks to Frame content editing and restore, with owner editing controls that preserve drafts on conflicts and confirm restoration of an exact saved entry. Expose editing, history and restore through the API, SDK, CLI and MCP, keep edit history and audit records transactional, and reject PDF exports when the reviewed page has changed.
