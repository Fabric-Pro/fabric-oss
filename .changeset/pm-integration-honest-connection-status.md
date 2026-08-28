---
"fabric-app": patch
---

PM Integration no longer shows a healthy status when the caller's MCP connection is missing or disabled — it names the reason and links to the fix.

Fizzy #1884. The connected-config card in `ProjectManagementSettings.tsx` gated
purely on persisted `Project` columns:

```ts
const isPMConfigured = !!(
  savedMcpConfigId ||
  project.projectManagementMcpServerId ||
  project.projectManagementMcpConfigId
);
// …
{isPMConfigured && savedContainerName && !isChangingBoard && ( /* green card */ )}
```

Those columns record what was once saved. They cannot say whether the MCP config
they point at still resolves *for the person looking at the page* — and that
resolution is per-user (`resolvePMConfigForUser`), so an org project set up by a
teammate, a deleted/reconnected config, or a disabled one all left the card
green while every sync refused with
`"You have not connected your account to the project management tool. Configure
in Settings."` (`test-pm-sync.ts`). Status and reality had two different sources
of truth; the card was the optimistic one.

The authoritative signal was already in the component's hand. `getPMCapabilities`
resolves the caller's config and returns a human-readable `error` for each
unusable state (no connection / disabled / unreachable / no board selected), and
this component already runs that query — it read `detectedType` off the response
and discarded `error`, which had no reader anywhere in the app.

The card now keys on it: a resolved response carrying a non-empty `error` renders
an amber "connection needs setup" state showing the backend's own sentence, a
link to MCP Servers and the board picker, and withholds `Test Sync` (which could
only fail). Deliberately tri-state — `pmCapabilities` is `undefined` both while
the query is in flight and after it fails, so a page load never flashes a problem
it has not confirmed. Mirrors the `connection_unavailable` precedent in
`report-readiness.ts` ("honest broken, not optimistic connected").

The card is shared by every PM provider, so one change covers Fizzy, GitLab
(MCP and REST), Jira and Azure DevOps (AC5). GitLab REST is unaffected: its
capabilities branch returns `error: null`.

Two states the first cut got wrong, caught in adversarial review:

- A *settled* failure of the capabilities query is not a configuration problem,
  but it is not a passed check either. It keeps the connected card (the config
  really is bound) and adds an explicit "couldn't check the connection status"
  line, with Test Sync retained as the on-demand verification.
- The capabilities query caches for 60s and the save path invalidated only
  `projects.get`, so repairing a connection left the card showing its pre-repair
  problem with Test Sync withheld. `updateMutation.onSuccess` now invalidates the
  capabilities key too.

Pinned by `ProjectManagementSettings.unresolved-connection.test.tsx` (12 cases).
Negative controls run for each guard: reverting the render gate fails the six
bug-catching cases while the three no-regression cases stay green; breaking the
unverified note or the save-time invalidation fails exactly its own case.
