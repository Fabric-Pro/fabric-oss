---
"fabric-app": patch
---

The chat entry points now bind a client-supplied organization to the caller's memberships

Two chat surfaces sit outside oRPC and take `organizationId` straight from the
request: the CopilotKit runtime (`/api/copilotkit?organizationId=…`) and the
direct-chat stream. That value selects the tenant's model, provider key, bound
prompts, and the `X-Tenant-Organization-ID` header the agents trust, so an
ordinary signed-in user could edit a query string and bill another
organization's provider key or read its prompts. The direct-chat route did
compare the value with the session's active organization, but on a mismatch it
silently swapped in the session's organization, which is wrong in the other
direction: a user with two organizations open in two tabs had one tab quietly
served the other tab's tenant.

Both routes now go through one resolver, `resolveRequestedOrganization` in
`@repo/api/lib/requested-organization`. No organization means the caller keeps
its default. An organization the caller has a tie to is honoured, whichever
tab it came from; a tie is membership or an accepted, unexpired project-guest
invitation into that organization (`hasOrganizationTie`, the same rule oRPC
input already gets through `resolveOrganizationIdForCaller`), so a project
guest keeps the document assistant. An organization with no tie is a 403,
never a substitution. The check runs before anything tenant-scoped is read.

Three smaller leaks on the direct-chat route close with it. A `conversationId`
was used as-is to look up attached workspaces and the linked project, so a
guessed id pulled another user's workspace list and project into the prompt; a
conversation the caller does not own, or one from a different tenant than the
turn is bound to (null included), is now ignored, the same way an inaccessible
project already was. The project check itself only asked "can this user open
the project", so a user in two organizations could feed organization A's
project context into a turn running on organization B's model, prompts and
memory; the project's organization must now equal the request's exactly. And
workspace ids, whether sent by the client or read off a conversation, were
handed to retrieval without an access check; they now pass through
`hasWorkspaceAccess` and the ones the caller cannot open are dropped and
logged. On the client, the assistant falls back to the active organization
when the launcher mounts it without one, so the turn is bound to the tenant
the user is working in.

Finally, the agent-conversation queries treated an omitted organization as
"legacy: match by userId only", letting the same user read, append to, archive
or delete a conversation across tenant contexts. `resolveOrganizationId()`
returns `undefined` whenever it cannot name an organization, so the omission
was widening the filter by accident. It now collapses to the personal scope,
the XOR shape the rest of that file already enforces.

The document editor's assistant is unaffected: it passes the organization from
the URL slug, which the user is a member of by construction, and its writes go
through `updateDocumentWithContext`, which was already tenant-protected.

Two more places had the same shape and close the same way. `hasWorkspaceAccess`
answers "can this user open the workspace" and ignores the organization it is
handed, so a member of two organizations could attach a workspace from one to
a chat bound to the other; the direct-chat route now also requires the
workspace's organization to equal the request's exactly before retrieval reads
it. And the chat-confirmed workflow start ignored the tab's organization and
used the session's active one, so confirming a run in one tab after switching
organizations in another looked the workflow up in the wrong tenant; the chat
now sends its organization and the route honours it only when the caller has
a tie to it, refusing with 403 otherwise and never substituting another.

