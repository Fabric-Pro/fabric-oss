---
title: Personal Context Elimination — What Remains
type: feat
date: 2026-08-28
topic: personal-context-elimination-remainder
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: legacy-requirements
origin: docs/plans/2026-08-27-001-feat-org-only-context-implementation-plan.md
execution: code
---

# Personal Context Elimination — What Remains

## Goal Capsule

- **Objective:** Finish Fizzy #1875 / Fabric Feature 552. The prerequisites, the
  protocol resolution, the settings tree and the auto-organization are done and
  live on `feature/1875-org-only-context`. What is left is the rest of the
  personal route tree, the interface strings, the guest presentation, the
  residual permission bypass, and the marketing-site lane nobody has started.
- **Product authority:** Fizzy #1875 / Fabric Feature 552. Every disposition in
  `docs/personal-context-surface-map.md` reads `approved 2026-08-27`.
- **Evidence base:** the surface map, and the branch itself — several of the
  map's derivations turned out to be stale when run against the tree, so prefer
  the tree.
- **Stop conditions:**
  - Stop before removing the guest presentation until it has been observed
    against a real project-only guest. It moves four production sites at once
    and none is checkable from a unit test. Note that removing the personal
    routes forces the change whether or not it has been made; see U1 and U3.
    The change itself is now smaller than when this plan was written — see R3.
  - Stop before the drop job runs anywhere real until its dry run has been read
    on staging. The inventory exists precisely so that reading is possible.

---

## Product Contract

### Summary

Personal context can no longer be *reached* — the switcher does not offer it,
the settings tree is gone, every account has an organization, and every protocol
entry point resolves into one. It still *exists*: seventeen route directories, a
guest presentation that deliberately shows it, and the strings that name it.

Removing what remains is mostly mechanical. Two pieces are not: the guest
presentation, which is a design change that cannot be verified here, and the
residual permission bypass, which becomes a real hole the moment personal
context stops being the reason it was tolerated.

### Corrections found by running the work

Recorded where the plan was wrong, so the next reader trusts the tree over the
document — which is what this plan already advised, and was right to.

**The catch-all shape does not generalise.** R1 said to copy the settings
catch-all: "one redirect where many routes were". That works for `settings`
only because it is a STATIC segment, which outranks the dynamic
`[organizationSlug]`. At the account group's ROOT there is no such anchor, and
one catch-all there is impossible twice over: Next refuses a second catch-all
beside the existing `/app/[...rest]` (a compile error, not a precedence
question), and `[...rest]` never receives these paths anyway — a probe returning
a marker from it was not reached even by a path matching nothing, because
`[organizationSlug]` claims `/app/{anything}` first. One catch-all per retired
tree, under its own static segment, is the smallest shape the router allows.

**Two personal trees sat outside the account group.** `/app/agents` (seventeen
pages) and `/app/frames` (three) are personal-rooted in exactly the sense this
epic removes, but a count of directories under `(account)` does not reach them.
They were found by a test that imported one. Two agent surfaces there —
`document-generator` and `cuga-generalist` — had no organization counterpart and
were moved rather than replaced.

**The E2E suite does not break.** This plan's sizing assumed seventy-six specs
navigating to `/app/...` would need rewriting. They do not: the redirect answers
them and Playwright follows it. Rewriting those paths is legibility work, not
repair, and it is not a CI gate either way.

**The guest guarantee was enforced in one file out of twenty-three.** See R3.

### What is already done

Recorded so this plan is not re-litigated against work that shipped.

| | |
|---|---|
| FR1a | Every account gets an organization, at signup and as a sign-in backfill |
| FR3, FR3a, FR3b | Audit approved; notifications and the parity surfaces have organization homes |
| FR4, UC3 | Both protocol servers resolve organization-only, fail-closed, with sessions that cannot outlive the decision |
| FR5 (part) | Context is organization-only; the switcher's personal block and the whole personal settings tree are gone |
| PO-9 | The versioned REST flag and the command-line selector are retired |
| — | Two live cross-tenant defects closed, and a third class frozen behind a sweep |
| R1 | Every personal route tree retired — fifteen under the account group, plus `agents` and `frames` outside it — each replaced by one redirect; `/app/test` removed outright |
| R3 | A guest's chrome is rooted in their OWN organization in all four sites, and no page's breadcrumb names the host |
| — | Four in-app links fixed that addressed an organization by id where the route resolves by slug, and each 404'd for every member |
| — | The knip gate restored: nine components orphaned by the settings removal, and three unused exports |
| R2 | No interface string names personal tenancy; the credential-class names stay and say why |
| R4 | All twenty-nine evaluate, each by the exit that fits its shape: org-scoped against the organization named in input, project-scoped object-level, and plan-scoped in the handler once the plan resolves its project. The sweep's pending list is empty |
| — | A session now carries the organization it runs in, closing the last way past those checks — an explicit `organizationId: null` is refused rather than passed through |
| — | The drop job no longer selects GLOBAL rows: seventy-two of eighty-seven on a local database, including the seeded MCP catalog and every system prompt |

