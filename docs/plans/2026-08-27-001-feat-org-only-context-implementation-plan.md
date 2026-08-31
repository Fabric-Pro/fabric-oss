---
title: Org-Only Context Implementation - Plan
type: feat
date: 2026-08-27
topic: org-only-context-implementation
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Org-Only Context Implementation - Plan

## Goal Capsule

- **Objective:** Ship the work the personal-context surface map identified as ready to build — the two settings dispositions (PO-2, PO-10) are engineering recommendations endorsed by the ticket owner and still pending product sign-off, not settled rulings — organization-only context resolution for the protocol servers; organization-level homes for the two settings surfaces that have none; and organization-rooted routes for the two live features that have none (automation templates, the task-planner agent), alongside removal of the stale personal-only redirect stub. Everything here is parity and correctness work; no data is migrated and none is dropped by this plan.
- **Product authority:** Fizzy #1875 / Fabric Feature 552. FR3b requires every personal-level setting and feature to reach parity at organization level *regardless of whether the underlying data is dropped*; FR4 requires the protocol server to resolve organization-only with last-active-organization as the multi-organization default.
- **Evidence base:** `docs/personal-context-surface-map.md`. Every claim in this plan is recorded there with its derivation; re-run those before trusting a count.
- **What this plan is not:** it does not remove personal context, drop any data, or touch the signup flow. Those are sequenced after it — see Sequenced after this plan.
- **Stop conditions.** These gate **merge**, not build. The work is written and reviewed first so the decisions below are taken against something concrete rather than against a description; none of them may be resolved by the branch landing.
  - Stop if the shared resolver's typed absences cannot be told apart by its callers. R2c only helps if "nowhere to go" and "has not said where" reach the entry points as different answers; collapsed into one, the second becomes a lockout and the first becomes a lie.
  - Stop if making a settings route reachable from organization context turns out to require moving data; the surface map says it does not, and if that is wrong the premise of this plan is wrong.
  - Stop before U2 merges until the population of users holding a personal API key with no organization membership has been counted and a product owner has accepted refusing them. Every population in the evidence base is recorded as not instrumented, so "small" is an assumption today, not a finding — and this plan builds no runtime fallback for them, so the refusal is what ships.
  - Stop before U5 and U6 merge until PO-2 and PO-10 read `approved` in the surface map. Building a route tree against a disposition that is later overturned costs more than waiting for it.
  - Stop before U2 merges until a product owner has ruled on what happens to personal API keys issued before this change. A key created to reach one person's own rows will, afterwards, reach everything its owner may reach in an organization — so the consequence of that key leaking is not the consequence its holder consented to. Binding each key to an organization, revoking the existing ones, or accepting the widened scope in writing are all defensible; proceeding without choosing is not.

---

## Product Contract

### Summary

Three surfaces resolve tenancy to personal context where they should resolve to an organization, and two settings pages exist only in the personal route tree. This plan fixes the resolution and gives the two pages an organization-reachable home. One piece of it — the membership check on a caller-supplied organization — is a live isolation defect rather than parity work, so it is carved out as U0 and ships first and alone; the rest follows. Both are prerequisites for removing personal context later, and both are worth shipping on their own: the resolution defects are open P1 bugs today, and one of the settings gaps is already broken for organization users.

### Problem Frame

Two protocol entry points decide, per request, which tenant a non-browser caller is operating in. One hardcodes a null organization for personal API keys and never consults membership or the user's last-active organization, even where one exists. The other takes the tenant from caller-supplied request data on one path without checking membership at all — a cross-tenant isolation defect that exists today, independent of this initiative.

Separately, account security settings and notification settings live only in the personal route tree. Their data is already account-global — the security models carry no organization column at all, and every notification-preference read and write normalizes to a single per-user row — so nothing needs moving. What is missing is a route and a link. That gap is already live: from organization context there is currently no link to account settings from either the sidebar or the user menu, so the only way in is the context switcher, which later work removes.

### Key Decisions

**The organization resolver is written once and shared.** Two call sites in this plan need the same answer to the same question — the gateway's key path and the hosted server's no-organization path — and two more are sequenced after it, the versioned REST flag and the command-line selector. The codebase has no helper for it today: `User.lastActiveOrganizationId` exists and is populated, but only the post-login web redirect reads it. Writing the rule once is the point; writing it per call site is how the three existing tenancy resolvers already drifted, one of which carries a "keep this in sync" instruction nothing enforces.

