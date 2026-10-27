# Decision Replay analytics

- **Audience**: Databricks operators and Fabric embedding implementers
- **Owner**: Platform team

This manually deployed bundle derives project analytics from the Decision Replay
feed without AI calls or free text. It creates a refresh job, six gold Delta
tables and a four-page AI/BI dashboard: Decisions over time, Review latency,
AI ratings, and Duplicates. Fabric serves Needs review natively. The
`projects.decisionReplay` API checks project read permission and the owning
organization's `DECISION_REPLAY` flag before serving data or minting a viewer
token with that project's id as `external_value`.

### Colors

The dashboard manually follows [Fabric's theme tokens](../../../tooling/tailwind/theme.css)
and the semantic segments in [AIOutcomes.tsx](../../../apps/web/modules/saas/projects/components/usage/AIOutcomes.tsx).
Update the dashboard by hand if either source changes; nothing syncs these colors.
Canvas, widget, border and text use `--background`, `--card`, `--border` and
`--foreground` respectively: light `#ffffff` / `#ffffff` / `#e5e5e5` / `#0d0d0d`,
dark `#1c1c1c` / `#222222` / `#2e2e2e` / `#ececec`. Selection uses Fabric's brand ink
(`--primary-ink`: `#b30000` light, `#ff8577` dark), distinct from neutral text,
with 7.20:1 and 6.72:1 contrast against the respective cards. Counters inherit text.

Lakeview shares one opaque chart palette across both modes. These variants keep
the source token's HSL hue and saturation, changing only lightness (L, rounded to
8-bit RGB). The native Not selected 35%/20% and Rejected 95%/70% opacity treatments
cannot be reproduced with one shared hex; the chart preserves their semantic hue.
WCAG 2.x relative-luminance ratios below use white and charcoal cards, respectively;
tests check the unrounded ratios against 3:1.

| Color | Source token and HSL L adjustment | Light `#ffffff` | Dark `#222222` |
| --- | --- | ---: | ---: |
| `#737373` | Light `--primary` `#0d0d0d`, 5.10% → 45% | 4.74:1 | 3.36:1 |
| `#258850` | Light `--success` `#1d6b3f`, 26.67% → 34% | 4.45:1 | 3.57:1 |
| `#a26f15` | Light `--highlight` `#8a5e12`, 30.59% → 36% | 4.36:1 | 3.65:1 |
| `#db3329` | Light `--destructive` `#b3261e`, 40.98% → 51% | 4.65:1 | 3.42:1 |
| `#949494` | Light `--muted` `#f4f4f4`, 95.69% → 58%; light `--muted-foreground` `#5d5d5d`, 36.47% → 58% | 3.03:1 | 5.24:1 |

The first four rows are the ordered palette: neutral, green, ochre, red.
The daily line's Proposed and Applied series take the first two entries.
Change outcomes are pinned by `outcome`: Applied → success, Not selected → highlight,
Already on roadmap → primary, Rejected → destructive, Failed / In progress →
muted-foreground, and Pending / Superseded → muted. Proposal statuses are pinned
by `final_outcome`: Applied → success, Approved → primary, Rejected → destructive,
Failed / Applying → muted-foreground, and Pending / Superseded / Unknown → muted.
The mappings use the table's shared variants, including light-source green for Applied.
There are two deliberate neutral levels: primary uses the darker `#737373`, while
muted and muted-foreground share the lighter `#949494`. Their mutual contrast is
1.56:1; both still exceed 3:1 against either card. Failed, In progress, Pending and
Superseded share that lighter grey, as do Applying and Unknown in proposal statuses.
Retain category labels and legends: the greys have limited separation, and color
alone does not distinguish states that share a grey.

## Prerequisites