### Requirements

**R1. The personal route tree is gone.** DONE — see the corrections above for
the two ways this was mis-sized. Originally written as: seventeen directories
remain under the
account group. All but one have an organization counterpart of the same name;
the exception is `test`, a developer harness inside a production route tree with
no inbound link. The settings tree's catch-all is the shape to copy — one
redirect where many routes were, so bookmarks and hardcoded callbacks still
land.

**R2. No interface string names personal tenancy.** Seventeen translation values
mention "personal", and they are three different things:

- Eight name a *credential class* — "personal API key", "personal access token".
  These survive elimination and should keep naming the class. Not in scope. The
  surface map says five; it was counted before the tree was, and the tree is
  right.
- Four name the tenancy and die with it: the switcher label, the account-settings
  subtitle (which the map records as having zero consumers), the notifications
  hint, and the audit-log filter title.
- The prompt scope enum's `Personal` label is a data question, not a string one —
  whether that scope survives is decided with the prompt model, not here.

**R3. A project-only guest's chrome names an organization, not a personal
workspace.** DONE — and larger than described. Which organization is now a
different question than it was.

The four sites this named were the switcher, the nav base path, the breadcrumb
home and the organization's projects page. Running it against a real guest found
a fifth, bigger one: **twenty-three pages open their breadcrumb trail with the
host organization's NAME, linked to its root, and exactly one of them — the
projects page — dropped it for a guest.** A guest reaching any of the other
twenty-two read the host's name at the top of the page. They all point that
crumb at the same place, so the rule now lives in the breadcrumb component and
matches on the destination rather than the label.

That rule governs what a guest is SHOWN. The name still travels in the
serialized payload, as this component's props and — independently of
breadcrumbs — as the active-organization object the layout prefetches for the
guest's own project access. It is not a confidentiality boundary, and filtering
server-side would not make it one while the layout seeds that object.

PO-6 approved showing them the host organization, and that ruling was made when
a project-only guest had NO organization at all — so the choice was between
showing them personal context and accepting the disclosure, and there was no
third option to weigh.

FR1a removed that premise. Guest is defined relative to the host organization —
`isGuest = no membership there AND an accepted project membership there` — so
guests still exist, but every one of them now has an organization of their own.
Their chrome can be rooted in it.

That satisfies the requirement without taking PO-6's disclosure: personal
context disappears, and the host organization's identity stays out of their
chrome, which is the guarantee four separate places in the codebase were written
to protect. It also reuses machinery that is already there — a guest's chrome
ALREADY diverges from the URL (to `/app`), and the project-shortcut list already
builds its links from the project's own organization slug precisely so a guest's
shortcut reaches the host while their chrome does not. Only the destination of
that divergence changes.

**R4. A procedure with no tenant context cannot silently skip a role check.**
Twenty-nine are frozen on a list that may only shrink. This becomes a real
defect the moment personal context is gone, because "no tenant context" stops
having a meaning that made the skip safe.

**R5. The marketing-site lane ships.** WITHDRAWN — this plan should not have
carried it, and three independent things say so.

The previous plan placed FR9–FR11 and UC4 in "a separate marketing-site and
bring-your-own-key lane that neither this plan nor the surface map covers", in
its Scope Boundaries. The product owner then decided the same thing directly:
BYOK is a separate track. And Feature 552, the only place these requirements
live, reads `PLACEHOLDER` rather than `PUBLISHED` — Fizzy #1875 does not mention
a trial, a credit, a card or the marketing site at all.

The tree agrees. Nothing under the marketing module references personal context,
and neither the trial-credit banner nor the card-collection step exists to be
removed. So this is not merely out of scope: its premise does not match the code.

It ships on its own track, against a published spec.

**R6. The drop runs, and its dry run is read first.**

### Acceptance Examples

- **AE1 (R1).** Given a bookmark to any personal-rooted page, when it is
  opened, then it arrives at the same page inside the user's organization.
- **AE2 (R2).** Given the interface in any state, when its text is searched for
  the word naming personal tenancy, then only credential-class names remain.