**Membership is verified, never trusted from the request.** The hosted server's header path is fixed by checking membership, not by removing the header. A caller may legitimately want to name an organization; what it may not do is name one it does not belong to.

**The two settings pages get an account section inside organization settings.** FR5 requires personal routes to be *redirected to the organization workspace* rather than deleted. Their data is account-global, so this is a routing and navigation change.

**The permission bypass is not in this plan.** Removing the `!context.tenantContext` guard condition would make procedures built on the plain protected builder start failing — 52 files' worth. Each needs either a move to the tenant-aware builder or a documented exemption. It also does not become a defect until personal context is gone. It belongs with the elimination, not ahead of it.

### Requirements

**Protocol context resolution**

- R1. A single shared helper resolves a user's organization: one membership resolves to it; several resolve to the last active organization when that is still a valid membership.
- R2. The helper states what it does for a user with no membership, and that behaviour is deliberate rather than incidental.
- R2b. The helper resolves automatically only where the answer is unambiguous — one membership, or a last-active organization the caller still belongs to. Every other case returns an absence. A tenant a caller never named is not made authorised by being chosen deterministically.
- R2c. The helper's absence is typed, and the two absences are different: a caller with no membership has nowhere to go, while a caller with several has somewhere to go but has not said where. The second is answerable by the caller and must not be handled as the first.
- R2d. Both protocol entry points let a caller name one of their own organizations explicitly, and verify membership before honouring it. **Three units share this requirement and it is done only when all three land** — U1 supplies the verifier, U0 the hosted selector, U2 the gateway one. Each names the half it owns, because a requirement one unit can mark complete alone is a requirement that ships half-built. Fail-closed resolution is only safe if naming a tenant is possible — otherwise a multi-organization caller whose last-active is unset is locked out with no way back in, since reaching the switching tool itself requires a session.
- R3. The gateway's personal-key path resolves through the helper instead of returning a null organization.
- R4. The hosted server verifies membership before honouring a caller-supplied organization, and refuses otherwise.
- R4b. Where no organization is supplied, the hosted server resolves through the helper instead of defaulting to none. Split from R4 because the membership check is a live defect that ships alone and the fallback is parity work that waits on the resolver.
- R5. The organization-switching tool stops accepting a null organization as a way back to personal context.
- R6. No protocol path returns a null organization for a caller authenticating with an API key. The browser-session branch of each route is explicitly out of scope while personal context still exists — a session can still legitimately sit in it, and retargeting that belongs with the removal work, not here.
- R6b. No tool description, parameter description or runtime message tells a caller to switch into personal context. A handler that refuses an affordance its own text still advertises leaves the retired behaviour alive in the model's head and produces a retry loop.
- R6c. A cached protocol session does not outlive the tenancy decision that created it. Resolving an organization per request is worthless if a session established under a previous answer is reused unchanged for a day afterwards.

**Settings parity**

- R7. Account security settings are reachable from organization context, with a menu entry.
- R8. Notification settings are reachable from organization context, with a menu entry.
- R9. Neither change moves data — both surfaces are already account-global and stay so.
- R10. The personal routes for both continue to work unchanged. No redirect is introduced here: FR5's redirect needs an organization to redirect *into*, which a member-less user does not have, and two live consumers already link the personal security path from organization context — the organization layout's two-factor enforcement redirect and the setup banner. The redirect ships with the removal of personal routes, not with this plan.

**Non-settings parity**

- R11. Automation templates and the task-planner agent gain organization-rooted routes.
- R12. The stale redirect stub with no organization counterpart is removed.
- R13. The agent-register route gains an organization-rooted counterpart. It is already broken from organization context rather than merely unpaired — the link helper prefixes the slug and the result falls through to the dynamic agent route with the literal segment as an identifier — so this is a repair that the route work happens to be the cheapest moment for.

### Acceptance Examples