1. Configure capture and the Lakebase CDF feed using the canonical
   [Decision Replay deployment guide](../../../docs/deployment/DATABRICKS.md#5-decision-replay-change-feed).
   The destination must contain `lb_decision_event_history`, including its CDF
   metadata. Do not point this job at an old `_1`-suffixed destination.
2. Use a current Databricks CLI supporting bundle dashboard `dataset_catalog`
   and `dataset_schema` (at least 0.281.0; current 1.x recommended), Unity Catalog,
   serverless SQL notebooks, SQL notebook parameter markers, and SQL session
   variables / `EXECUTE IMMEDIATE`. Use serverless environment version 5 or later
   (Databricks Runtime 18.0+) for parameter markers in CTAS.
3. Provision the destination catalog/schema and a small serverless SQL warehouse
   for dashboard reads. Set a short warehouse auto-stop interval. The refresh job
   runs on serverless jobs compute, independently of that warehouse.
4. The deployment/job identity needs workspace resource creation rights,
   `USE CATALOG`, `USE SCHEMA`, `SELECT` on the monitored history table and
   `CREATE TABLE` in the destination schema. It must own/manage the derived
   tables to replace them and grant their `SELECT` privileges. Use a durable
   operator/service identity distinct from the embedding principal. Restrict the
   `/Workspace/decision-replay` artifact folder to deployment operators/admins;
   do not inherit write access from a broadly shared folder. Jobs run as
   the deployer unless an operator explicitly configures `run_as`.
5. A workspace admin enables **embedding for external users** and adds Fabric's
   exact domain to the embedding allowlist. Register Fabric's service principal
   in the workspace/metastore. Keep its application id and secret in Fabric's
   secret store, for example under `example_embed_application_id` and
   `example_embed_client_secret`. These are placeholder secret names, not
   application environment variable contracts. Configure the separate
   `DECISION_REPLAY_*` Vercel variables documented in
   [environment variables](../../../docs/deployment/ENVIRONMENT-VARIABLES.md).
   Do not put credentials in this
   bundle, dashboard, CLI arguments or tracked override files.
6. Give the embedding principal `USE CATALOG`, `USE SCHEMA` and warehouse
   `CAN_USE` separately. The bundle grants dashboard `CAN_RUN`; the job's third
   task (`03_grants.sql`) grants `SELECT` on exactly the six gold tables. Do not
   grant it history/current access, inherited schema/catalog `SELECT`, or the job
   operator's privileges.
   The bundle does not revoke pre-existing/inherited grants: audit these during
   setup. Gold reads span projects at the publisher identity; every dashboard
   dataset's project predicate is therefore mandatory.

## Configure and deploy

No host is stored in the bundle. Choose the CLI profile for the intended
workspace; it supplies the host and authentication. The `staging` and `prod`
targets intentionally omit mode presets: trigger state and concurrency are
explicit, resource names have a target suffix, and state paths are separated by
target. This avoids development-mode trigger/concurrency overrides and the
additional identity/permission requirements of production-mode validation while
allowing host selection entirely through the CLI profile.

All defaults are deliberately synthetic and must be overridden. Set these in
the operator's environment (or untracked per-target
`.databricks/bundle/<target>/variable-overrides.json`):

```bash
export BUNDLE_VAR_catalog=example_catalog
export BUNDLE_VAR_schema=example_schema
export BUNDLE_VAR_warehouse_id=example_warehouse
export BUNDLE_VAR_embed_principal=example_embed_principal
export BUNDLE_VAR_fabric_base_url=https://example.com
cd deployment/databricks/decision-replay
```

Replace the examples with each environment's values outside version control.
The CLI reads only the `BUNDLE_VAR_` prefix; a misspelled prefix is ignored
silently and the job then targets the `example_*` defaults. Confirm the resolved
values with `databricks bundle validate -t <target> -o json` before deploying.
`embed_principal` is the service principal's **application id**, not its display
name or object id. `fabric_base_url` is the Fabric origin without a trailing slash.
Use separate destination schemas for staging and prod, even in a shared workspace.

Run these commands as the operator; they contact the selected workspace:

```bash
# After setting staging's variable overrides:
databricks bundle validate --strict -t staging --profile example_staging
databricks bundle deploy -t staging --profile example_staging
databricks bundle run decision_replay_refresh -t staging --profile example_staging

# After replacing the overrides with prod's values:
databricks bundle validate --strict -t prod --profile example_prod
databricks bundle deploy -t prod --profile example_prod
databricks bundle run decision_replay_refresh -t prod --profile example_prod
```