- **AE3 (R3).** Given a user whose only access is a shared project, when they
  sign in, then their chrome names the organization that owns the project.
- **AE4 (R4).** Given a procedure built without tenant context, when it declares
  a permission, then either the check evaluates or the exemption is recorded.
- **AE5 (R6).** Given the drop job on staging, when it is run without `--apply`,
  then its report accounts for every model, and no model is uncounted without a
  reason.

### Scope Boundaries

- No data is migrated. The ruling stands.
- The prompt scope enum is decided with the prompt data model, not here.
- The `PublishingTopicRead` model has no Prisma delegate — a pre-existing
  schema-to-client drift the inventory surfaces. It is not caused by this work
  and is not fixed by it.
- The marketing-site and bring-your-own-key lane (FR9–FR11, UC4) is a separate
  track against a published spec. R5 records why this plan was wrong to carry
  it.

---

## Implementation Units

### U1. Remove the rest of the personal route tree — DONE

- **Requirements:** R1
- **Dependencies:** U3 — see its entry. Removing these routes redirects a
  guest's `/app`-rooted links into the host organization, which is U3's change
  arriving without U3's verification.
- **Approach:** The settings catch-all is the pattern. One optional catch-all at
  the account group's root redirects any personal-rooted path into the caller's
  organization, and the seventeen directories go.

  One needs a decision rather than a redirect: `test`, a developer harness
  inside a production route tree with no inbound link — remove it outright. The
  rest have an organization counterpart of the same name and redirect to it.

  Check the hardcoded destinations first. The settings removal turned up ten
  callbacks and a config redirect pointing into the tree; the same sweep is
  needed here, and the OAuth ones cannot know an organization slug, which is
  exactly what the catch-all is for.
- **Verification:** no route resolves under the account group except the
  catch-all; every hardcoded personal path in the repository still lands.

### U2. Retire the strings that name personal tenancy — DONE

- **Requirements:** R2
- **Dependencies:** U1, U3 — the switcher label dies with the guest change, and
  the notifications hint points at a settings route U1 removes.
- **Approach:** Four keys, and the work is deciding which of the three kinds each
  belongs to rather than deleting them. Leave the credential-class names alone
  and say so where they sit, or the next sweep removes them and renames a
  credential nobody meant to rename.

  The account-settings subtitle has no consumers. Confirm that before deleting
  rather than after.
- **Verification:** a walk of the translation file returns only credential-class
  uses.

### U3. The guest presentation — DONE

- **Requirements:** R3
- **Dependencies:** none — but U1 must not ship before it, and that is a
  correction to this plan's first draft rather than a preference.

  U1 removes the routes a guest's `/app`-rooted links point at. Those links then
  reach the catch-all, which redirects into the caller's organization — so a
  guest is presented the host organization as a SIDE EFFECT of U1, delivering
  exactly the change this unit exists to make deliberately, without the
  verification this unit is gated on. The stop condition below protects nothing
  if U1 goes first.

  Either this unit lands before U1, or U1's catch-all has to special-case a
  guest until it does. The first is simpler and is the recommendation.
- **Approach:** A guest's chrome is the personal variant in four production
  sites, not two: the switcher's trigger label, the base path every navigation
  link is built from, the breadcrumb home link, and the organization's own
  projects page. All four change together — a switcher naming one workspace
  while the nav is rooted in another is incoherent for the person looking at it.

  Root them in the guest's OWN organization rather than the host's, per R3. The
  divergence already exists; what changes is where it points. The source is the
  session's active organization, which after FR1a is the guest's own: context is
  URL-driven, so the URL carries the host's slug while the session carries
  theirs, and the two staying apart is what keeps the host's identity out of
  their chrome.

  The organization settings layout redirects guests out. Rooting their chrome in
  their own organization avoids that entirely — the settings they reach are
  their own, in an organization they belong to — which is a second reason this
  reading is easier than PO-6's, not merely more private.

  What still needs a live check: that a guest's session names their own
  organization while they browse a host project, and that their own dashboard
  renders for them. Both are cheap to observe and neither is a design question
  any more.
- **Verification:** exercised against a real project-only guest session, not a
  unit test. This is the stop condition, and it is the reason this unit is not
  bundled with U1.

### U4. The residual permission bypass — DONE (29 of 29)

- **Requirements:** R4
- **Dependencies:** ships in the same release as U1
- **Approach:** Twenty-nine procedures are frozen on the sweep added with the
  weave fix. Each needs a move to the tenant-aware builder or a recorded reason.
  Moving one removes it from the sweep, which is the intended exit.

  The weave cluster is nineteen of the twenty-nine and shares one shape: they
  resolve an organization from caller input and act in it. Their membership axis
  is closed; their role axis is not.
