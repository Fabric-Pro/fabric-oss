---
"fabric-app": patch
---

Read-only agent tools no longer ask for write authority, so a permission prompt means a genuine write again.

Tool names rarely put the verb first — an MCP server namespaces its own tools,
as in `slack_search_public` — and the authority gate only tested the first
position. Every namespaced read therefore fell through to the conservative
write default, so searching messages raised a write-authority prompt. A prompt
that fires on reads teaches people to grant write access in order to read.

The namespace-tolerant read test that Read-only mode already had is now shared
by both classifiers. It runs after every explicit write prefix, so only the
conservative default can resolve to read and no tool becomes more permissive
than it was.
