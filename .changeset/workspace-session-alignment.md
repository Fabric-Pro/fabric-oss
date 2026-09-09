---
"fabric-app": patch
---

A session now carries its workspace from the moment it is created, so the first request made with it resolves the workspace the page is showing.

Reported as a prompt deletion failing with a 403 while the confirmation blamed its
impact check. The deletion gates were right; the session was empty.

The cause was hook ordering. `seedSessionOrganization` ran in the session
create-after hook, and Better Auth drains those hooks after the request body
returns — while the signed session cookie is written inside it. The database write
landed and the cookie the API reads still carried no workspace, for up to five
minutes (sixty seconds under impersonation, which uses a shorter snapshot).
Impersonation never got seeded at all, because the hook returns early for it.

The seed now also runs on the create-before hook, where it shapes the row the
cookie is signed from. It cannot only run there: the after-hook is where
invitation reconciliation and organization creation build the membership the seed
reads, so a new signup or an invited person's first sign-in would otherwise end
with no workspace at all. Both mounts stay; the after-hook branch seeds an
impersonation session and returns, and every other session reconciles, ensures an
organization, and then seeds exactly where it did before.

Five things ship alongside it, each closing something the first change exposes or
the report made visible:

- The browser no longer sends an alignment call for a workspace the viewer holds no
  membership in. Seeding makes a project guest's session reliably name their own
  workspace, and the organization plugin's refusal path clears that pointer without
  refreshing the cookie — so the visit would have damaged a session that was correct.
- A session naming a workspace the caller has left is now refused instead of
  resolving that workspace with a null role. Resolution and session insertion are
  not atomic, and offboarding clears only the sessions that exist when it runs.
  Refusing is what closes it: downgrading such a request to a personal context makes
  the permission middleware skip the role check outright, which would turn the
  null-role denial into a pass-through.
- Every request that resolves no workspace is recorded once per session per minute,
  carrying three ids and nothing else. Three procedures refuse this condition; the
  rest return a confident empty answer, and this is the one point they all cross.
- The refusal carries a machine-readable cause, so a client can recognise it without
  matching on the message text. A source-scanning test pins that all three emitting
  sites use one shared constant.
- The prompt deletion surface names the cause on both sides of the confirmation. When
  the viewer holds a membership it also offers reloading the page as a focused safe
  action, which re-runs the alignment effect and restores the workspace; when they do
  not, it names the cause without promising a remedy that would not work for them.

The seeding closes the window for a session whose workspace resolves. It does not
close it for a session created before the seeding shipped, or for one whose
resolution refuses to name a workspace — those keep the refusal and get better
reporting rather than a fix. A brand-new signup is seeded by the after-hook, so its
cookie catches up at the first workspace-page load rather than at creation.

Verified on staging before the fix: with the session's workspace cleared, a project
list returned 200 carrying personal-context rows while the deletion-impact read
returned 403 with no machine-readable field on the body.

Tests: 448 auth, 6183 api, and the full web suite. Every load-bearing assertion was
proven non-vacuous by breaking the production code and watching it fail — the wiring
test also fails if the seed is hoisted above the impersonation guard, and the
middleware chain test fails with "expected 'allowed' to be 'denied'" if the stale
pointer is downgraded rather than refused.

The library contract this fix rests on is now pinned by a test that boots Better Auth
in-process rather than by reading its source: that a create-before hook's returned
data reaches the signed session cookie, that the after-hook then sees the merged row
and writes nothing, and that returning false or null breaks session creation.