- **Verification:** the pending list shrinks and its ratchet is lowered with it.

### U5. The marketing-site lane — WITHDRAWN

- **Requirements:** R5, which is withdrawn; see it for why.
- Not started, and not to be started here. Filed as **Fabric F-939** on
  2026-08-28, carrying AC17-19 verbatim plus what was already established: two
  of the three are met by the auto-created organization, and AC19's surface is
  absent from this repository.

### U6. Run the drop — dry run read, one defect found and fixed

- **Requirements:** R6
- **What reading it found:** the sweep selected every row with no organization,
  and a row with no organization AND no user is GLOBAL, not personal. On a local
  database that was seventy-two rows of eighty-seven — the seeded MCP catalog,
  the system prompts, their versions and bindings. Applying it would have
  deleted them. The dry run also returned at phase A's refusals without
  reporting phase B at all, so the report an operator is told to read accounted
  for no models. Both are fixed; the inventory and the dry run now agree on the
  same fifteen rows.
- **The staging inventory has now been read, and it changes the unit.** This
  plan said: "If it reports nothing, the remainder of this epic is a formality.
  If it reports something, read the dry run before `--apply`." It reports
  something, and the amount is the finding:

  | | |
  |---|---|
  | Personal rows | **373,851** across **92 models** |
  | Users | 69, of whom **36 have no organization** |
  | Personal API keys | 14 |
  | Largest | AiUsageLog 180,465 · RequestSpan 131,526 · AuditLog 47,792 |
  | Real content | Project 42 (15 users) · AiChat 152 (10) · AgentTask 216 (12) · Notification 1,900 (21) · TestCase 270 (2) · EpisodicMemory 257 (10) |

  **It is in active use.** The newest personal `AiChat` is dated four days before
  this reading; the newest `TestCase` eight. Accounts are still being created
  without an organization — the most recent four days ago.

  **What the ruling actually says**, checked against PO-11 rather than
  paraphrased — and it is narrower than "the data is gone":

  - Personal workspace data is **dropped**, not migrated and not archived.
    Recorded as `settled 2026-08-25`, "recorded here, not reopened".
  - **No technical verification pass is required before the drop executes.**
    "The team's assessment that no active usage exists was accepted as
    sufficient."

  So the ruling never asserted the rows were absent. It accepted an assessment
  as sufficient grounds not to count — and the same section says so outright,
  listing under **Not established**: "Whether any rows exist in them. No
  population was counted anywhere in this document."

  This reading fills exactly that gap. It does not reopen the drop, which is a
  disposition and stands. What it changes is the basis: the drop is now known to
  remove active content rather than believed to remove nothing.

  Two things it does NOT establish, and neither should be assumed:

  - **Staging is not production.** Much of this may be QA and demo activity, and
    dropping it may be entirely correct. What the numbers rule out is that the
    drop is a formality *here*.
  - **The 36 users with no organization are expected right now.** FR1a backfills
    at sign-in and has not shipped; they gain an organization when they next
    sign in after release. A user who never signs in again keeps none — which is
    the sequencing risk: dropping before they return leaves them with neither
    their data nor a workspace.

  **Migration was reconsidered against these numbers and refused again, on
  2026-08-28.** The question was asked directly — could these accounts become
  organizations — and answered with what the tenancy classes actually do:
  `PER_USER_ORG` rows (chats) move safely and stay private; `USER_OWNED` rows
  (projects, tasks, diagrams, test cases) move with one statement but lose their
  per-user predicate on the first invitation; `STRICT_ISOLATION` rows (purchases,
  credit accounts) become invisible to both branches unless attribution is
  destroyed; and the audit trail's trigger permits the opposite direction only.
  Files and embeddings move with neither.

  It was also noted that 96% of the rows — `AiUsageLog`, `RequestSpan` and
  `AuditLog` together — are telemetry nobody would miss, so a partial migration
  of the few hundred rows people WOULD notice was available and cheap.

  The ruling is unchanged and now doubly explicit: **nothing is migrated.** This
  is recorded because the decision was taken a second time, with the population
  in hand rather than assessed, which is a stronger footing than the first.

  So one consequence PO-11 already recorded as needing an owner now has a
  population rather than a hypothesis:

  > **Nobody is told.** Users lose access to personal projects, documents, chats
  > and files. The ticket's communications note covers migrated users; there is
  > no note for dropped ones.

  On staging that is 15 users with personal projects, 12 with agent tasks, 10
  with chats and 21 with notifications. Whether the same shape holds in
  production is the one number still missing.
