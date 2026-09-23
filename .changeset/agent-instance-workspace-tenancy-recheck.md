---
"fabric-app": patch
---

Agent instance runs now search only the attached workspaces that belong to the run's own organization (or, for a personal run, the user's own personal workspaces), so an instance saved before attachments were checked against its organization can no longer read documents from another organization's workspace or from a personal one.

The recheck happens when a template stream or a deployment loads the instance, so a foreign id never reaches a workflow's input or history, and again in the shared workspace retrieval step that every workspace search goes through, so an id stored earlier or supplied by any other caller is narrowed to the caller's tenant before settings are loaded or the vector store is queried. A one-off script, `find:cross-tenant-instance-workspaces` in `@repo/database`, reports the affected instances and, with `--apply`, removes the foreign ids from their lists. The unused agentic-loop data-source tools, whose search was a stub, are removed.
