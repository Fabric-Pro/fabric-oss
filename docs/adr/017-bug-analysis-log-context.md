# ADR-017: Application-Log Context for Bug Analysis

- **Status**: Accepted (Fizzy #1234 FR4); **production rollout approved 2026-08-24**
- **Date**: 2026-08-19
- **Decided by**: Engineering team, 2026-08-19

## Production rollout decision (2026-08-24)

Following the security review's remediation — tenant-scoped shared-source queries, the
organization predicate, project-bound progress reads, and the shared-workspace opt-in —
the engineering admin approved the production rollout of the feature flag
(`FABRIC_FEATURE_BUG_ANALYSIS_LOG_CONTEXT=true` in every environment). This closes AC-4's
implementation gate.

Rollout posture in production:

- The feature flag is on; analyses may read logs when a project has a log source.
- The **shared** platform workspace opt-in
  (`FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE`) stays **off** in production.
  Production projects bring their own bound log source (per-project bindings); serving
  the platform workspace to production projects remains a separate, explicit operator
  decision with its own grant.
- The one-time Log Analytics Reader grant on the production workspace is made by the
  operator (the deploy service principal cannot create role assignments), keeping the
  shared-source path ready without enabling it.

## Decisions taken at acceptance

The four questions this ADR left open are answered here. Each records what was
chosen and what it costs, so a later reader can tell a decision from a default.

**1. Denylist or allowlist? Both, split by shape.** A log *message* is free text
that has to be readable to be useful, so it can only be denylisted. The
structured *properties* bag is different: it is keyed, it is where credentials
arrive in bulk, and it rarely carries what makes a root cause legible. So
properties are now **dropped by default** and an operator allowlists specific
keys with `FABRIC_BUG_ANALYSIS_LOG_PROPERTY_ALLOWLIST`; message text keeps the
value-shaped denylist. Policy is applied **before** redaction, so an excluded
key is never inspected or partially emitted. Cost: a real log field is invisible
until someone names it, which is the intended direction of failure.

**2. Mechanism: both ship, connector preferred.** A direct connector controls
the query, the projection and the bounds; MCP discovery is a capability probe
that already had to be narrowed after it would have accepted a connected Jira as
a log source. Named providers therefore win over MCP discovery, and MCP remains
the fallback for platforms with no connector. This is a preference, not a
lock-in: see the provider registry below.

**3. Who may trigger it: project admins.** Reading logs is gated on
`PROJECT_SETTINGS_EDIT`, which OWNER and PROJECT_ADMIN hold and EDITOR does not.
This is deliberately stricter than the surrounding analysis, which needs only
project access, because runtime logs are the most sensitive context source
Fabric handles. Resolved through `@repo/permissions` rather than by comparing
role names.

**4. Prompt injection: accepted, and shared.** A log line an attacker influences
reaches the prompt. This is identical in kind to Teams, Slack, Notion and
meeting-transcript context, all of which have the same exposure today with no
mitigation. Solving it for logs alone would buy little while four other sources
stay open. Recorded as a known, shared risk rather than a log-specific one.

### No vendor lock-in

Log platforms sit behind a **provider registry**
(`log-source-registry.ts`). A provider is an id, a label, and a function that
builds an adapter from its own configuration. `FABRIC_BUG_ANALYSIS_LOG_PROVIDER`
names one; with none named the first configured provider wins. Adding Grafana
Loki, Elastic, Datadog or a customer's own API means writing one file and adding
it to the list.

Azure Monitor is the first provider because Fabric's own telemetry already lands
there, which made verification possible at all. That is availability, not
preference: the port, the redaction layer, the property policy, the budget and
the prompt assembly never mention a vendor, and the deployment template passes
the workspace id in as provider configuration rather than baking it in.

## Context

Bug analysis in Fabric reasons only over what people wrote: Teams and Slack messages,
meeting transcripts, Notion pages, RAG context and architecture decisions. It cannot see
what the software actually did. Application logs are the most direct evidence a root-cause
analysis can have, and today none of it reaches the model.

The counterweight, raised when the request was first made, is that logs routinely carry
credentials and personal data. That makes this higher-risk than the rest of the bug-flow
work, and it is why Fizzy #1234 gates implementation on a documented feasibility
recommendation rather than letting the build start immediately.

This ADR is that recommendation. It is written alongside a working, flag-gated prototype so
the review has something to run rather than only something to read.

Two facts constrain the design and were verified in the codebase rather than assumed:

1. **The existing redactor cannot do this job.** `redactSensitiveKeys` matches on object
   KEYS and never inspects values — correct for audit metadata, which is a structured bag.
   A log line is mostly free text, so a bearer token sitting inside a log *message* has no
   key to match and would pass straight through.
2. **There is no per-bug "Analyze" button.** The card's UC1 describes one, but analysis is
   triggered backlog-wide from the AI Update panel
   (`startAnalysis` → `backlogContextAnalysisWorkflow`). Logs therefore attach as a context
   source on the existing workflow, which is what the card's own implementation-task list
   describes ("as an additional context source").

## Decision

> The sections below are the recommendation **as proposed**, kept because the reasoning is the
> record. Two parts were superseded at acceptance: a second adapter now ships and named
> providers take precedence over MCP discovery, and structured properties are dropped by
> default rather than denylisted. **Decisions taken at acceptance**, at the top, is what holds.

### 1. A log-source port, with MCP as the first adapter

Introduce a narrow internal interface (`LogSourceAdapter` in `@repo/ai/lib/log-context`) and
implement it once over the existing MCP client.

Everything security-relevant sits **above** the port: the feature gate, point-of-use
authorization, redaction, budgeting, the prompt clause and the graceful-degradation
outcome. The adapter below it does one thing — return raw entries.

This is what makes the recommendation reversible. If the review prefers a dedicated
connector, that is a new file implementing one interface; none of the redaction or scoping
code is rewritten, and none of its tests are invalidated.

MCP is the right *first* adapter because it inherits infrastructure that already exists and
is already audited: OAuth and encrypted credential storage on `MCPConfig`, the cached client
in `packages/mcp`, and the read-only dispatch gate. ADR-002 already settled the general
preference for vendor-hosted MCP servers over bespoke integrations.

### Alternatives considered

| | Port + MCP adapter (chosen) | MCP only, no port | Dedicated log connector |
|---|---|---|---|
| Reversibility after review | One new file | Rewrite the call path | Locked to one vendor |
| Reuses OAuth + encrypted credentials | Yes | Yes | No — new credential surface |
| Vendor coverage | Any server with a log tool | Same | One platform |
| Query precision | Whatever the tool exposes | Same | Best — Fabric writes the query |
| Redaction code affected by a mechanism change | None | Some | None |
| New dependencies | None | None | A vendor SDK |

The dedicated connector wins on query precision, and that is a real advantage — Fabric would
control the projection and could exclude sensitive columns at the source rather than
redacting them afterwards. It is the better *destination*. It is the wrong *first step*
while the mechanism is still undecided, because it spends a vendor commitment to buy
precision the prototype does not yet need.

### 2. Logs stay outside Fabric

Entries are pulled on demand, scoped to one analysis, used to build one prompt, and never
persisted. Fabric stores no log content, builds no log index and runs no ingestion pipeline.

This follows the precedent set when the audit-log explorer was built, where the team
deliberately declined to ingest application logs on both scale and sensitivity grounds and
preferred reaching into the client's own platform when needed. It also means the blast
radius of a redaction miss is one prompt, not a permanent store.

### 3. Redaction is value-shaped, layered, and fails closed

`@repo/utils/log-redaction` redacts by value shape — the only thing that works on free text:

| Class | Covered |
|---|---|
| Credentials | JWTs, `Bearer`/`Basic` headers, GitHub / Slack / AWS / Google key formats, PEM private-key blocks, `key=value` secrets in connection strings and query strings, passwords in URL userinfo |
| PII | Email addresses, US SSNs, Luhn-valid payment cards, public IPv4 |

Four rules make it defensible rather than merely present:

- **The `key = value` rule matches structure, and the shared denylist decides.**
  The first cut hand-rolled a keyword alternation anchored with `\b`. That leaked: in JavaScript
  `\b` never fires between two word characters, so `password=` was caught while
  `DB_PASSWORD=`, `AWS_SECRET_ACCESS_KEY=`, `dbPassword=` and `sessionToken=` — the shape a real
  environment variable or field name actually takes — all passed through untouched. The rule now
  captures whatever identifier precedes the `=`/`:` and asks the shared denylist about it, plus a
  small exact-match set for names too short to be safe substrings (`sig`, `auth`, `pwd`, `sas`,
  `accountkey`). Bare `key=` is deliberately excluded: in a log line it is nearly always a cache
  or partition key, and redacting every one would cost more than it buys.

- **The structured `properties` bag gets both treatments.** A sensitive KEY is redacted
  outright via the shared denylist; every surviving string value is *still* run through
  value-shaped redaction, because a benign key can carry a secret.
- **Private and loopback IP space is preserved.** It identifies nobody and tells you which
  container failed. Over-redaction is safe for secrets and actively harmful for debugging;
  the line is drawn at whether the value can identify a person.
- **Failure modes are asymmetric on purpose.** An entry that cannot be redacted is
  **dropped** (fail closed — nothing unredacted ever reaches the model). A log platform that
  cannot be reached is **skipped** (fail open — the analysis still runs, per the card's
  graceful-degradation requirement).

The denylist that `audit-log.ts` owned has moved to `@repo/utils/sensitive-keys` so both
redactors share one list. Two copies of a security list drift.

The model is also told, in the prompt section itself, that `[REDACTED]` means "a value was
removed here" — otherwise a root-cause analysis can report the placeholder as though it were
the logged value.

### 4. Access scoping for the prototype

- The feature flag `FABRIC_FEATURE_BUG_ANALYSIS_LOG_CONTEXT` is **off in every environment**,
  production included. With it off, no source is resolved, no platform is contacted, and the
  prompt is byte-for-byte unchanged.
- Project access is re-checked at the moment logs are read, not when the analysis was queued
  — the same point-of-use pattern as `getProjectFunctionTagClause`.
- Every dispatch goes through the worker-side read-only gate.
- The query is bounded on all four axes: time window, severity floor, entry count, and total
  characters.

Prototype defaults, offered as tunables rather than conclusions:

| Bound | Default | Why |
|---|---|---|
| Lookback | 24h | Long enough for an overnight report, short enough to stay relevant |
| Severity floor | `error` | Warnings and info swamp the budget without changing a diagnosis |
| Max entries | 50 | Bounded platform cost |
| Max characters | 12,000 | ~3k tokens of the analyzer's 80k budget |
| Per-entry message | 2,000 chars | One pathological entry cannot dominate |
| Per-property string | 2,000 chars | The platform is external; a property can carry a whole request body |
| Discovery budget | 20s total, 8s per server, 4 at a time | An unreachable MCP server costs ~45s on its own (15s timeout × 3 retries). Probing a tenant's servers one at a time could exceed the activity's 120s timeout, which Temporal would then retry — minutes of delay over an optional context source. Running out of discovery budget degrades to "not configured", which is a supported outcome. |

## Consequences

### What becomes easier
- Bug analysis can cite runtime evidence instead of inferring from prose.
- Any log platform with an MCP server works without Fabric-side vendor code.
- The redaction layer is pure and independently testable, so its guarantees do not depend on
  a live platform or on which mechanism wins.

### What becomes harder
- Log-platform MCP servers vary in tool naming and response shape. The adapter probes a
  candidate tool list and tolerates several response shapes; a platform outside that set
  needs a small addition.
- Redaction is a denylist. Denylists are never complete — see the open questions.

### Capability discovery only auto-accepts unambiguous tool names

Discovering a log source by capability probe has a failure mode that is easy to miss: the real
tool names on major log platforms are **not** log-specific. Sentry's is `search_issues`, which
is also what the Jira and GitHub MCP servers expose — and Atlassian's server is already an
adopted integration here (ADR-002). Azure Monitor's is `run_kql_query`, shared with Azure Data
Explorer, a general analytics database. `execute_query` belongs to any database server at all.

Auto-accepting those would let a tenant's connected **Jira** be queried as a log platform and
its issues rendered to the model under an "Application Logs" heading. That is not a data leak —
redaction still runs — but presenting issue text as runtime evidence is worse for a root-cause
analysis than having no logs, because the model has no way to know the heading is lying.

So the probe list contains only names that say "log", and the colliding vendor names require an
explicit operator opt-in via `FABRIC_BUG_ANALYSIS_LOG_TOOLS`. Naming a tool there is a
deliberate statement that on this deployment it queries logs.

This is the strongest argument in favour of the deferred per-project binding: an explicit
`Project` → log-source reference removes the guessing entirely, and with it this whole class of
mistake. A reviewer who dislikes the opt-in env var should read it as evidence for bringing the
binding forward rather than for widening the probe list.

### Known limitation: the query is scoped by the analysis prompt, not by a bug

This follows directly from there being no per-bug trigger. The analysis is backlog-wide, so
the only scope signal available when the logs are fetched is the user's own analysis prompt,
which is passed as the query terms. That is weaker than the card imagines: it says logs
should be "scoped to the bug's context", and a backlog-wide prompt is a coarser filter than a
single bug's title and symptoms.

The consequence is precision, not safety — the bounds and redaction apply either way. But it
does mean the evidence reaching the model is "recent errors matching roughly what the user
asked about" rather than "errors related to this specific defect". Tightening it means either
a per-bug entry point (a product decision, not a technical one) or a second per-item fetch
inside `reanalyzeBodyByKind`, which costs one log round-trip per work item per analysis.
Worth settling in the review.

### What is explicitly deferred
| Capability | Why deferred |
|---|---|
| Shared MCP tool-probe / result-parsing helper | The candidate-tool probe and the tolerant result parser in the log adapter duplicate the same pattern the Notion fetcher in `fetch-context.ts` already implements independently. Extracting a shared `findMcpTool` / `parseMcpToolResult` is the right move before a third fetcher copies it a third time, but it touches an unrelated shipped path and belongs in its own change. |
| Per-bug query scoping | See the limitation above — needs a product decision on the entry point. |
| Explicit per-project log-source binding on `Project` | The prototype discovers a source by capability probe. A stored binding (mirroring the PM-tool fields) is right once the mechanism is approved, and would let a project choose *which* source when several match. |
| Dedicated connector with Fabric-authored queries | The better destination; premature before sign-off. |
| Real-time log streaming UI | Out of scope per the card. |
| Per-role permission model for triggering log-backed analysis | Open question below. |

### Where the FR3 note does not reach the user

The note covers an analysis that **completed** — logs included, not configured, empty, or the
platform unreachable. It does not cover an analysis that died: a workflow ending in a hard
terminal state threw rather than returned, so the note lived in workflow state that no longer
exists and there is nothing to carry across. A user in that case gets a failure message
instead, which is the more actionable thing to show. Recorded here so the gap is a known
limitation rather than a latent surprise.

## Questions this ADR opened, and where they landed

All four were answered at acceptance; see **Decisions taken at acceptance** at the top. In
summary:

1. **Denylist versus allowlist** — split by shape. Properties allowlisted (dropped by default),
   message text denylisted.
2. **Who may trigger it** — project admins, via `PROJECT_SETTINGS_EDIT`.
3. **Recording redaction findings** — not done. The redaction count is logged and returned but
   not persisted. Worth revisiting if the security review wants an audit trail; note that such a
   trail is itself a record of where secrets were found.
4. **Are the bounds right** — unchanged for now, and still tunable. The severity floor is the
   one most likely to be wrong: excluding warnings keeps the prompt clean but may drop the entry
   that explains the failure. Running enabled in non-prod is how we find out.

## Resolution order

Three steps, each more explicit than the next:

1. **The project's own binding** — `Project.logSourceProvider` names a provider from the
   registry and `Project.logSourceConfig` holds that provider's settings. Deliberately generic:
   a new platform needs no migration. Neither column holds a credential; providers authenticate
   with the worker's own identity or an existing MCP config.
2. **The deployment's configured provider** — `FABRIC_BUG_ANALYSIS_LOG_PROVIDER` plus that
   provider's settings, which is what a project with no binding inherits — **only when the
   operator has opted that shared workspace in for analysis use** (see the amendment below);
   otherwise this step yields "not configured".
3. **MCP capability discovery** — the fallback, for platforms with no connector.

## Security-review amendment (2026-08-22): tenant-scoped shared sources

The post-acceptance security review of Fizzy #1234 found two isolation gaps and demanded both
be closed before production rollout. They are closed in PR #3109 and its follow-up; this
section is the ADR record of how access scoping now works, superseding the bare description
above wherever they differ.

- **Every log source declares whether its store outlives one tenant.**
  `LogSourceAdapter.sharedStore` is a required field: a deployment-wide platform workspace is
  `true`; a tenant's own connected MCP servers and a project-bound workspace are `false` by
  construction. The field is deliberately not defaulted, so a future provider must answer it.
- **A shared-store query cannot run without a server-derived organization scope.**
  The port refuses it (FR3 note, fail closed) and the Azure query builder throws if reached
  anyway; the predicate itself reads each row's custom dimensions —
  `tostring(Properties["organizationId"]) == "<org>"` — a value caller input never touches.
  Rows lacking the attribute do not match. Fabric telemetry does not yet systematically tag
  org ids, so until operators enrich telemetry the shared source returns few or no rows: the
  intended direction of failure.
- **Serving the deployment workspace is opt-in.**
  Scoping alone would make the environment-wide workspace live the moment telemetry gains org
  tags — isolation by absence of data rather than by decision. `fromEnvironment` therefore
  returns nothing unless `FABRIC_BUG_ANALYSIS_LOG_ALLOW_SHARED_WORKSPACE=true`. Without it,
  every project gets FR3's "not configured"; project bindings and MCP sources are unaffected.
- **A project binding may not name the deployment's own workspace.**
  Compared case-insensitively — ids are GUIDs — because the worker identity already holds read
  there; honouring such a binding would re-open the cross-tenant reads the predicate prevents.
- **The analysis tenant context comes from the verified project row.**
  `start-analysis` previously took `organizationId` from caller input or session via
  `resolveOrganizationId`, which honours a caller-supplied value verbatim — and that value
  scopes log queries and MCP config selection downstream.
- **Progress reads are bound to their project.**
  Workflow ids embed only projectId and a timestamp, so `analysis-progress` and
  `apply-progress` minted and validated through one helper that rejects any id not naming
  exactly the authorized project, before Temporal is contacted. Every plain-shape minter
  (start, apply, both channel monitors) goes through that helper; only the two retry
  minters (`retry-failed-proposal`, `retry-all-failed-proposals`) remain bespoke, and their
  id shapes are accepted by the same guard.

A project that names a provider gets that provider **or nothing**. It never falls through to the
deployment default, for the same reason an unknown provider name does not: reading logs from a
source nobody named is worse than reading none.

## Still open

- **A per-bug entry point.** The card describes an "Analyze" button on a bug ticket; analysis is
  backlog-wide and no such button exists. Adding one is a new user-facing flow and a product
  decision, not an implementation detail. Until it is made, the log query is scoped by the
  analysis prompt rather than by one defect — see the known limitation above.

## The Log Analytics grant is an operator step, not a template resource

Declaring the role assignment in the deployment template broke every infrastructure deploy on
2026-08-19. The deploy service principal does not hold
`Microsoft.Authorization/roleAssignments/write`, so ARM rejected the **whole** template — not
just this feature. Granting the SP that right means User Access Administrator, which would let
it assign any role in the resource group: far more power than this feature justifies, and the
estate owner's decision rather than a side effect of shipping a flag.

So the grant is run once per environment by somebody who already has the rights:

```
az role assignment create   --assignee-object-id <worker managed identity principalId>   --assignee-principal-type ServicePrincipal   --role "Log Analytics Reader"   --scope <log analytics workspace resource id>
```

Until it is run the connector receives a 403, which the feature already degrades to "logs were
not available" — the analysis still succeeds and the user is told why. No redeploy is needed
once the role lands.

The wider lesson, worth carrying to any similar feature: **a template resource that needs a
permission the deploy identity lacks does not fail closed for that feature, it fails the entire
deployment.** Feature flags gate behaviour, not the control-plane rights a template asks for.

## A note for whoever runs `prisma migrate dev` next

The migration for the binding was **hand-written**, and deliberately. `migrate dev` produced a
diff carrying pre-existing drift between the migration history and `schema.prisma` — index
renames on `pull_request_review`, `qa_sign_off` and `coding_run`, a duplicate `mcp_server` index
that failed to apply at all, and dropped defaults on `project_qa_settings` and
`test_case_work_item_link`. None of it belonged to this change.

That drift is unrelated to this feature and still there. Anyone generating a migration will meet
it, and should check what their diff actually contains before committing it. Reconciling it is
worth its own card.

## References

- Port and prompt clause: `packages/ai/lib/log-context.ts`
- Redaction: `packages/utils/lib/log-redaction.ts`, `packages/utils/lib/sensitive-keys.ts`
- MCP adapter: `packages/temporal/src/activities/backlog-context/fetch-application-logs.ts`
- Wiring: `packages/temporal/src/workflows/backlog-context-analysis-workflow.ts` (step 1f),
  `packages/temporal/src/activities/backlog-context/analyze-context.ts`
- Related: ADR-002 (vendor-hosted MCP servers), ADR-004 (project-level integrations),
  ADR-006 (audit log kept in a separate table)