- **The staging dry run has now run in full**, once the job stopped asking for a
  bucket variable the application never defined. Phase A clears all 69 users and
  finds 94 objects across the seven buckets; phase B reports 91 models holding
  375,532 rows. Nothing was changed.
- **Decided 2026-08-28: not applying yet.** The drop itself is not in question —
  it was reaffirmed twice — but three things make waiting cheap:

  - **It is reversible while the rows are there.** The branch already makes them
    unreachable: no personal route survives, the session always carries an
    organization so the tenant filter takes the organization branch, and the API
    refuses an explicit `organizationId: null`. Someone asking where their
    project went can still be answered by hand. After `--apply` they cannot.
  - **A third of the volume expires on its own.** `request-span-retention`
    purges by age with no tenant predicate — 131,540 of the rows inside a week —
    and nine other retention workflows do the same for attachments,
    conversations, QA evidence and the rest. `AiUsageLog` (180,566) is the
    largest table with no retention of its own.
  - **36 of the 69 users gain an organization only at their next sign-in**, once
    FR1a ships. Dropping before then leaves them with neither their data nor a
    workspace; dropping after leaves most of them with one.

  Recorded plainly: **without the drop, "personal context is eliminated" is a
  statement about the code, not the data.** Reachability is gone; the encoding
  is not.
- **Still to do:** the production inventory, and then the decision to apply —
  best taken after release, for the reasons above.
- **Dependencies:** U1–U4 — the rows go last, after nothing reaches them
- **Approach:** Read the inventory on staging first. If it reports nothing, the
  remainder of this epic is a formality and should be recorded as such. If it
  reports something, read the dry run before `--apply`, and cancel at the
  payment provider before any purchase row is deleted — the job refuses rather
  than choosing, so this is a decision someone makes, not one it makes for them.
- **Verification:** a second run finds nothing, and every refusal in the first
  has an owner.

---

## Verification Contract

- **Nothing reaches personal context.** Asserted by the absence of routes, not
  by the absence of links.
- **Every hardcoded personal path still lands.** The callbacks that cannot know
  a slug are the test of the catch-all, not the bookmarks.
- **The guest change is exercised against a guest.** Not a unit test.
- **The permission sweep's pending list only shrinks.** Its ratchet enforces it.
- **The drop's dry run is read before it runs.**

## Definition of Done

- No route resolves under the account group except its redirect.
- No interface string names personal tenancy except a credential class.
- A project-only guest is presented an organization — THEIRS, not the one that
  owns their project. This reverses PO-6, whose premise (a guest has no
  organization) FR1a removed; see R3. The host is named nowhere in their chrome.
- The permission sweep's pending list is empty, or every entry on it carries a
  recorded reason rather than a freeze.
- The marketing-site lane is NOT in this epic — see R5.
- The drop has run, or the inventory has shown there is nothing to drop and that
  is recorded. **The staging inventory has been read and shows 373,851 rows in
  active use — see U6.**
- `docs/personal-context-surface-map.md` describes the tree as it then is.

## Acceptance criteria — where the branch stands against Feature 552

Checked against the feature's own nineteen criteria on 2026-08-28, not against
this plan's units, because the two were written for different purposes.

**Met (11):** AC2 (an invited user gains no second organization — the auto-create
runs after invite reconciliation, deliberately), AC6 and AC7 (per-user refusal,
idempotent re-run), AC10 and AC11 (parity), AC12 and AC13 (protocol resolution),
AC14 (no interface path to personal context), AC16 (the naming convention), and
AC1 and AC15 as resolved below.

**Resolved here:**

- **AC1** asked the onboarding interface to *explicitly confirm* the organization
  was prepared for the user. It created one and said nothing. The first
  onboarding step now names the workspace and says who made it — an account that
  silently gains one leaves the person guessing whether they made it, whether it
  is shared, and whether it is the thing they are meant to be in.
- **AC15** asked for a per-user migration status with a timestamp, reviewable
  afterwards. The job only printed to the console. It now writes a JSON record
  with `--report <path>`: start and finish, mode, every user with cleared or
  refused and the reason, objects removed, per-model counts, and what could not
  be counted. Deliberately NOT the audit log — a row about dropping a user's
  data is keyed to that user with no organization, which makes it personal, so
  the next run would sweep the record of the previous one.

**Resolved by the governing rule, 2026-08-28.** The product owner settled the
question the remaining items all turn on: *a user is never in a personal
environment — they are in an organization, or in the quasi-organization made for
them.* Three items follow from it rather than from their own wording.