Run once after initial deployment rather than waiting for the next scheduled
run. Verify all tasks and table metrics, preview every page with a
synthetic project scope, and publish the dashboard in the workspace. Deployment
creates/updates the draft; publishing is a separate operator step. Configure
publication with the gold-only embedding principal as publisher, using that
principal's data credentials, so it cannot read history/current. Obtain the
dashboard id from bundle summary, then use the workspace publication flow or
`databricks lakeview publish <dashboard-id> --warehouse-id <warehouse-id>` under
that identity. Republish after dashboard changes and verify the external embed
with two different accessible projects before enabling it in Fabric.

All seven dataset queries use bare gold table names; the dashboard resource binds
their default catalog/schema. Each has the literal predicate
`WHERE project_id = __aibi_external_value`, which uses the token's external
value rather than an editable dashboard parameter. Do not replace it with a
filter widget or a client-controlled value. Use an opaque non-personal
`external_viewer_id` for audit attribution. See the
[external embedding contract](https://docs.databricks.com/aws/en/dashboards/share/embedding/external-embed).
`uiSettings.genieSpace` is disabled (`isEnabled: false`,
`enablementMode: DISABLED`), with no space id. External embedding does not support
Ask Genie.

## Refresh, ordering and metrics

The three tasks run in order: full current-state replacement, full gold
replacement, then grants. Each statement reads a consistent Delta table snapshot.
Gold statements read the fixed current table from step 1; they do not chase new
history rows during the run. Replacement is atomic per table, **not** across all
six tables. A failed run can leave mixed refresh versions; repair and rerun the
whole job before relying on the dashboard. `max_concurrent_runs: 1` prevents
competing refreshes.

The feed **replaces** history on re-snapshot. The visible table is therefore the
latest generation; no synthetic generation marker or saved offset is needed.
Step 1 excludes `update_preimage`, ranks each id by descending `_sort_by`, then
`_pg_lsn`, and excludes a winning `delete`. Exact position ties prefer delete,
then postimage, then insert. It preserves NULL redactions without coalescing
older non-NULL values. `_pg_xid = 0` marks snapshot inserts, not the newest state;
filtering to those rows would lose later updates and deletes.

Example: generation A has event E at sort 900, then a redaction at 901. A schema
change replaces A with generation B: E is now an insert at sort 950, xid 0, already
redacted. A new event F arrives at sort 951, then E is deleted at sort 952. Only B's
rows exist. Full ranking removes E and retains F; neither A's 901 nor an offset
checkpoint can influence the result. A removed event absent from B cannot be
resurrected. Do not union generations or retain incremental state. A re-snapshot
observed on 2026-10-25 continued `_sort_by` from the previous generation rather
than restarting it; the ranking does not depend on either behavior.

| Gold table | Meaning |
| --- | --- |
| `change_outcomes` | One covered proposal × offered index, with stored index (nullable for unselected sidebar entries), source, current outcome and decision time. No actor ids. |
| `suggestion_journey` | One observed proposal, including proposals first seen in a status change. Covered change offered/selected/not-selected counts and a partly-applied flag; first captured proposal/review/application times; latest internal `final_status` by event time then event id and user-facing `final_outcome`; distinct applied change indices and created entity ids; distinct created stories edited after their creation; first such edit; review latency in seconds. All joins include organization and project. |
| `project_decision_daily` | Change outcome counts (`change_applied`, `change_already_on_roadmap`, `change_not_selected`, `change_failed`, `change_in_progress`, `change_rejected`, `change_superseded`, `change_pending`), `change_accepted`/`change_decided` numerator/denominator, and UTC event-day distinct proposal counts per metric (a retry can count again on a different day), approximate median first review latency on review day, and first-application-day cohort edit share. The denominator includes only applied proposals with a full seven-day observation window as of refresh; no eligible proposals yields NULL. |
| `needs_review` | Latest status PENDING only, ranked oldest first, then larger change count and proposal id. Age in the table is as of refresh; Fabric reads its native queue from live proposals. |
| `duplicate_outcomes` | One latest state per observed duplicate link, aggregated by outcome and available attribution. Feature/model/prompt stay NULL because the capture contract omits them. |
| `rating_outcomes` | Counts `rated`, `re_rated`, and `rating_cleared` events by feature/model/prompt and outcome, with a separate transition type. These are events, not current votes; the export has no stable rating-row id. Organization-wide ratings with NULL project are excluded. |

`approved` means **accepted by a person (approved or applied)**: a human
`status_changed` into APPROVED, APPLYING or APPLIED, from any state. System
completion alone does not count as acceptance; it still counts in `applied`.
`rejected` counts transitions into REJECTED or BACKLOG by any actor. BACKLOG is
the app's recoverable **Move to Rejected**; REJECTED is permanent rejection.
A proposal counts once per project/day/metric, including multiple acceptance
transitions on the same day; later acceptance of a BACKLOG proposal counts on
that later day. These metrics are not mutually exclusive.

Known limits of these definitions:

- Review latency includes AI Update sidebar applies, which the person claims
  moments after the proposal is created, so they pull the median toward zero.
  The proposal source is only in the event `payload`; `suggestion_journey`
  does not carry it. Fabric's native summary excludes sidebar proposals and
  uses an exact median; this dashboard retains the gold latency definition.
- During an app rollout, a proposal the previous version dispatched straight
  from PENDING reaches APPLIED or FAILED as a system change, and a later
  dedup-only retry from FAILED to APPLIED is also a system change; neither
  counts in `approved`.
- Sidebar direct-apply proposals (ids starting `backlog-apply-op-`) captured
  before migration `20261025090000_decision_replay_apply_op_ids` have NULL
  subject and related ids. They cannot be relinked, including by a re-snapshot,
  so they are absent from `suggestion_journey` and the proposal counts.

The dashboard's **Statuses** dataset groups `final_outcome`: PENDING → Pending,
APPROVED → Approved, APPLYING → Applying, APPLIED → Applied, REJECTED or BACKLOG
→ Rejected, FAILED → Failed, SUPERSEDED → Superseded, and other/NULL → Unknown.
`final_status` retains the internal state. `needs_review` selects only
`final_status = 'PENDING'`, so recoverable rejected proposals are not in that queue.

Story edit counts cover all actor kinds, including human, AI, system and unknown;
they measure subsequent semantic edits, not solely human corrections. Seven-day
edit windows start at first APPLIED status and include the seventh-day boundary.
Partial capture has NULL proposal/review times, not fabricated latency. Equal
event timestamps have only an event-id tie break; the export does not encode
source transaction order for those business events.

Proposal links use `/app/projects/<project-id>?tab=stories&proposal=<proposal-id>`.
The existing account catch-all redirects into the viewer's active organization
and preserves the query. `StoriesRoadmap` consumes `proposal` to open that exact
proposal. The export has organization ids but no slugs, so links require the
correct active organization; switch organizations in Fabric if necessary. This
bundle adds no new app route or personal tenancy branch.

## Change-level outcome rules

Coverage starts at each project's first `proposal_reviewed` event. Decisions before
that time are excluded. Covered proposals contribute changes with a complete
review, or their `changeCount` when rejected (REJECTED/BACKLOG) without any review.
Incomplete sidebar reviews stay in proposal metrics but contribute no change
counts. An unreviewed open proposal has no change-level rows. Missing entry events
cannot reconstruct a complete offered list; only captured entries are counted.

Each (proposal, offered index) gets the first matching outcome:

1. **Applied**: an application exists for its stored index.
2. **Already on roadmap**: a deduplication exists for its stored index.
3. **Not selected**: omitted in the latest non-recommendation review. For a
   recommendation batch with at least one recorded review, never selected in any
   review and the latest status is APPLIED, REJECTED or BACKLOG. A batch rejected
   without any review falls through to Rejected. Unchosen items in an open batch
   remain Pending.
4. **Failed**: selected in the latest review, unresolved, latest status FAILED.
5. **In progress**: selected, unresolved, latest status APPROVED/APPLYING.
6. **Rejected**: unresolved by the earlier rules, latest status REJECTED/BACKLOG.
   This includes all `changeCount` entries of a rejection without a review.
7. **Superseded**: unresolved, latest status SUPERSEDED.
8. **Pending**: anything remaining.

The stored index links applications/deduplications; the offered index identifies
rows. They differ for sidebar reviews: unselected entries have no stored index,
and selected entries use positions in the stored approved-only list. Ties use
event time then event id. Recommendation selection history spans review rounds.

Change acceptance reports **accepted / decided**, plus its fractional rate:
accepted = Applied + Failed + In progress; decided = accepted + Not selected +
Rejected. Already on roadmap, Pending and Superseded are outside the denominator.
No denominator gives a null rate. **Partly applied** means latest status APPLIED
and at least one covered change has outcome Not selected. It is a subset of
applied proposals; it does not change the operational status. In native periods
it follows the existing proposal creation cohort, as proposal outcomes do, but
status and outcomes both come from that period's snapshot. Gold journey `offered`
is the number of covered outcome rows; `not_selected` counts Not selected rows;
`selected` counts Applied, Already on roadmap, Failed and In progress rows. These
are outcome counts across review rounds, rather than counters from one review.
Uncovered proposals have zero for these change-level journey counts.

Native change metrics evaluate captured events before each period's end, then
count outcomes whose decision time is in that half-open rolling window. Selected
and non-recommendation not-selected changes use the review time (the latest
selecting review for an application/deduplication, latest review otherwise; if a
rejected proposal has resolutions but no recorded review, the resolution event is
the available time); unresolved rejection and supersession use the status event.
For never-selected recommendations, the closure
status event decides Not selected and supplies its timestamp. Non-recommendation
Not selected retains the review time. Gold evaluates the current captured state
at refresh and groups the same outcomes by UTC decision
day. **Summing daily counts is not the same as the native period metric**: later
reviews, retries and closure can revise the current gold outcome of an earlier
day, while native previous periods evaluate only events before their end. Counts
can differ from proposal metrics when capture is incomplete.

## Native API contract

The project read procedures accept `projectId` without an organization input.
`getSummary({ projectId, range })` uses `7d`, `30d` (default), `90d`, or `all`.
It returns live `waiting` and `oldestWaitingAt`, plus `current` and `previous`
periods (`previous: null` for `all`). Rolling periods are half-open UTC windows.
The summary also returns `changeCoverageStartedAt` (null before review recording).
Each period adds `changeOutcomes` (the eight outcome keys), `changeAcceptance: { accepted, decided, rate }`, and `partlyApplied`, while retaining `acceptance: { accepted, decided, rate }`,
`medianReviewSeconds`, `keptAsApplied: { kept, mature, rate }`, and
`outcomes: { applied, rejected, pending, other }`. Rates are fractions or null
with no denominator; medians are null without observations.

Acceptance selects the latest qualifying decision per proposal within each
period (event time, then id): human APPROVED/APPLYING/APPLIED versus
REJECTED/BACKLOG by any actor. Review latency uses the first captured human
transition when a proposed event exists, excludes sidebar proposals, and
ignores negative latency. Kept cohorts start at first APPLIED, mature after
seven days, and count related story edits through the inclusive seventh day.
Outcomes group live statuses by proposal creation time, independently of the
event-based metrics. Capture gaps can therefore produce different denominators.
Native kept-as-applied counts any story edit linked to the proposal within
7 days of first APPLIED, while the gold SQL also requires the story's create
event; they differ only when the application event was not captured (capture
enabled mid-apply).

`listNeedsReview({ projectId, limit = 5 })` returns `{ items, total }`, with
1–100 items ordered by creation time then id. Items contain only `id`, `summary`,
`source`, `changeCount`, and `createdAt`. `getProposalTimeline({ projectId,
proposalId })` returns `{ events, truncated }`: the latest 200 captured events
by event time then id, presented oldest first, including related applications
and edits; `truncated` is true when older events were omitted. Event fields are
`occurredAt`, `eventType`,
`fromState`, `toState`, `actorKind`, `actorName`, `subjectType`, `changeIndex`,
`action`, and `createdEntityType`. Missing names and application fields are null;
actor names require current organization membership. Empty history returns
`{ events: [], truncated: false }`.

`getEmbedToken({ projectId })` returns `{ available: false, reason }` for
`not_configured` or `unavailable`, or `{ available: true, token, expiresAt,
instanceUrl, workspaceId, dashboardId }`. The expiry is an ISO timestamp.
The service caches the embedding principal's all-apis token per process and
mints a scoped token per request. Viewer ids are HMAC-derived without raw
user identifiers. Minting is a read with no Fabric state mutation, so it emits
no mutation audit action. HTTP errors log status without response bodies.
Live external embedding remains an operator verification step.

## Pause, cost and erasure

Set `resources.jobs.decision_replay_refresh.schedule.pause_status: PAUSED` in the
job resource and redeploy the selected target to pause automatic runs. Restore
`UNPAUSED` and redeploy to resume. A pause does not cancel an active run or block
manual runs. Run a full refresh after resuming, especially following erasure.

Automatic refreshes run on a fixed schedule in `America/Phoenix` time, which
has no daylight saving. By default prod runs four times a day, every 6 hours
from midnight (00:00, 06:00, 12:00 and 18:00, which is 07:00, 13:00, 19:00 and
01:00 UTC the next day), and staging runs once a day at midnight (07:00 UTC).
The `refresh_schedule` bundle variable holds the Quartz cron expression;
`databricks.yml` sets the default and the staging override. Like any bundle
variable, a `BUNDLE_VAR_refresh_schedule` export or a `variable-overrides.json`
entry replaces it, so check the resolved `schedule` in the `bundle validate`
output before deploying. A run starts whether or not the history table changed,
so an unchanged feed still costs a refresh. When runs succeed on time, gold
tables and the dashboard trail the feed by up to one schedule interval (6 hours
on prod, a day on staging); a failed, paused or delayed run, plus feed and job
latency, adds to that. The
[STANDARD serverless performance mode](https://docs.databricks.com/aws/en/jobs/run-serverless-jobs#select-a-performance-mode)
reduces compute consumption at the cost of startup latency. SQL source notebooks
avoid a separate warehouse start for each refresh; the warehouse is used only
for dashboard queries. Actual cheapest compute depends on volume and workspace
pricing; measure before resizing. Full scans grow with retained history. Manual
runs/retries and dashboard queries add cost independently of the schedule.
Cohort maturity metrics are recomputed by each successful refresh, including
refreshes where the history table did not change.

Every successful run rebuilds current and gold state, so source deletes and
actor redactions propagate without an offset watermark. Gold tables omit actor
ids entirely. Propagation waits for the feed and the next successful scheduled
run plus job latency; it is not immediate. Raw history still holds earlier
images until the canonical
[clean restart procedure](../../../docs/deployment/DATABRICKS.md#clean-restart-and-schema-evolution)
replaces it with current source rows. After that restart, run the job again and
refresh dashboard results. Delta time travel, retained files, query caches and
exports have their own retention controls; coordinate those with the erasure
operator. This bundle does not shorten retention or run `VACUUM`.

## Local checks and release decision

From the repository root:

```bash
node --test scripts/__tests__/check-decision-replay-dashboards.test.mjs
node --test scripts/__tests__/decision-replay-gold.test.mjs
node scripts/check-decision-replay-dashboards.mjs
```

`decision-replay-gold.test.mjs` executes the current and gold SQL in DuckDB as a
stand-in; functions outside its reviewed allowlist must be checked on Databricks.

The guard recursively parses all `deployment/databricks/**/*.lvdash.json` and
fails closed unless each dataset is one SELECT from a bare gold table with the
required project predicate. Only reviewed columns, expressions and aliases are
accepted, with explicit grouping, ordering and limit syntax. The readable outcome
CASE is matched including its literal keys and labels; unused change/journey
columns and wildcard projections on those tables and the daily table are rejected. It rejects
joins, subqueries, unions and extra predicates/statements. SQL comments (`--`
or `/*`) and carriage returns are forbidden outright; the guard does not emulate
Databricks comment lexing. Quoted identifiers and whitespace other than ASCII
spaces, tabs and newlines are also rejected. Color encodings may reference only
fields selected by their widget query. The Node tests also validate six-digit
theme/mapping hex values and chart contrast against both widget backgrounds.
Dataset keys are limited to `name`,
`displayName` and `queryLines`; unknown keys (including catalog/schema overrides)
fail. The dashboard
must explicitly set `uiSettings.genieSpace.isEnabled` to `false` and
`enablementMode` to `DISABLED`. Supporting a new SQL shape requires extending
its tests. Code Quality runs the guard and its tests on PRs, including
deployment-only changes.

Release decision: **`fabric-app: patch`**. Although operators deploy this bundle
manually and it does not enter an application image, it creates production
analytics resources and grants with user-visible behavior. The repository's
deployment changeset rule therefore applies.