- AE1. **Covers R3, R6.** Given a caller authenticating with a personal API key who belongs to exactly one organization, when the gateway resolves their context, then it resolves to that organization rather than to none.
- AE2. **Covers R1.** Given a caller who belongs to several organizations, when their context is resolved, then it is their last active organization, provided they are still a member of it.
- AE3. **Covers R4.** Given a caller who supplies an organization they do not belong to, when the hosted server resolves context, then the request is refused rather than honoured.
- AE4. **Covers R5.** Given a caller invoking the organization-switching tool with a null organization, when the tool runs, then it refuses rather than returning them to personal context.
- AE5. **Covers R7, R8, R10.** Given a user in organization context, when they open settings, then account security and notifications are both present and reachable, and a bookmark to either personal route still renders the same page it does today.
- AE6. **Covers R6b.** Given a caller whose project lives in personal context, when a tool refuses the request, then the refusal does not instruct them to switch into personal context.
- AE7. **Covers the reachability boundary.** Given a caller authenticating with a personal API key whose only projects are personal-context, when they list projects after this change, then they see the organization's projects and not their personal ones — the rows still exist and are still reachable in the browser.

### Scope Boundaries

- No data is migrated, archived, or dropped.
- Personal context is not removed. Its routes, its switcher entry, and its resolution paths outside the protocol servers stay as they are.
- The signup flow is untouched — auto-creating an organization on signup is blocked on a naming convention the ticket has not reconciled.
- The residual permission bypass is out, for the reasons in Key Decisions.
- **Personal-context content becomes unreachable over the protocol while it still exists.** No row is migrated or dropped, but U2 moves the key's tenant and U4 removes the way back, so a protocol caller stops seeing personal projects, documents and chats that the browser still shows. This is an access change shipped ahead of the drop that would justify it, and it is recorded here as a deliberate consequence rather than left implicit in two separate units. Nobody is currently assigned to tell affected users — the surface map lists that owner as outstanding.
- **A personal API key's reach grows without being re-issued.** Once a `fab_` key resolves into an organization, the largest tenancy class filters the organization alone with no per-user predicate, so the key reaches everything its owner may reach in that organization rather than only their own rows. This is not cross-user escalation — the owner already holds that access in the browser — but it does widen the blast radius of a credential issued under narrower expectations — a leaked key now exposes an organization rather than one person. Which remedy applies is a product decision, and it is a stop condition on U2 rather than an open question, because U2 is what changes the reach.
- **The fabric.pro / BYOK track is a separate lane and is not in this plan.** FR9 (auto-organization on sign-up from the marketing site), FR10 (removing the trial-credit banner and the card-collection step) and FR11 (the hosted-versus-open-source choice on the home page), together with UC4, are neither covered here nor recorded in the surface map. FR10 and FR11 are blocked on nothing and can be picked up independently; FR9 shares this plan's naming blocker. They are named here so the gap is visible rather than silent.

#### Sequenced after this plan

- Auto-organization on signup, once the naming convention and onboarding copy are settled.
- Removal of personal routes, the context switcher, and the interface strings that name personal context.
- The drop job, which must reach object storage and the vector store, and must cancel at the payment provider before deleting a purchase row.
- The residual permission bypass, shipping with the elimination rather than before it.
- The versioned REST query flag and the command-line context selector, which the surface map puts under the same FR4 rule as the protocol servers. Both must consume U1's helper rather than writing the last-active rule a fourth time — that re-derivation is exactly the drift the shared-resolver decision exists to stop.
- The fabric.pro / BYOK lane — FR9, FR10, FR11 and UC4 — see Scope Boundaries.
- A superseding architecture decision record.

---

## Implementation Units

### U0. Hosted server verifies a caller-supplied organization

**Ships first, on its own, ahead of every other unit in this plan.** This closes a
cross-tenant isolation defect that is live today and would need fixing if the epic were
cancelled. The evidence base is explicit that it belongs on its own remediation timeline
rather than inheriting the epic's schedule, and the surface map's own publication is gated
on it. It carries no dependency on U1: refusing an organization the caller does not belong
to needs a membership lookup, not a default-organization resolver.

- **Goal:** A caller-supplied organization is checked before it is honoured.
- **Requirements:** R4, R6c, R2d (the shared membership verifier and the hosted selector)
- **Dependencies:** none
- **Ships as:** the first commit of this plan's branch. The evidence base recommends a separate
  branch and pull request so the repair is not held by the epic's schedule, and that was raised
  and overruled at implementation time in favour of a single branch. The recommendation is kept
  here rather than deleted, because it is the reason this unit is still first, still
  dependency-free, and still reviewed on its own commit — if the parity work is blocked at merge
  by a stop condition, this unit is the part that can be split back out.