- **AC3 / FR1 — no personal context is created by any path.** NOW TRUE. One path
  remained: a signup whose organization creation failed seeded the MCP defaults
  personally rather than not at all, on the reasoning that neither tenant seeded
  was the worse regression. Under the rule that trade is unnecessary and the
  wrong way round — a user with personal rows and no organization *is* the
  personal environment. It is removed, and the failure heals itself: the same
  helper runs on every session create, so the next sign-in makes the
  organization and seeds it.

- **FR7 — a second private organization for a user who already belongs
  somewhere.** SUPERSEDED, not implemented. Its purpose clause is "for their
  personal context data", and that data is dropped; what it would produce is an
  empty workspace nobody asked for. FR1a already says an invited user gains no
  auto-created organization, so the rule and FR1a agree — a user who has an
  organization is not in a personal environment and needs no second one.

- **The population, not just the code path.** Signup creates an organization and
  sign-in heals accounts that predate it, which covers everyone who comes back.
  It does not cover anyone who does not, and an account with no organization is
  the personal environment by another name — 36 of 69 on staging.
  `scripts/backfill-user-organizations.ts` closes that: read-only by default,
  `--apply` to run, using the same helper so a backfilled organization is
  indistinguishable from one made at signup. **Run it before the drop** — a user
  who gains an organization first loses their rows and keeps a workspace; a user
  dropped first has nowhere to be until they sign in.

**Conflicts with the 2026-08-25 ruling, and needs the ticket amended:**

- **AC4, AC5, AC8, AC9** require personal data to be *present in the private
  org* after migration, and permit dropping only data "confirmed inactive/unused
  … with no active usage". The ruling is to drop unconditionally, and the
  staging inventory established the data is active. The criteria and the ruling
  cannot both hold. The ruling is the later decision and was reaffirmed twice
  with the population counted; the criteria predate both. Amending them is a
  human edit to Feature 552 — a task has been filed there.

**Deliberately out of scope:**

- **AC17, AC18, AC19** are the fabric.pro/BYOK lane, now split to **Fabric
  F-939**, "fabric.pro signup lands in an org with BYOK messaging, no trial
  credit", so 552 does not wait on a `PLACEHOLDER` spec — see R5.

  Two of the three are already satisfied by the organization auto-creation on
  this branch: an account gets an organization at signup, and an invited user
  joins theirs without a second being made. What is left of AC17 is the naming
  reconciliation the criterion itself defers, and AC19's surface could not be
  found in this repository at all — no trial-credit banner, no card collection.
  Establishing whether it exists elsewhere is the first task there, not an
  estimate.

## Open findings, recorded rather than folded in

Each was found while doing the work above, is pre-existing, and is not caused or
worsened by it. None belongs to a unit here.

- **`buildInternalFrameUrl` / `buildInternalFrameEmbedUrl`** (`packages/temporal`)
  take an `organizationId`, branch on it, and return the SAME string from both
  branches — an organization case that was never written. Every internal frame
  URL is therefore personal-rooted. The redirects improve on this rather than
  break it: today an organization frame at a personal URL renders a page that
  cannot show it, whereas the redirect lands a member in their organization.
  A real fix needs the slug plumbed through the activity input.
- **`two-factor-step-up-lockout-drift`** (`packages/auth`) fails about one run in
  three. It probes real OTP expiry against wall-clock time and lands on
  `INVALID_CODE` when the run is slow. Unrelated to this epic.
- **`PublishingTopicRead`** has no Prisma delegate — already noted in Scope
  Boundaries, still true, still surfaced by the inventory.
- **knip's `vitest` unlisted binary** for `packages/fabric-ai` is a local
  artifact of an incomplete install; the package declares it and the lockfile
  pins it.
- ~~**An explicit `organizationId: null` walks past `requireInputOrgPermission`.**~~
  CLOSED. The cause was that `session.activeOrganizationId` was written only by
  an explicit organization switch, so the fallback everything relies on resolved
  to nothing. A session now carries its organization, seeded fail-closed at
  creation, so refusing the null no longer refuses the caller who omits it. The
  original finding is kept below for the reasoning.

  Original: **an explicit `organizationId: null` walks past
  `requireInputOrgPermission`.**
  Explicit null resolves to no organization and deliberately does not fall back
  to the session, so the middleware takes its pass-through branch and the role
  check never runs. The membership half still holds — object-level access reads
  the row's real organization — so this is a role hole, not a tenant one.

  A `requireOrganization: true` option exists and is tested, and refuses instead.
  It is NOT applied, because on these procedures it also refuses a legitimate
  caller who simply omits the organization: `resolveOrganizationId` falls back
  to `session.activeOrganizationId`, and that field is populated only by an
  EXPLICIT organization switch — never at sign-in. Most sessions therefore carry
  none, verified by reading the session rows on a running deployment.

  So the real fix is to make a session name the caller's organization, which is
  FR1a's natural completion and a change with its own blast radius: the code
  deliberately treats that field as untrustworthy for context, because it is
  shared across browser tabs on a last-write-wins basis.

