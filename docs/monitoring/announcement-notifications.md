# Notifying customers about a status announcement

The customer status page is pull-only: an announcement appears there, and nothing
tells anyone it did. This records the design for closing that, the three decisions
it needs, and why the obvious implementation is the wrong one.

- **Audience**: whoever picks this up
- **Owner**: Platform / SRE

## What exists today

- `notifyIncident` is a **deliberate no-op** — `skipped: true`,
  `skipReason: "in-app-incident-notifications-removed"`, zero rows. In-app *incident*
  notifications were removed on purpose (incidents live in the admin "Incident
  history" timeline). **Do not revive it.** Reversing that decision is not the same
  problem as notifying about an announcement.
- Only the weekly SEV-3 digest fires, one row **per Fabric admin**, never per-org.
- So a customer learns about an outage by choosing to visit the page.

The gap is specifically **push for human-authored, customer-safe announcements** —
which is the one thing on this surface that is already reviewed before it ships.

## Do NOT fan out inline from the publish procedure

The obvious implementation — loop over organizations inside
`publishStatusUpdateProcedure` — is wrong twice over:

1. **It scales with tenant count inside a request.** A deployment with thousands of
   orgs turns a human clicking "publish" into thousands of synchronous writes and a
   timeout. The announcement then may or may not exist depending on where it died.
2. **A retry re-sends.** Notifications cannot be recalled, so at-least-once delivery
   over a non-idempotent write is a customer-visible bug.

## The shape that works: a scheduled sweeper

Leave the publish path **completely untouched**. A scheduled workflow picks up
announcements that have not yet been notified and fans out in batches.

- **Publish stays a single row write.** No new failure mode on the path a human
  drives, and no change to a procedure that is already merged and tested.
- **Temporal owns the retries**, so a partial failure resumes instead of
  double-sending — the existing `project-service-alert-digest` and
  `status-page-poller` workflows are the precedent to copy, including how they are
  registered in `schedules.ts`.
- **Idempotence comes from the database, not from bookkeeping.** `Notification` has a
  partial unique index on `(userId, dedupeKey)` for unread+live rows
  (`notification_userId_dedupeKey_live_uq`). A key of
  `status-update:<id>:<revisionId>` makes a re-run a no-op at the storage layer,
  which is the only place it can be guaranteed.
- **Batch and log what was skipped.** Per the durable-work convention: observable,
  resumable, cancellable, and never silently truncating.

`createNotification` is the chokepoint that enforces recipient preferences — but a
scheduled sweeper **cannot** reach it. It lives in `@repo/api`, and neither
`@repo/database` nor `packages/temporal` depends on that package. Every existing
Temporal-driven writer (`project-service-alert-digest`, pm-conflict, agent-reply,
repo-integration, security-scan) writes `Notification` rows directly for the same
reason, re-implementing the preference check where one applies.

For this feature no check applies: `SYSTEM` is absent from `CATEGORY_TO_TOGGLE`
(`packages/database/prisma/queries/notification-preferences.ts`), which makes it
always-on and never suppressible. A direct write therefore bypasses no preference.
What it *does* bypass is `validatePayload` — see the correction below, which is where
that mattered.

## The three decisions this needs

These are product calls, not engineering ones. The mechanism above is neutral to all
three; each is a small change once chosen.

| Decision | Options | Note |
|---|---|---|
| **Audience** | org owners/admins · all members · per-user preference | Members multiplies volume by team size. Owners/admins matches how the existing digest targets. |
| **Impact threshold** | `CRITICAL` only · `MAJOR`+ · anything but `NONE` | `NONE` is informational and must never notify. Below `MAJOR` risks training people to ignore it. |
| **Channel** | in-app only · in-app + email | Email needs deliverability, unsubscribe and a sender identity. In-app first is the smaller, reversible step. |

## Ship it behind a flag — as a kill switch, not a rollout gate

`SYSTEM` is an always-on `NotificationCategory` — recipients **cannot** opt out of it.
That is defensible for "the platform is down" and indefensible for anything chattier,
so it is flag-gated. The flag defaults **on** in every deployed environment, though.

**An earlier revision of this document argued for default-off, and that was wrong.** The
reasoning was that a notification cannot be recalled, so enabling should be a deliberate
act. But publishing the announcement is *already* that deliberate act: it is admin-only,
human-authored, reviewed, and immediately visible to every customer on the public status
page. Gating the notification separately did not add a decision — it added a second
switch nobody would ever remember to flip, which is how a finished feature quietly never
ships. What the flag is genuinely for is stopping a misfire on the next tick without a
redeploy.

## What was checked before building (one finding corrected)

Three things were checked after the design above was written, and all three came back
favourably. There are no open engineering questions left; what remains is the three
product decisions.

**A migration IS needed — this claim was wrong.** The original text here said
`SYSTEM_INCIDENT` could be reused because an announcement "is an incident from the
customer's side". Reusing it would have written rows that no customer could see, for
two independent reasons on the read side:

- the bell list and the unread count exclude `INCIDENT_NOTIFICATION_TYPES` **unless**
  the dedupe key starts with `weekly-digest` (`procedures/list.ts`), so a
  `status-announcement:` key would never appear; and
- the row renderer lists `SYSTEM_INCIDENT` in `ADMIN_ONLY_NOTIFICATION_TYPES`, so a
  customer who did see one would get an "admin-only" toast instead of navigation.

Both rules are correct for incidents — those moved off the per-user inbox on purpose.
Widening either would bolt a second special case onto a filter that already carries
one. The shipped implementation adds a distinct `STATUS_ANNOUNCEMENT` type instead
(migration `20260807120000_add_status_announcement_notification_type`), which is in
neither set.

The payload was wrong for the same reason: `SYSTEM_INCIDENT` is registered against
`incidentNotificationBase`, which requires `incidentId`, a `sev1|sev2|sev3` severity
and a `summary`. An announcement has none of those, and a coerced `incidentId` would
have pointed at a `StatusUpdate` row no incident lookup can resolve.

**No "already notified" bookkeeping.** The sweeper can be stateless: scan a bounded
lookback window, attempt the writes, and let the partial unique index absorb repeats.
`project-service-alert-digest` already does exactly this — it treats a `P2002` as
"already sent" and moves on. The index is
`notification_userId_dedupeKey_live_uq` on `(userId, dedupeKey)` for unread+live rows;
a key of `status-announcement:<updateId>:<orgId>:<userId>` makes a re-run a no-op.

**Two corrections, both from defects found after this paragraph was written.** The
organization belongs in the key: without it, a person who is owner/admin of two
organizations was told in only one, because the row is org-scoped while the key was not.
And the index alone is NOT sufficient — it is `WHERE readAt IS NULL AND archivedAt IS
NULL`, so it stops constraining a row the moment the recipient opens the bell, which for
a five-minutely sweeper meant a fresh notification after every read. The sweeper now
checks existence explicitly, independent of read state, and keeps the index as a race
guard rather than as the mechanism.

**The provider→organization mapping belongs in the ACTIVITY, not the helper.**
Resolving `affectedProviderKeys` to affected orgs needs the integration-provider
registry, and `@repo/database` deliberately cannot import `@repo/observability`.
`packages/temporal` can. So the activity resolves recipients and passes explicit org
ids to the database helper — the same layering as `setAuditCounters` and
`setPrismaQueryObserver`. Do not add a registry dependency to `@repo/database` to
avoid this.

### Suggested v1 boundary

Platform-wide announcements (empty `affectedProviderKeys`) are the high-value case and
need no registry mapping at all — every org is a recipient, so page through them and
**report what was skipped** rather than silently truncating. (A cap was tried first and
does not work: see the paging note under "What shipped".) Provider-scoped
announcements can follow, reusing the same intersection `build-overview` already
computes for `providerIssues`.

## What shipped

The three product decisions above were taken as **documented, flag-gated defaults**
rather than left blocking: nothing sends until an operator sets the flag, so the
defaults are reversible config instead of an irreversible guess. Enabling it is the
decision; building it was not.

| Decision | v1 default |
|---|---|
| Audience | organization **owners/admins** (matches how the project digest targets) |
| Impact threshold | **`MAJOR` and `CRITICAL`**; `NONE`/`MINOR` notify no one |
| Channel | **in-app only** — no email sender identity or unsubscribe needed |

Scope is also limited to **platform-wide** announcements (empty
`affectedProviderKeys`), which need no registry mapping — every organization is a
recipient, reached by paging rather than by a cap.

`affectedComponentKeys` is deliberately **not** a scope filter, matching the status page
itself. `build-overview.ts` establishes the semantics: an empty `affectedProviderKeys`
*means* platform-wide ("a core-api outage is not provider scoped") and is shown to every
tenant, while a non-empty one is shown only to tenants that connected the provider.
`affectedComponentKeys` says which Fabric components to paint, not which tenants are
affected — every tenant shares core-api. So a component-scoped announcement with no
provider keys is platform-wide by definition, and notifying every organization about it
is correct rather than an oversight. Live announcements only
(`RESOLVED`/`COMPLETED` excluded), inside a 24-hour lookback so re-enabling the flag
cannot notify about week-old incidents.

| Piece | Location |
|---|---|
| Sweeper | `packages/database/prisma/queries/status-announcement-notifications.ts` |
| Activity | `packages/temporal/src/activities/monitoring/status-announcement-notifications.ts` |
| Workflow | `packages/temporal/src/workflows/monitoring/status-announcement-notifications.ts` |
| Schedule | `ensure-monitoring-schedules.ts` — `monitoring-status-announcement-notifications`, every 5 min, `overlap: SKIP` |
| Type + payload | `NotificationType.STATUS_ANNOUNCEMENT`; schema in `packages/api/modules/notifications/lib/payloads.ts` |
| Flag | `FABRIC_STATUS_ANNOUNCEMENT_NOTIFICATIONS_ENABLED`, **on** in every deployed environment; set `false` to stop delivery |

The schedule is registered unconditionally even though the flag is off, so turning the
flag on is the only step required. A flag whose workflow was never scheduled looks
enabled and does nothing — the failure mode the Alertmanager `errorRate` branch
shipped with.

### Proven by test, not by inspection

- Flag unset → not even a query runs, let alone a write.
- `NONE`/`MINOR` impact and `RESOLVED`/`COMPLETED` lifecycle notify no one.
- One row per (announcement, organization, recipient); a second run writes nothing.

  **Corrected after a post-ship review.** An earlier revision of this document said
  idempotence came from the `(userId, dedupeKey)` partial unique index alone. That was
  wrong, and the error mattered: the index is
  `WHERE readAt IS NULL AND archivedAt IS NULL`, so it stops constraining a row the
  moment the recipient opens the bell. For an event-driven writer that is harmless —
  the event happens once. This is a **sweeper**, re-attempting the same write every
  five minutes for as long as the announcement stays live, so a recipient who *read*
  the notification would have received a fresh one on every tick: up to 288 a day
  across the 24-hour lookback.

  The sweeper now checks existence per page with a read-state-independent query, served
  by the non-partial `@@index([userId, dedupeKey, createdAt])`. The unique index is
  kept as a race guard, not as the mechanism. This also removes most of the P2002
  round-trips the previous version spent on already-sent rows, so it is faster as well
  as correct.
- Each row is attributed to the recipient's **own** organization.
- Organizations are **paged through to exhaustion** (500 per page), not capped. A
  truncating cap was the first implementation and was wrong: with a stable `id asc`
  ordering and no stored resume point, every run re-processes the same first page and
  organizations past it are never notified at all. `organizationsDeferred` now only
  becomes non-zero if a runaway backstop of 250 pages trips, and then it carries the
  remaining count.
- Non-dedupe write failures are counted (`writeFailures`) and logged by the workflow
  rather than swallowed.
- The row is renderable and visible: the payload passes the real `validatePayload`,
  the type is absent from `INCIDENT_NOTIFICATION_TYPES`, and the link is stored
  context-relative so it resolves to the recipient's own workspace.
- Dropping the schedule registration fails `ensure-monitoring-schedules.test.ts`.

### Deliberately NOT a runtime-toggleable flag

`FEATURE_FLAG_REGISTRY` (`packages/utils/lib/feature-flag-registry.ts`) is the registry of
flags a platform admin can flip from the admin UI, and its own header says registering one
there "is the deliberate act of declaring it safe to toggle at runtime". This flag is
**not** registered.

The reason is the same one that keeps prod off: a UI toggle would let any platform admin
start irrecoverable customer notifications with one click, bypassing the pipeline gate that
records *why* prod is off. Keeping it pipeline-only makes enabling prod a reviewable diff.

The flag is read through `parseOptInFlag`, the repo's canonical opt-in reader, so
`true`/`1`/`on`/`yes` all enable it. A stricter `=== "true"` reader was the first
implementation and was worse: an operator setting `=1` would have got a sweeper that looked
enabled and did nothing — the same failure this feature's unconditional schedule
registration exists to prevent.

### Known boundaries of the 24-hour lookback

Two consequences of keying the scan on the announcement's `startedAt`, both accepted for
v1 and neither previously written down:

- **An incident open longer than 24 hours stops being considered.** It stays visible on
  the status page; it simply stops generating new notifications. Anyone already notified
  is unaffected.
- **An organization created after the window closes is never notified** about that
  announcement, and neither is one the page backstop deferred on an earlier tick.

Both are the price of keeping the sweeper stateless. Fixing either properly means
tracking per-announcement coverage — the bookkeeping this design deliberately avoids,
and a schema change. So they are deliberate boundaries, now stated, rather than
oversights.

### Still open

- **Provider-scoped announcements.** A non-empty `affectedProviderKeys` is skipped in
  v1. The mapping belongs in the activity (which can import `@repo/observability`),
  reusing the intersection `build-overview` already computes for `providerIssues`.
- **Email.** Deliberately out of scope; needs deliverability, unsubscribe and a sender
  identity.
- **Not yet exercised against a real deployment** — the flag has never been switched
  on anywhere, so no notification has been produced end to end.