- **Files:**
  - create `packages/database/prisma/queries/verify-organization-membership.ts` — the shared
    verifier, owned here because this unit ships first and alone and so cannot depend on U1
  - modify `packages/database/prisma/queries/index.ts` — the barrel is hand-written
  - modify `apps/web/app/mcp/route.ts`
  - modify or create its test file
- **Approach:** Where the tenant is currently taken from caller-supplied request data, verify
  the caller is a member before honouring it and refuse otherwise. The in-protocol
  organization-switching handler already does exactly this check, inline, as a single
  membership lookup. Extract that shape into the shared verifier and have the handler call it
  too, so there is one implementation rather than a second that has to be kept in agreement.
  U2 calls the same verifier for the gateway's selector.

  Leave the no-organization-supplied branch exactly as it behaves today; retargeting it is U3,
  which waits on the resolver. Splitting the unit this way is what keeps the security fix free
  of the resolver's design, tie-break and review.

  **Refuse distinguishably — not by returning nothing.** An absent authentication result already means "unauthenticated public session" on this route, and the request path falls back to the stored session when the fresh result is absent. So a refusal expressed as absence is silently swallowed and the caller keeps the organization their session was created with. The refusal needs its own outcome, and the session path must treat it as fatal rather than as a reason to reuse what it already had.

  That fallback is a second, smaller defect in the same function, and it is what lets an existing session outlive this fix. Close it here: a non-public stored session requires a successful fresh authentication that agrees on both user and organization, on the request paths that read a session as well as the one that creates it. Without this, U0 fixes new sessions and leaves live ones alone for up to the session lifetime.

  Log the refusal through whatever security-event path the codebase already has. A silent rejection leaves no trail for sizing abuse of a defect that has been reachable in production, which is the one question incident response will ask.

  Keep the specifics out of the branch name, the commit subject and the pull-request body.
  The repository is public and the surface map deliberately records this defect without its
  mechanics; describe the change as adding a membership check, not as closing a hole.
- **Test scenarios:**
  - A caller supplying an organization they belong to resolves to it.
  - A caller supplying an organization they do **not** belong to is refused. This is the
    isolation defect; it needs a test that would fail today. Nothing covers this path now —
    the header appears in no test in the repository.
  - A caller supplying nothing behaves exactly as it does today.
  - The unauthenticated public session behaves as before, and is still distinguishable from a refusal.
  - An existing session whose caller is now refused stops working, rather than continuing on the organization it was created with — asserted on the request paths that read a session, not only the one that creates it.
- **Verification:** the membership check and the in-protocol switch handler apply the same rule;
  a test proves the cross-tenant case is refused and fails without the fix.

### U1. Shared organization resolver

- **Goal:** One helper that answers "which organization is this user operating in", used by every caller that needs it. The companion question — "may this user operate in the organization they named" — is answered by the verifier U0 creates; this unit consumes it rather than duplicating it.
- **Requirements:** R1, R2, R2b, R2c
- **Dependencies:** none
- **Files:**
  - create `packages/database/prisma/queries/resolve-user-organization.ts`
  - create its test file. This package accepts co-located tests, but the overwhelming
    majority live in `packages/database/__tests__/` — follow that
  - modify `packages/database/prisma/queries/index.ts` — the barrel is hand-written, so a new query file is invisible to `@repo/database` consumers until it is re-exported there
- **Approach:** Take a user identifier, return an organization identifier or an explicit absence. Read memberships and the user's last-active organization in one pass. One membership resolves to it. Several resolve to the last active one when it is still among them. **When it is stale or unset, return an absence — do not pick one.** A deterministic tie-break makes the answer stable, but stability is not authorisation: for a credential, silently selecting a tenant the caller never named is the wrong failure mode, and the tenant it lands in can hold data shared with other members. FR4 mandates last-active as the multi-organization default; it says nothing about what to do when last-active does not resolve, and fail-closed is the safe reading of that silence. Say so in the doc-comment.

  The no-membership case is the one to get right. It is reachable today: nothing creates an organization at signup, so a fresh account has none. Return an explicit absence and let each caller decide; do not invent an organization.