- ~~**Twelve plan-scoped weave procedures still have an inert role check.**~~
  CLOSED. They call `assertProjectPermission` after the plan resolves its
  project — the same function the middleware calls. Three rulings went with it,
  and they are product decisions rather than mechanics:

  - A project-scoped guest reads weave plans and starts executions; they do not
    approve, revise or delete. No project role grants AGENT_CREATE/UPDATE/DELETE
    — the ladder stops at AGENT_EXECUTE, because agent management is
    organization-level — and an active ProjectMember row is authoritative.
  - Cancelling an execution is AGENT_UPDATE, not AGENT_DELETE. It changes state
    rather than removing anything, and at DELETE it would have required
    organization admin, locking out the member who started the run.
  - `use-template` is organization-scoped: a template names no project, so there
    is no object to check it against.

## Open: a project-scoped guest and the protocol servers

**Not fixed, deliberately, and not an oversight either way.** Raised in review as
the same bug this branch fixed in oRPC, reintroduced in MCP. Checking it found
the picture more mixed than that, and the correction matters more than the
finding.

Three sites hold a caller-named organization to `isOrganizationMember`: both
protocol routes and `fabric_switch_organization`. oRPC holds the same question to
`hasOrganizationTie` instead, which accepts a project-scoped guest — someone
invited to one project inside an organization they do not belong to — and that
helper's own doc comment says a membership-only check "refuses the guest path the
product is built around". So the inconsistency is real: a guest cannot name the
host organization over MCP, and resolves to their own instead.

**What actually happens today, corrected.** The first reading of this — mine —
said a guest is locked out and that `buildProjectAccessWhere` is what would keep
a widened check safe. Both halves are wrong, and the correction is worth more
than the finding.

A guest can already READ the project. What lets them is not the strict gate but
a weaker one standing in front of it: `hasProjectAccess` takes an
`_organizationId` it ignores entirely, answering from the `ProjectMember` row
alone (`projects.ts:985`). The gateway's read tools call only that.
`buildProjectAccessWhere` — which does scope `organizationId` — is never reached,
and would have refused the guest whose session sits in their own organization.

So access control holds: the guest reaches a project they are genuinely a member
of. What does not hold is tenancy SCOPING — a parameter that promises a scope and
delivers none lies to every caller, and the gap is already noted in the tree
(`platform-tools.ts:1813`).

**The general shape, since this is the second time it has bitten:** two gates on
one path, the strict one behind the weak one, the weak one deciding first. While
you are reading the strict gate the behaviour is explained wrongly — and wrongly
in the reassuring direction. These are found by looking for arguments a function
accepts and does not use, not by reading defences.

**Why the fix was still not applied.** Widening the three checks to a tie is only
safe if everything downstream re-checks at the object level, and what is **not**
established is the organization-scoped surface — the tools that read organization
data with no project in the question. A guest switched into the host organization
would meet those with a tie and no role. That is wider than the bug being fixed.

