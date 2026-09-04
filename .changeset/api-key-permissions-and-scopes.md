---
"fabric-app": patch
---

Members can create and revoke their own API keys, and a key can no longer do anything its owner could not do in the app.

The reported bug (Fizzy #2380/#2381) was that an organization member had no way to create an API key after the personal workspace was removed, so connecting Fabric MCP to an editor or AI tool meant being promoted to admin — a far larger grant than the key itself, which only ever carries its creator's own access. Two people were promoted for exactly this.

Investigating it turned up several things nobody had reported:

- **An API key outlived its creator's membership.** Removing someone from an organization left every key they had minted fully working, at all four places an organization key resolves. Membership is now re-read on every request; the audit REST verifier reports a distinct `NOT_A_MEMBER` outcome so an operator can tell a revoked key from a departed person, mapping to the same 401 so a caller cannot.
- **No admin could revoke a key.** `delete` mounted `ORG_DELETE` — the permission for deleting the *organization*, granted to owners alone — while the settings page rendered admins a delete button. A live 403 on the one control that retires a leaked credential.
- **MCP writes asked whether the caller could *see* a project, not whether they could change it.** `fabric_update_task`, `fabric_complete_task` and `fabric_create_project` let through exactly the callers the interface refuses; a project Viewer could edit tasks through an AI tool. Three REST v1 routes had the same defect, and the shared frame service had no permission check at all — reachable from five different callers.
- **Key scopes were never enforced on MCP.** The permissions ticked at creation were stored and never read, so a key granted "MCP Read" only could call every write tool. All 42 platform tools now declare what they need. Existing keys keep working: the coarse `mcp:read` / `mcp:write` scopes act as umbrellas over their direction, and a test walks every tool with the legacy default pair to prove none refuses.
- **The Fabric Code extension minted a wildcard key nobody could revoke.** It now asks for the MCP scopes it actually uses, and personal keys have a screen that lists and revokes them again.

An organization key is also now pinned to the organization it was issued for; `fabric_switch_organization` previously let one walk into any other organization its creator belonged to, and wrote the owner's last-active organization as a side effect.

Deployment note: the frame permission fix lives in `packages/temporal`, so this needs the temporal worker deployed as well as web. No migration, no feature flag.