- **Patterns to follow:** `apps/web/modules/saas/start/lib/last-active-workspace-redirect.ts` reads the same field for the post-login hop and is the closest existing logic.
- **Known hazard, deliberately not solved here:** `lastActiveOrganizationId` is written by the browser workspace switcher, whose input accepts null for "Personal account". So clicking that in the UI changes where the same person's non-browser credentials resolve: a multi-organization user who does it puts every one of their API keys into the *ambiguous* absence until they name a tenant or switch back. That is a soft lockout, not a silent mis-resolution — there is no tie-break to fall onto, because this unit deliberately has none. Binding a key to an organization of its own would fix it properly and is a larger change than this plan carries; record it as an open question rather than papering over it. It also stops mattering once the switcher's personal entry is removed.
- **Test scenarios:**
  - Single membership resolves to that organization.
  - Several memberships with a valid last-active resolve to the last active one.
  - Several memberships with a last-active the user no longer belongs to return the ambiguous absence, distinguishable from the no-membership one.
  - Several memberships with no last-active set return the ambiguous absence.
  - The two absences are distinguishable by the caller of the helper, not merely by a log line.
  - No membership returns an explicit absence, not a throw and not a fabricated organization.
- **Verification:** the helper is the only place the rule is written, and its no-membership behaviour is documented rather than implied.

### U2. Gateway resolves through the helper

- **Goal:** The personal-key path stops returning a null organization.
- **Requirements:** R3, R6, R6c, R2d (the gateway selector only)
- **Dependencies:** U0, U1
- **Files:**
  - modify `apps/web/app/api/mcp-gateway/route.ts`
  - modify or create its test file
- **Approach:** Replace the hardcoded null with a call to the helper. The comment that currently reads *"organizationId always null"* is the thing being retired — rewrite it to say what the path now does, rather than deleting it, so the next reader sees the change was deliberate.

  Decide explicitly what happens when the helper returns an absence, and note that after R2c there
  are two of them. The **ambiguous** absence is answerable by the caller: refuse, and say that they
  belong to several organizations and must name one. The **no-membership** absence is not answerable
  by anyone — that caller has nowhere to resolve to.

  **No runtime compatibility branch is built for the no-membership case.** An earlier revision proposed
  one behind a flag; it was removed because it is redundant with the Goal Capsule's stop condition and
  worse than it. The stop condition already requires that population to be counted and a product owner
  to rule *before* this unit ships, so by the time U2 lands the answer is known: if the count is zero
  the branch protects nobody, and if it is not, the ruling says what to do and a flag defaulted off
  would not have implemented it anyway. Keeping it would also leave R6 false by construction and make
  its own removal depend on telemetry that cannot be collected before the release it belongs to. Ship
  the refusal, or do not ship the unit.

- **Test scenarios:**
  - A personal key for a single-organization user resolves to that organization.
  - A personal key for a multi-organization user resolves to their last active one.
  - A multi-organization user whose last-active is unset or stale can name one of their own organizations and is honoured.
  - Naming an organization they do **not** belong to is refused **on this route**, proven by a gateway-specific test rather than inherited from U0's.
  - A session is not reused after its selector is denied.
  - A personal key for a user with no membership is refused, with a message that does not invite a retry that cannot succeed.
  - A personal key for a user in several organizations with no usable last-active is refused with a message telling them to name one, distinguishable from the no-membership refusal.
  - An organization key still resolves from the key record and is unaffected.
  **An ambiguous caller needs a way to name their organization, or fail-closed becomes a lockout.** The hosted server already accepts an explicit organization from the caller, and U0 makes that path membership-checked; the gateway accepts none. Give it the same one — **and have this route run the check itself.** U0 modifies the hosted route alone and cannot vet a request the gateway handles, so "reuse U0's check" means calling the same shared membership-verification helper with this route's own freshly authenticated user, not relying on the other route having run it. Adding a selector without its own check would recreate on the gateway exactly the defect U0 exists to close on the hosted server. Call the shared verifier U0 created, and name the transport the selector arrives on rather than leaving it to the implementer. Without it, a caller in several organizations whose last-active is unset resolves to the ambiguous absence, is refused, and cannot reach the switching tool that would fix it — because reaching any tool requires the session they were just denied. Selecting "Personal account" in the browser produces exactly this state today, so it is reachable rather than theoretical.

  **Session reuse has to move with the resolution, or the resolution does not take effect.** The gateway reuses a cached session whenever the stored user matches the authenticating user, ignoring the organization it just resolved, and sessions live twenty-four hours. So a session opened before a membership change — or before this change ships — keeps operating in its old organization for the rest of its life. Reject a session whose stored organization differs from the freshly resolved one, and revalidate membership on reuse rather than trusting the stored value.

  The hosted server compares the two, but only when both are present: the guard requires a fresh and a stored result together, and the session is then built from `stored ?? fresh`. So a request whose fresh authentication *fails* skips the comparison and proceeds on the stored value. Mirror the comparison, not the hole — and fix the hole itself in U0, where it lets an existing session outlive the very check U0 adds.

  Invalidating sessions established before this ships is part of the unit, not an operational afterthought. A stale session is exactly the state the resolution change exists to end.
