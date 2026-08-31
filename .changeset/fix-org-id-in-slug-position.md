---
"fabric-app": patch
---

Fix four in-app links that addressed an organization by id in a path segment that resolves by slug

The AI usage banner's "Manage limits" call to action, the Fabric AI workspaces link, the agent builder's "Add MCP server" link and the MCP OAuth start URL all interpolated an organization ID where the route expects a slug, so each returned a 404 for every organization member. Verified against a live server: the id form is a 404, the slug form is a 200.

Three now build the path from the slug the URL already carries. The fourth is an API procedure that knows only the id, so it uses the slug-less path that resolves the caller's organization server-side — the case the account redirect was kept for.

The usage banner also stops scoping a project-only guest to personal context, which is going away, and scopes them to their own organization instead. Its test asserted the hooks' arguments but never a member's link, which is how the broken href survived; it does now.

Follow-up in the same file: the Fabric AI hook was placed next to its use, which
is below the loading branch's early return, so hook order differed between
renders. Lifted to sit with the other hooks. Lint caught it; it was the only rule
error this branch introduced.
