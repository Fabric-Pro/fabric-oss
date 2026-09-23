---
"fabric-app": patch
---

The orchestrator chat stream now drops attached workspaces the caller cannot open or that belong to a different organization, matching the direct chat stream.

Workspace ids reach the orchestrator stream from the request body, or from the conversation's attachments when the body names none, and every workspace retrieval path in the workflow reads whatever lands in its input. The route checked organization membership and project access but forwarded workspace ids unchanged. It now narrows them through a shared `filterAccessibleWorkspaceIds` helper in `@repo/database` once membership is established: an id with no workspace, a workspace hosted by another organization, and a workspace the caller is in no group of are dropped and logged, and the turn continues with the rest. The body's value is also reduced to string entries first, since this route parses its body by hand.

The helper is the request-boundary counterpart of `filterWorkspaceIdsForTenant`: it applies the same exact, null-aware tenant comparison and then `hasWorkspaceAccess` to the survivors. The direct chat stream's inline copy of that rule is replaced by the same helper, so the two streams can no longer drift.