- **Test scenarios (session lifecycle):**
  - A session whose stored organization differs from the freshly resolved one is rejected rather than reused.
  - A caller who loses membership mid-session stops resolving into that organization on the next request.
  - A session established before the change does not survive it.
- **Verification:** no key-authenticated path in this file returns a null organization, and no configuration can reintroduce one. The browser-session branch is out of scope per R6 and carries a comment saying so. No cached session outlives the organization decision that created it.

### U3. Hosted server resolves through the helper when nothing is supplied

- **Goal:** The path that supplies no organization stops defaulting to none.
- **Requirements:** R4b, R6
- **Dependencies:** U0, U1
- **Files:**
  - modify `apps/web/app/mcp/route.ts`
  - modify or create its test file
- **Approach:** Where no organization is supplied, resolve through the helper instead of
  defaulting to none.

  Two cases stay as they are, and each needs a comment saying why, so neither reads as an
  oversight. The unauthenticated public session has no user and therefore no membership. The
  Better Auth browser-session branch takes its organization from the session, which can still
  legitimately sit in personal context until that context is removed — see R6.
- **Test scenarios:**
  - A key-authenticated caller supplying nothing resolves through the helper.
  - The unauthenticated public session behaves as before.
  - The browser-session branch still honours the session's own organization, including when
    that is personal context.
- **Verification:** no key-authenticated path in this file returns a null organization; the two
  exclusions are commented rather than silent.

### U4. Organization-switching tool stops offering personal

- **Goal:** The one tool that can put a session back into personal context no longer can.
- **Requirements:** R5, R6b
- **Dependencies:** U2, U3 — not for the resolver, which this unit never calls, but for the invariant it asserts. U4 removes the only way back to personal context; until U2 and U3 stop the entry points *creating* personal sessions, that makes the transition one-way while both servers still hand out the context it refuses to return to.
- **Files:**
  - modify `apps/web/modules/saas/mcp/lib/gateway/platform-tools.ts`
  - modify or create its test file
- **Approach:** The tool currently documents a null organization as the way back to personal mode. Remove that affordance: reject a null organization with a message saying context is organization-only. Update the tool's description too — it is read by a model, so a stale description keeps the retired behaviour alive in the model's head even after the handler stops honouring it.

  **The descriptions are not a footnote to this unit; they are half of it.** The word appears sixteen times in this one file, and the handler is only one of them. The two that matter most are the ones a model acts on: the switch tool's own parameter description, and a runtime refusal that tells the caller to *"Call `fabric_switch_organization` with `organizationId=null` first, then retry"*. Leaving that string in place after the handler stops honouring it does not merely read as stale — it routes the model into a retry loop against an operation that now always fails. Sweep the file rather than fixing the handler and moving on, and rewrite the refusal to say the project is unreachable in organization-only context.

  Two tests currently assert that refusal text contains `organizationId=null`. They pin the behaviour being retired, so they change with the source and the reason goes in the commit message — this is a deliberate contract change, not a stale assertion.

  The identity tool reports a personal or organization mode. Once no path can produce personal — which is true only after U2 and U3, not after this unit alone — that field has one value; say so rather than leaving a dead branch. Shipping this unit ahead of them would advertise a single mode while both entry points still produce the other.
- **Test scenarios:**
  - Switching to an organization the caller belongs to succeeds.
  - Switching to one they do not belong to is refused, as today.
  - Switching with a null organization is refused with a message naming the reason.
  - The identity tool no longer advertises a personal mode.
  - No tool description, parameter description or refusal message in the file instructs a caller to switch into personal context.