That is an authorization widening, and it cannot be settled by reading: it needs
exercising against a real guest, which is how the oRPC version of this was found
in the first place ("observed against a real guest, refusing every weave call
their own dashboard made").

**So the decision is recorded rather than taken:** the protocol servers hold to
strict membership, which is the conservative direction. The cost is not a lockout
but an ASYMMETRY — the guest reads through the ignored-argument gap and is refused
on write, and the refusal used to hand them an instruction they could not carry
out, since `fabric_switch_organization` holds them to membership. That message now
only offers the switch to a caller who can take it. Changing the checks themselves
is gated on auditing the organization-scoped gateway tools for role checks, not on
anyone's opinion about ties.

## FR8's archive requirement versus a job that deletes

Also raised in review, and worth writing down even though the drop is now
cancelled. The card requires source data to be "retained in a restorable archive
for a 90-day retention window" and permits no permanent deletion without
sign-off. The job has no export or archive step: it deletes rows, storage objects
and vector points outright.

With the drop closed as not applicable this is moot in practice, and the
`--apply` flag still ships, so it is not moot in principle. Two things reduce it:
the job is dry-run by default, and its one irreversible step that also suspends a
tamper-evidence trigger now takes a second switch of its own (`--drop-audit`).
Neither is an archive. **If the drop is ever reopened, FR8 is a prerequisite, not
a footnote** — and the ruling that nothing is dropped belongs on the card, which
still carries the 2026-08-25 question as its last word.

## The data side closes as not applicable

**Ruled 2026-08-31.** The drop, the backfill, the key revocation and the user
notification are all skipped, and the production inventory is not a gate.

The reason is one fact that moots the rest: **there is no production
population.** Every number this plan reasons about — 69 users, 36 of them
returning only at next sign-in, 375,532 rows, 94 objects — is staging. Staging
data is disposable, so the ordering argument that made the backfill matter has
nothing to order: nobody is stranded by a drop that takes rows nobody owns.

What each skip costs, stated plainly so a later reader does not have to
reconstruct it:

- **No drop.** The rows stay. This is the recorded position that "personal
  context is eliminated" describes the code and not the data — reachability is
  gone, the encoding is not. That is now the permanent state rather than a
  temporary one, and the residual is staging rows plus whatever a future
  production deployment never accumulates, because personal context cannot be
  entered on this branch.
- **No backfill.** It existed only to give accounts somewhere to land before the
  drop took their rows. With no drop it has no purpose; the sign-in heal returns
  to being the mechanism rather than the safety net, which is what it was
  written as.
- **No key revocation.** The consent argument under PO-11 still holds in
  principle — a `fab_` key's disclosure would cost more than its issuer agreed
  to — but it is an argument about real credentials held by real people, and
  there are none. Reinstate this decision, as written above, if the product
  reaches production with keys issued before this branch.
- **Nobody is notified**, because there is nobody to notify. This closes the last
  open PO-11 consequence, and closes it by removing its subject rather than by
  assigning it.
- **No production inventory.** It was the one number still missing; it is now a
  number about a deployment that does not exist. Anyone reaching this plan
  looking for it should stop rather than go looking for database access.

**What would reopen all of this:** a production deployment carrying accounts
created before this branch. At that point the backfill runs before any drop, the
revocation decision above applies as written, and the inventory is worth taking
before either.

## The two PO-11 consequences, decided

PO-11 recorded two consequences as needing a named owner rather than a
disposition. Both are decided here so neither blocks the release; either can be
overruled by a product owner, and the reasoning is written down so overruling it
is cheap.

**1. Personal API keys: revoke at release. Do not re-issue.**

The mechanism already exists. What was outstanding was never resolution — a
`fab_` key resolves into an organization now — but consent: the key was issued
to reach one person's own rows, and afterwards it reaches everything its owner
may reach in an organization. That is not an escalation beyond the owner's own
rights, but it changes what the credential's *disclosure* would cost, decided on
their behalf.

Re-issuing preserves the widened scope under a new secret, which renames the
problem rather than solving it. Revoking makes the owner issue a new key
deliberately, and that deliberate act **is** the consent. The cost is a broken
integration for whoever holds one — real, but bounded, visible immediately, and
fixed in the time it takes to mint a key. The cost of the alternative is
invisible and unbounded.

Order: revoke at release, alongside the backfill, before the drop.

**2. Telling affected users: bundle with the drop, not with the release.**

At release nothing is deleted. The rows are unreachable — no personal route
survives, the session always carries an organization, and the API refuses an
explicit `organizationId: null` — but they are all still there, and someone
asking where their project went can be answered by hand. Announcing "your
content is going away" while it has not gone anywhere buys support load for a
state that is still reversible, and spends the user's attention on a warning
they cannot act on.

The notice belongs immediately before `--apply`, and it needs to name what goes:
on staging, 15 users with personal projects, 12 with agent tasks, 10 with chats,
21 with notifications. The production shape is the one number still missing, and
it is a prerequisite for writing the notice rather than for deciding to send it.

**Who sends it is the one part not decided here.** That is a product and support
call, not an engineering one — but it is now the only open question under PO-11,
rather than one of three.

## Sources / Research

- `docs/personal-context-surface-map.md` — every disposition now `approved`.
- `docs/plans/2026-08-27-001-feat-org-only-context-implementation-plan.md` — the
  prerequisites this continues from.
- Fizzy #1875 / Fabric Feature 552 — FR1, FR2a, FR5, FR6, FR9–FR11, UC1, UC2,
  UC4 are the requirements still open. The feature's drafting stage reads
  `PLACEHOLDER` rather than `PUBLISHED`.