- **Verification:** a search of the file for the affordance returns only prose that describes it as removed; no live string offers it.

### U5. Account settings reachable from organization context

- **Goal:** Security and notification settings have a home an organization user can reach.
- **Requirements:** R7, R8, R9, R10
- **Dependencies:** none
- **Files:**
  - modify `apps/web/app/(saas)/app/(organizations)/[organizationSlug]/settings/layout.tsx`
  - create the organization-side routes for both surfaces
  - modify `apps/web/modules/saas/shared/components/NavBar.tsx`
  - modify `apps/web/modules/saas/shared/components/UserMenu.tsx`
  - modify `apps/web/modules/saas/get-started/lib/get-started-registry.ts`
- **Approach:** Add an account group to the organization settings menu holding security and notifications. **Append it after the organization's own group, never before it** — the settings sidebar renders its compact header from the first group's title and avatar, so a prepended account group would show the user's own name and avatar as the heading of a page whose URL and content are the organization's. The organization group is the only one there today, which is why this is invisible until a second one exists. Both render the same components as the personal routes — the data is account-global, so there is nothing to scope and nothing to move. Resist passing an organization into either; that would invent per-organization security settings the product does not have.

  Fix the navigation gap while here. The sidebar's account link and the user menu's account link are mutually exclusive on context, so an organization user currently has no route to their own account settings from either. Both should offer it regardless of context.

  **The un-hidden link keeps pointing at the personal-rooted account page.** This plan builds organization-side routes for security and notifications only; there is no organization-rooted profile page for the link to target, and inventing one is out of scope. Leaving the personal destination is consistent with what the product already does: the organization layout's own two-factor enforcement redirect sends organization users to the personal security path today. Say this in the code rather than leaving the next reader to wonder whether the context exit was intended.

  Do not let the change reach the guest presentation. The sidebar computes its base path from `isGuest || !isOrgContext` precisely so a project-only guest is shown the personal variant and never the host organization's identity; adding an unconditional account link must not add an organization link to their chrome.

  The onboarding registry marks the security entry as personal-scoped and the drawer filters on that. Once the surface exists in both contexts the scope value is wrong; update the entry. A drift test enforces registry-to-anchor consistency, so this has to land in the same change.
- **Patterns to follow:** the personal settings layout's menu construction; the notification settings link component, whose comment already notes its path resolves correctly from any context.
- **Test scenarios:**
  - An organization user sees security and notifications in the settings menu.
  - Both render for an organization user and read the same account-global data as the personal routes.
  - The sidebar and user menu both offer an account-settings link in organization context.
  - A personal-route bookmark for either still arrives somewhere valid.
  - The onboarding drawer shows the security entry in organization context.
- **Verification:** the settings-route difference between the two trees is down to the stale stub and the two organization-only pages; the get-started drift test passes.

### U6. Remaining parity routes

- **Goal:** The two live features with no organization route get one; the stale stub goes.
- **Requirements:** R11, R12, R13
- **Dependencies:** U5 — both units edit the onboarding registry, and sequencing them avoids a conflict in that one file.
- **Files:**
  - create organization-rooted routes for automation templates, the task-planner agent and agent-register
  - modify `apps/web/modules/saas/automation-templates/components/TemplatesList.tsx`, `TemplateCard.tsx` and `TemplateEditor.tsx` — five navigations across them are rooted at the personal path
  - modify `apps/web/modules/saas/get-started/lib/get-started-registry.ts` — move the automation-templates tour entry to the organization-rooted route; the drift test gates this
  - delete the stale redirect stub route
- **Approach:** Both features work today at personal-rooted paths and are linked from inside their own modules rather than from navigation, which is why a navigation-based survey missed them.

  **A new route is not the whole job — the components inside it navigate too.** Automation templates hardcode the personal path in five places across the list, the card and the editor: opening a template, creating one, and where the editor lands after a save. Mounting those components under an organization route without touching them produces a page that renders correctly and then walks the user straight back into the personal tree on their first click. Make each navigation context-aware, the way the rest of the app derives its base path, rather than duplicating the components per context.

  This is also why the test scenarios below assert transitions rather than rendering. A render-only test passes on exactly the broken version this paragraph describes. Automation templates owns a registered onboarding tour, so it is presented as a live feature and its registry entry moves with it.

  The stub redirects to a page that exists on both sides and has no organization twin of its own. Nothing links it. Remove it rather than building a counterpart for a redirect.

  **A third route fails this unit's own verification and has to be named.** The agent-register route exists only in the ungrouped tree, and the organization group has no register segment — so the link helper, which prefixes the organization slug, resolves it against the dynamic agent route with the literal segment as an identifier. The surface map gives it `repair`, not `remove`: it is already broken from organization context, and eliminating the personal tree only makes the break permanent. Give it an organization-rooted route with the other two — R13, not an optional extra. An earlier revision allowed deferring it; that was withdrawn because the unit's own test and verification demand it while the completion criteria permitted skipping it, which is a contradiction an implementer resolves in whichever direction is cheaper.
- **Test scenarios:**
  - Automation templates renders at an organization-rooted route.
  - From that route, opening a template, creating one, and saving one each stay in organization context — asserted per transition, not by rendering the list.
  - The task-planner agent renders at an organization-rooted route.
  - The removed stub's path no longer resolves, and nothing links to it.
  - The agent-register link resolves to a real page from organization context.
- **Verification:** every personal-rooted route either has an organization counterpart or is recorded in the surface map as deliberately removed, and no component reachable from an organization-rooted route navigates to a personal-rooted one.

---


## Verification Contract

- **The cross-tenant case has a test that fails without the fix.** U0's refusal test is the one gate that proves the isolation defect is closed rather than merely described — and it ships in U0's own pull request, not this plan's.
- **No key-authenticated protocol path yields a null organization.** Asserted by test, not by inspection. The browser-session branches are excluded by R6 and each carries a comment saying why.
- **The resolver is the only place the rule lives** among the call sites this plan converts. The REST flag and the command-line selector are sequenced after it and must consume the same helper.
- **No live string offers personal context to a model.** Descriptions, parameter descriptions and refusal messages are swept, not just handlers.
- **Settings parity is a routing change.** The diff adds no organization column, no migration, and no tenant filter to the security or notification surfaces.
- **Drift guards pass.** The get-started drift test and the surface-map drift test both stay green; the surface map is updated in the same change where a route it names moves.
- **Existing suites.** The permission test suites pass unchanged — this plan changes tenancy resolution, not role checks. Protocol suites do change: U4 retires an affordance two tests currently pin, and that is a deliberate contract change recorded in the commit message.
- **Changesets.** Two: one for U0, shipped first and alone, and one for the rest. Both bump the deployable app and no internal package.

---

## Definition of Done

- A shared resolver exists, is used by every protocol call site this plan converts, and documents its no-membership behaviour.
- Neither protocol entry point returns a null organization for a key-authenticated caller, and no flag exists that could reintroduce one.
- A caller in several organizations can name one of their own through either entry point, and is refused when they name one they do not belong to.
- No cached protocol session outlives the tenancy decision that created it, on either entry point, including when fresh authentication fails.
- A caller supplying an organization they do not belong to is refused, proven by a test — merged ahead of this plan as U0.
- The organization-switching tool, its descriptions and its refusal messages no longer offer personal context.
- Security and notification settings are reachable from organization context, and the account link exists in both the sidebar and the user menu.
- Automation templates, the task-planner agent and agent-register all have organization-rooted routes, and automation templates navigates within organization context rather than back into the personal tree; the stale stub is gone.
- `docs/personal-context-surface-map.md` is updated where this change moved something it names.
- The changeset bumps the deployable app and no internal package.

---

## Sources / Research

- `docs/personal-context-surface-map.md` — the audit this plan implements against. Section S2 for the settings pairing, S4 for the route-tree diff, R1 and R6 for the resolvers and entry points, R7 for the two protocol defects.
- Fizzy #1875 / Fabric Feature 552 — FR3b (parity regardless of data drop), FR4 (organization-only resolution, last-active default, and no personal reference *under any code path*), FR5 (redirect rather than delete). FR9, FR10, FR11 and UC4 describe a separate marketing-site and bring-your-own-key lane that neither this plan nor the surface map covers — see Scope Boundaries. The feature's drafting stage reads `PLACEHOLDER` rather than `PUBLISHED`; the requirements quoted here were verified verbatim against it on 2026-08-27, but the spec is not formally published.
- Fabric bugs 553 and 779 — both open, both P1, both describing the resolution defects this plan closes.
