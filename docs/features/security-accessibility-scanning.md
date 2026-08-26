# Security & Accessibility Scanning

AI agents that scan a project's Fabric-held context for security vulnerabilities (OWASP Top 10) and accessibility issues (WCAG 2.1 AA), surfacing findings with severity, remediation, and rule attribution.

- **Audience**: Engineers working on project tooling, the scanning pipeline, or the Temporal worker
- **Owner**: Platform team
- **Status**: Implemented

## Overview

Every Fabric project has a **Security & Accessibility** page that runs two AI scanners over the project's own Fabric-held context — its features (user stories) and generated documents — and reports what it finds:

- A **security agent** evaluates the described designs against the **OWASP Top 10** plus any project-specific custom rules, and reports findings with a severity and concrete remediation guidance.
- An **accessibility agent** evaluates the described UI in feature documents against **WCAG 2.1 AA** plus custom rules.

Findings are advisory by default (a *soft warning* that never blocks work), grouped by severity, each attributed to the rule set that produced it. A clean scan is confirmed explicitly with a timestamp.

### Acceptance criteria mapping

| # | Criterion | Where it lives |
|---|-----------|----------------|
| AC1 | Security agent scans and surfaces findings with severity + remediation | `runSecurityScanActivity`, `ScanFinding` |
| AC2 | Accessibility agent checks described UI in feature docs against WCAG 2.1 AA | `runAccessibilityScanActivity`, `getProjectScanContent` (documents) |
| AC3 | Custom rules applied and attributed to their source rule set | `ProjectScanConfig.customRules`, `ScanFinding.ruleSource` / `isCustomRule` |
| AC4 | Clean-scan confirmation with timestamp | `CleanScanCard`, `ProjectScan.completedAt` |
| AC5 | Soft-warning default; non-blocking unless enforcement is escalated | `ScanEnforcementMode.WARN` default |

## Architecture

The scan is a Temporal workflow on the general-purpose `fabric-worker` queue. The API creates a `ProjectScan` row and dispatches the workflow; the workflow sequences activities; all side effects (DB writes, LLM calls, notifications) live in activities so the workflow stays deterministic and replay-safe.

```
Trigger (manual | maturation gate)
   │
   ▼
startProjectScan ──► create ProjectScan (PENDING) ──► start workflow on `fabric-worker`
                                                          │
                                                          ▼
   securityAccessibilityScanWorkflow
     markScanRunningActivity            (PENDING → RUNNING)
     gatherScanContextActivity          (assemble Fabric-held content + custom rules)
     ├─ runSecurityScanActivity        ─┐  (LLM, OWASP + custom)   run in parallel
     └─ runAccessibilityScanActivity   ─┘  (LLM, WCAG + custom)
     persistScanResultsActivity         (write ScanFinding rows, counts, telemetry → COMPLETED)
        └─ emit SECURITY_SCAN_COMPLETED notification
   (any throw) ──► failScanActivity      (→ FAILED, error recorded)
```

### Data model

Three Prisma models in `packages/database/prisma/schema.prisma`, all multi-tenant (`userId` + nullable `organizationId`) and protected by the `user_owned` RLS policy.

**`ProjectScanConfig`** — 1:1 with `Project`. Holds per-project settings and the custom rule sets.

| Field | Type | Notes |
|-------|------|-------|
| `securityEnabled` / `accessibilityEnabled` | `Boolean` | Which scanners run (default `true`) |
| `enforcementMode` | `ScanEnforcementMode` | `WARN` (default) or `BLOCK` |
| `autoScanOnMaturation` | `Boolean` | Auto-trigger at the maturation gate (default `true`) |
| `maturationGate` | `FeatureDraftingStage` | Stage that triggers an auto-scan (default `PUBLISHED`) |
| `customRules` | `Json?` | Array of custom rules (see below) |

**`ProjectScan`** — one scan run. Carries status, trigger, target type, per-category finding counts, and run telemetry (`modelName`, `inputTokens`, `outputTokens`, `costUsd`, `durationMs`, `workflowId`, `startedAt`, `completedAt`, `error`). Indexed on `(projectId, createdAt desc)`, `storyId`, `status`.

**`ScanFinding`** — one finding. Carries `category`, `severity`, `title`, `description`, `remediation`, `ruleSource` (human-readable attribution), `isCustomRule`, `location` (the feature/document the finding is about), `sourceUrl` (a verifiable link to the repo file/commit), and `status`. `storyId` links the finding to the **existing** feature it's about (resolved from the feature identifier in `location`) — it drives the "View F-XXX" source link and the "Block F-XXX" action. Indexed on `(projectId, status)`, `scanId`, `storyId`, `(category, severity)`.

**`ScanActivity`** — append-only history log powering the page's **History** view. One row per event (`ScanActivityType`: `SCAN_STARTED`, `SCAN_COMPLETED`, `SCAN_FAILED`, `FINDING_RESOLVED`, `FINDING_DISMISSED`, `FINDING_REOPENED`, `FINDING_CONVERTED`, `CONFIG_UPDATED`) with the actor (`userId`), an optional `scanId`/`findingId`/`storyId`, a human-readable `summary`, and `metadata`. Indexed on `(projectId, createdAt desc)`.

### Enums

| Enum | Values |
|------|--------|
| `ScanCategory` | `SECURITY`, `ACCESSIBILITY` |
| `ScanSeverity` | `CRITICAL`, `HIGH`, `MEDIUM`, `LOW` |
| `ScanStatus` | `PENDING`, `RUNNING`, `COMPLETED`, `FAILED` |
| `ScanTrigger` | `MANUAL`, `MATURATION_GATE` |
| `ScanTargetType` | `PROJECT`, `FEATURE` |
| `ScanFindingStatus` | `OPEN`, `RESOLVED`, `DISMISSED` |
| `ScanEnforcementMode` | `WARN`, `BLOCK` |

## What gets scanned

`getProjectScanContent` (in `packages/database/prisma/queries/projects/scan.ts`) assembles the **Fabric-held context** the scanners analyse — no external repository fetch, no code execution. Each section is clearly labelled so the LLM can attribute a finding to its source.

- **Project metadata** — name, description, goals, tech stack (for context).
- **Features** — for a `PROJECT` scan, the project's recent non-declined features (up to 40); for a `FEATURE` scan, the single target feature. Each contributes title, description, acceptance criteria, and release notes.
- **Generated documents** (`PROJECT` scope only) — active `ProjectDocument` rows (up to 20). Their described UI feeds the accessibility agent (AC2); any code/design described feeds the security agent.

Content is truncated per item (`MAX_ITEM_CHARS = 4,000`) and overall (`MAX_SCAN_CONTENT_CHARS = 28,000`) to stay within model limits.

## AI integration

The scanner activities (`packages/temporal/src/activities/security-scan/scan-activities.ts`) resolve a model via `getAIModelWithMetadata({ taskType: "COMPLEX" })` and call the Vercel AI SDK `generateObject` against `ScanResultSchema` with `temperature: 0`. Usage (tokens, cost, model name) is captured into the `ProjectScan` telemetry. The activity heartbeats while waiting on the LLM so a long generation never trips the Temporal timeout.

### Schema robustness (important pattern)

The findings schema (`scan-schemas.ts`) is deliberately **lenient**, because `generateObject` is fragile to two independent failure modes:

1. A strict `z.enum()` rejects the model's natural vocabulary (e.g. `"Critical"`, `"Serious"`) and fails the whole parse.
2. A `z.preprocess()` wrapper emits a JSON-schema node with no `type`, which the AI gateway rejects *before the model runs* (`Schema type is missing`).
3. A required field the model happens to omit fails validation (`expected string, received undefined`).

The rule we follow here (and the reason this is documented rather than left implicit):

> **Keep the model-facing schema permissive — plain `z.string().optional()` for every field, no `z.enum`, no `z.preprocess` — and normalize/default in code.**

`mapRawFindingToDraft` does the normalization:

- `normalizeSeverity` maps mixed-case and tool synonyms (`critical`, `serious`, `moderate`, `minor`, `info`, …) to the canonical `ScanSeverity`, defaulting unknown values to `MEDIUM`.
- `normalizeRuleType` resolves `DEFAULT` vs `CUSTOM`.
- `deriveTitle` falls back to the first sentence of the description, then the rule reference, when the model omits a title.
- `ruleSource` is composed for attribution: `OWASP Top 10 — <ref>`, `WCAG 2.1 AA — <ref>`, or `Custom: <rule name>` (with `isCustomRule = true`).

### Safety: secret redaction + strict scope

Two guardrails live in `scan-schemas.ts`:

- **No stored secrets.** `redactSecrets` runs over **every** persisted finding field (title, description, remediation, ruleSource, location — for both LLM and Semgrep findings). It scrubs provider tokens (GitHub/Slack/OpenAI/AWS/Google), JWTs, PEM private-key blocks, and generic high-entropy tokens, while leaving prose, OWASP refs (`A03:2021`), WCAG criteria (`1.4.3`), and identifiers (`F-123`) intact. The prompts also instruct the model never to echo a secret value — redaction is the defense-in-depth guarantee behind that. **Scope:** this covers the scan's own findings, and the Semgrep + git-history clones (temp dirs deleted in a `finally`; gitleaks also runs with `--redact`); it does **not** change what other features already store — `project_document` content, the Atlas/`CodeSymbol` code index, and `project_meeting_transcript` rows are persisted by their own features and are out of scope here. Don't market the feature as "Fabric stores no secrets" — the accurate claim is that *scan findings* never contain secret values.
- **Strict scope.** `scopeGuard` hardens each prompt so the security agent reports *only* security vulnerabilities and the accessibility agent *only* WCAG issues — explicitly excluding performance, code style, naming, architecture taste, test coverage, and documentation "junk", and requiring every finding to map to an OWASP/WCAG/custom rule. Covered by `scan-schemas.test.ts`.

## Code scanning (Semgrep SAST)

Beyond the LLM design-time scan, a project can opt into a real **Semgrep** static-analysis pass over its connected repository (`ProjectScanConfig.semgrepEnabled`, project-scope scans only). The workflow runs `runSemgrepScanActivity` (`security-scan/semgrep-scan.ts`) in parallel with the LLM scanners, gated behind `patched("security-scan-semgrep-v1")` for replay safety. The activity:

1. Resolves the project's first active `ProjectRepositoryIntegration` (`getProjectReposForCodeSearch` + `resolveRepoAuth` + `decryptApiKey`) and shallow-clones it to a temp dir.
2. Runs `semgrep scan --json --config=p/default --config=p/owasp-top-ten` (via `node:child_process`), parses the results (`parseSemgrepResults`), maps each to a `ScanFindingDraft` (`category: SECURITY`, severity from `extra.severity`, `ruleSource: "Semgrep: <check_id>"`, `location: <path>:<line>`), and **redacts secrets** from every field.
3. Cleans up the clone, and **degrades gracefully**: no connected repo, a missing Semgrep binary, or a clone failure returns a `skipped` reason — the LLM scan still completes. Semgrep findings are persisted as additional `SECURITY` rows by `persistScanResultsActivity` (folded into `securityFindingCount`).

**Deployment note:** the Temporal worker image must include Semgrep (`packages/temporal/Dockerfile` installs `semgrep==1.161.0`, matching CI). Until a worker with Semgrep is deployed, the toggle is inert — the activity logs `skipped: "semgrep-unavailable"` and the scan runs LLM-only.

## Git-history secret scanning (gitleaks)

Semgrep's depth-1 clone only sees the *current* working tree. A project can additionally opt into a **git-history** scan (`ProjectScanConfig.gitHistoryEnabled`, project scope only) that catches secrets which were committed and later removed. `runGitHistorySecretScanActivity` (`security-scan/git-history-scan.ts`), gated behind `patched("security-scan-git-history-v1")`, does a **full** clone (no `--depth`) and runs `gitleaks detect --source <clone> --report-format json --redact` over the whole commit log. It maps each leak to a `ScanFindingDraft` (`category: SECURITY`, severity `HIGH`, `ruleSource: "Secret history: <rule>"`, `location: <file>, line N, commit <short>`), runs `redactSecrets` over **every** field (belt-and-braces on top of gitleaks' `--redact`), deletes the clone (and the JSON report) in `finally`, and **degrades gracefully** (no repo / clone failure / missing binary → `skipped`). Findings fold into `securityFindingCount` alongside Semgrep + LLM findings. The worker image installs the `gitleaks` binary (`Dockerfile`, pinned `GITLEAKS_VERSION`); absent it, the activity logs `skipped: "gitleaks-unavailable"`. Because a full clone is heavier than the depth-1 Semgrep clone, this is a separate opt-in.

## Scan modes (incremental vs full)

A manual scan runs in one of two modes (`ProjectScan.mode`, default `FULL`), chosen from the **Scan / Full scan** split-button:

- **`FULL`** — re-reads and re-analyses the whole project (the recent 40 features + 20 documents), producing a fresh complete finding set. This is the original behaviour.
- **`INCREMENTAL`** ("Scan", the primary button) — `gatherScanContextActivity` looks up the previous completed project scan's `completedAt` (`getLastCompletedScanAt`) and includes **only items updated since** (`getProjectScanContent` adds `updatedAt > since` to the feature + document queries), returning the `scannedItemKeys` (feature identifiers + document titles) actually re-read. On persist, `carryForwardFindings` copies every finding from the previous completed scan **whose item was not re-scanned** (`findingWasRescanned` matches `scannedItemKeys` against the finding's `location`) into the new scan, **preserving each finding's status, severity/category overrides, and work-item link**. So the latest scan stays the complete picture (matching the latest-scan display scoping) without re-analysing — or re-charging for — unchanged items. With no prior completed scan, an incremental scan covers everything (first run). Feature-scoped (maturation) scans are always `FULL`. *Limitation:* a finding on an item that was **deleted** since the last scan is carried forward until the next Full scan reconciles it.

## Triggers

Both entry points funnel through `startProjectScan` (`procedures/scan/lib/start-scan.ts`), which creates the `ProjectScan` row, starts the workflow on `fabric-worker`, and records the `workflowId`. `@repo/temporal` is **lazy-imported** so importing the helper (and the story-transition procedures that use it) doesn't pull the worker module graph into the API/test bundle.

- **Manual** — the `scan.trigger` procedure, invoked by the "Run scan" button. Target type `PROJECT`.
- **Maturation gate** — `maybeTriggerMaturationScan` is called fire-and-forget (`void`) from the feature stage-transition procedures (`update-story.ts`, `update-drafting-stage-with-version.ts`). It fires a `FEATURE`-scoped scan only when a feature transitions *into* the project's configured gate stage (not on edits of an item already at that stage), and only when `autoScanOnMaturation` is on and a scanner is enabled. It is deduped against any in-flight scan via `hasActiveScan` and wrapped in try/catch so it never disrupts the stage transition.

## Findings lifecycle and scoping

Each finding belongs to its `ProjectScan` (`scanId`). A user can move a finding through `OPEN → RESOLVED`/`DISMISSED` (and reopen) and override its category/severity via `scan.findings.update`. A `FULL` scan writes a fresh complete set; an `INCREMENTAL` scan writes fresh findings for changed items and **carries the rest forward** (copied into the new scan with their triage preserved — see *Scan modes*).

The findings list (`scan.findings.list`) **defaults to the most recent COMPLETED scan** when no explicit `scanId` is supplied (still story-scoped when a `storyId` is passed). This means:

- Re-running a scan **replaces** the displayed results rather than stacking the new run on top of every previous run's findings.
- The "last scan" header count matches the list.
- Scoping to the latest *completed* run keeps the previous results visible while a new scan is in flight (the running scan has no findings yet).
- An explicit `scanId` still wins, leaving room for a future run-history view.

Findings from older runs remain in the database as historical records; they are simply not shown on the default view.

## Block the related work item

There is **no "convert to work item"** — a finding is about an *existing* feature, so creating a new ticket would be redundant. Instead, when a finding's `storyId` is set (it's about a feature), the finding offers **Block F-XXX**: `stories.setBlocked` flips `UserStory.blocked = true` and stores the finding text as `blockedReason`. The same procedure is used from the work-item detail page for **manual** block/unblock with an optional reason. Every block/unblock bumps the story `version` and writes a `FeatureVersionHistory` snapshot (`changeDescription: "Blocked: …"` / `"Unblocked"`) in the same transaction — so it's reflected in the work item's **version history** (mirrors the `apply-terminal-*` pattern). The findings list includes each finding's source-feature blocked state, so a finding shows either a **Block F-XXX** button or a **Blocked → F-XXX** chip (reason on hover). The Blocked chip also appears on the roadmap/board cards, mirroring `needsMoreInfo`, and the roadmap exposes a **Blocked** filter (`?blocked=true`, via `useRoadmapFilters`). Permission: `STORY_UPDATE` (a story edit, matching `update-story` / `reevaluate-bug`).

## Group findings into tickets

Blocking covers findings tied to an *existing* feature; **grouping** covers the rest — cross-cutting findings (git-history secrets, a class of accessibility issue) that warrant their own tracked work. **Group into tickets** (Results header, next to **Review findings**) runs `securityFindingGroupingWorkflow` over every OPEN finding in the latest COMPLETED scan: findings are clustered by **theme** = `(category, ruleSource)` — a deterministic, mechanically-exhaustive partition — and each theme becomes **one drafted BUG** via the shared `createStoryFromProposal`, so grouped tickets are indistinguishable from any other work item (roadmap, PM-sync, permissions). This follows ADR-007's "deterministic-clustering + AI-narrative-only" split: clustering and ticket structure are code; the LLM (`processThemeActivity` → `generateObject` with a lenient schema) only authors the narrative title/summary/remediation.

**Gate.** A per-project `ProjectScanConfig.agentTicketGenerationEnabled` (off by default) gates the feature. The **button is disabled** until it's on (primary gate); the workflow *also* checks it in `checkAgentAccessActivity` and, when off, files a single deduped **prerequisite ticket** ("Grant Fabric Agent access to Security findings page") instead of processing findings — defense-in-depth for a direct API call. Trigger permission is `PROJECT_UPDATE` (matches "Run scan").

**Dedup (the sole mechanism).** Each theme's identity is a `StoryTag` value `theme-<catslug>-<ruleslug>-<hash8>` (`themeTagValue`). `findOpenStoryByThemeTag` looks for an open (non-`isFinal` status, non-terminal `draftingStage`) story carrying that tag: none → **create** the ticket then tag it (accessibility themes also get a `needs-rule-review` tag, D8); found → diff the theme's fingerprints against the ticket's last-known set and, if any are new, post **one incremental `AGENT` comment** (never edit the description, never a second ticket) — otherwise **skip**. Fingerprints are tracked in `ScanActivity.metadata` (no new table). Both the comment+activity write and the incremental path are composed so a `processThemeActivity` retry can't duplicate a comment.

**Content.** `assembleTicketBody` renders a deterministic Markdown body — Summary, per-severity breakdown, the full findings list (with locations), aggregated remediation, source attribution — over **all** of the theme's findings; `maxSeverityToPriority` maps the worst severity to `StoryPriority` (CRITICAL→P0 … LOW→P3). The LLM *prompt* inlines only a representative sample (`MAX_FINDINGS_IN_DRAFT_PROMPT = 60`, with a "+N more" note) so a very large theme can't overflow model context or the activity heartbeat window — the body still lists every finding (AC1).

**Run tracking.** A `ScanFindingGrouping` row (status, per-outcome counts, a `results` JSON of the created/updated/skipped/failed theme arrays, plus model/token/cost telemetry) backs the poll (`scan.grouping.latest`) and the after-the-fact **results dialog** — there is no propose-then-confirm/apply step (unlike Review findings; D18). The workflow processes themes in bounded-concurrency batches under `Promise.allSettled`, so one theme's failure is recorded as `failed` and never aborts the run; any uncaught throw routes to `failGroupingActivity`.

## History

`scan.activity` returns the project's append-only `ScanActivity` log — the page's **History** view. Activity is recorded at every meaningful event: scan start (`startProjectScan`), scan completion/failure (`persistScanResultsActivity` / `failScanActivity` in the worker), finding status changes (`scan.findings.update`), triage edits to a finding's category/severity (`FINDING_EDITED`), and configuration changes (`CONFIG_UPDATED`). A pure status transition keeps its dedicated type (`FINDING_RESOLVED`/`DISMISSED`/`REOPENED`); a category or severity override records a `FINDING_EDITED` entry whose summary lists each field that moved (e.g. "severity High → Critical"). Each row carries the actor, a human-readable summary, and timestamps, so the History dialog can show *who* did *what* and *when*. **Scan-run telemetry** (Atlas-style) is carried in the `SCAN_COMPLETED` activity metadata — `mode` (Full/Incremental), `durationMs`, `inputTokens`/`outputTokens`, `costUsd` (best-effort from the `AiModel` pricing catalog via `estimateScanCostUsd`), `modelName`, and `scanners` (which scanners ran) — and rendered as chips on the scan row.

The feed is split into **two dialogs**: **History** (scan runs + config changes) and **Finding updates** (finding resolve/dismiss/reopen/edit). `scan.activity` takes an optional `group` (`SCANS` | `FINDINGS`) that maps to the matching `ScanActivityType` set; each dialog pages **5 at a time** with a "Show more (N)" expander.

## Source links (verify a finding)

Every finding carries a verifiable pointer to its source: **Semgrep** findings get a `sourceUrl` to the repo blob (`<web>/blob/<branch>/<path>#L<line>`), **git-history** findings a commit URL (`<web>/commit/<sha>`), both built at scan time via `repoSourceFromRepo` (github/gitlab only; **credentials are stripped from the URL**). **LLM feature** findings instead resolve their feature identifier (`F-XXX`) to the `UserStory` (`getStoryIdsByIdentifiers`, batched) and store it as the finding's `storyId`, which the UI turns into an in-app "View F-XXX" link. The findings list renders "View source"/"View commit" (external, new tab) or "View F-XXX" (in-app) on each expanded finding.

## Enforcement

`ScanEnforcementMode` defaults to `WARN`: findings are surfaced but never block a feature from progressing — advisory only.

`BLOCK` is **automatic enforcement**: when a project's `enforcementMode` is `BLOCK`, `persistScanResultsActivity` (after persisting findings) calls `autoBlockTiedStories` — for every work item that a finding is tied to (`storyId` resolved from the finding location), it sets `UserStory.blocked = true` with the finding as the reason (highest-severity finding's title + a `+N more` count; titles are already redacted). It reuses `setStoryBlocked` with `skipIfAlreadyBlocked: true`, so a re-scan **never** overwrites a manually-set reason or spams the version history, and an existing block stays put. The block persists until removed manually (or the user switches back to `WARN`, which stops *new* auto-blocks; existing ones remain). The grouping/reason logic is the pure, unit-tested `computeAutoBlockReasons`. This runs inside the persist **activity** (not the workflow), so it's replay-safe and needs no `patched()` gate.

This automatic enforcement composes with the **manual** work-item blocking available in either mode: a user can block a work item from a finding (`Block F-XXX`) or the work-item page, with the change recorded in version history (see "Block the related work item"). The enforcement info popover explains both.

## Notifications

When a scan completes, `persistScanResultsActivity` emits a persistent `SECURITY_SCAN_COMPLETED` notification (`emit-scan-notification.ts`). The notification is written with a direct `db.notification.create` (avoiding an `@repo/api` dependency cycle from the worker) and is keyed on `scanId`; a unique-constraint clash (`P2002`) is swallowed so a retry coalesces rather than duplicating.

## Multi-tenancy, RLS, and authorization

- All three tables carry `userId` + nullable `organizationId` and follow the **XOR tenant pattern** (org context filters on `organizationId`; personal context requires `organizationId: null`).
- RLS: `project_scan_config`, `project_scan`, `scan_finding`, and `scan_activity` are registered as `user_owned` (`packages/database/scripts/apply-rls-direct.ts`) — defense in depth behind the app-layer filter.
- Every scan procedure runs under `tenantProtectedProcedure` + `requireProjectPermission(Permissions.PROJECT_READ)` and re-checks `hasProjectAccess` before reading or writing.

## API surface

Under `projects.scan` (`packages/api/modules/projects/router.ts`):

| Procedure | Purpose |
|-----------|---------|
| `scan.config.get` | Resolve config (returns sensible defaults when none saved) |
| `scan.config.update` | Save scanners, enforcement mode, maturation gate, custom rules |
| `stories.setBlocked` | Block / unblock a work item (manual, or from a finding) + version-history entry |
| `scan.activity` | The page History feed (scans, status changes) — `group: SCANS \| FINDINGS` |
| `scan.trigger` | Start a manual scan — `mode: "FULL" \| "INCREMENTAL"` (default FULL) |
| `scan.latest` | Most-recent scan (drives the header + polling) |
| `scan.runs` | Recent scan runs |
| `scan.findings.list` | Findings for the latest completed scan (or an explicit `scanId`) |
| `scan.findings.update` | Resolve / dismiss / reopen a finding, or override its status / category / severity (any subset; AI triage is user-correctable) |
| `scan.grouping.start` | Start a finding-grouping run (`PROJECT_UPDATE`; dedupes against an in-flight run) |
| `scan.grouping.latest` | Most-recent grouping run (drives the button poll + results dialog) |
| `scan.grouping.cancel` | Cancel a running grouping run (tenant-scoped fetch guards IDOR) |

## Frontend

`apps/web/modules/saas/projects/components/security/`:

- **`SecurityAccessibilityPage.tsx`** — orchestrates the page: polls `scan.latest` while a scan is in flight, shows the last-scan summary, announces status to assistive tech via a live region, and owns the "Run scan" button.
- **`ScanConfigCard.tsx`** — scanner toggles, enforcement mode, maturation-gate controls, and the custom-rules editor.
- **`ScanFindingsList.tsx`** — severity-grouped findings with category/severity/status filters, per-finding Resolve/Dismiss/Reopen, an **Adjust triage** editor in the expanded body (override status / category / severity via `scan.findings.update`), and the `CleanScanCard` confirmation. Its Results header also mounts `ReviewFindingsButton` and `GroupIntoTicketsButton`.
- **`GroupIntoTicketsButton.tsx`** — poll/start/cancel lifecycle for the grouping run (mirrors `ReviewFindingsButton`); gated on `scan.config.get`'s `agentTicketGenerationEnabled`, opens `GroupingResultsDialog` when a run the user started settles.
- **`GroupingResultsDialog.tsx`** — after-the-fact per-theme outcome list (Created / Updated / Skipped / Failed, each linking to its ticket), or an access-blocked banner pointing at the prerequisite ticket.
- **`lib.ts`** — server-inferred types (`Awaited<ReturnType<typeof orpcClient.projects.scan.*>>`) and token-backed badge variants.

Routes (both tenant contexts): `app/(saas)/app/(account)/projects/[id]/security/page.tsx` and `app/(saas)/app/(organizations)/[organizationSlug]/projects/[id]/security/page.tsx`. The page is reached via the **Security** tab on the project detail view.

## Operational notes

- **Queue**: `fabric-worker` (general purpose). Workflow `securityAccessibilityScanWorkflow`, ID `security-scan-<scanId>`. Grouping shares the same queue: `securityFindingGroupingWorkflow`, ID `security-ticket-grouping-<groupingId>`.
- **Timeouts/retries**: DB activities — 2 min, up to 5 retries; LLM activities — 6 min with a 2 min heartbeat, up to 2 retries (cost-bounded). Workflow execution timeout 30 min.
- **Failure handling**: any activity throw routes to `failScanActivity`, so a run never hangs in `PENDING`/`RUNNING`. The design is watchdog-free; a row stays `RUNNING` only if both the scan and the fail-write die.
- **Determinism**: the workflow only sequences activities (no `Date.now()`, no I/O), so it is replay-safe. Changing activity code does not affect replay; only workflow-shape changes do.

## File map

| Path | Role |
|------|------|
| `packages/database/prisma/schema.prisma` | Models + enums + `NotificationType.SECURITY_SCAN_COMPLETED` |
| `packages/database/prisma/queries/projects/scan.ts` | Config, run, finding, and content-assembly queries |
| `packages/temporal/src/workflows/security-accessibility-scan.ts` | Orchestration workflow |
| `packages/temporal/src/activities/security-scan/scan-activities.ts` | mark/gather/run/persist/fail activities |
| `packages/temporal/src/activities/security-scan/scan-schemas.ts` | Lenient model schema + prompt builders + normalization |
| `packages/temporal/src/activities/security-scan/emit-scan-notification.ts` | Completion notification |
| `packages/api/modules/projects/procedures/scan/` | oRPC procedures + `lib/start-scan.ts` + `{start,get,cancel}-grouping.ts` |
| `packages/database/prisma/queries/projects/scan-grouping.ts` | Grouping run rows, eligible-finding query, theme-tag dedup + fingerprint tracking |
| `packages/temporal/src/workflows/security-finding-grouping.ts` | Grouping orchestration workflow |
| `packages/temporal/src/activities/security-scan/grouping-{activities,schemas,tags}.ts` | Access-gate/gather/process-theme activities, ticket-body assembly, theme-tag helpers |
| `apps/web/modules/saas/projects/components/security/` | Page + config + findings UI + grouping button/dialog |

## Related

- [ADR-007: AI-driven security & accessibility scanning over Fabric-held context](../adr/007-ai-security-accessibility-scanning.md)
- [ADR-003: XOR tenant isolation](../adr/003-xor-tenant-isolation.md)
- User-facing guide: `apps/web/content/docs/features/security-accessibility-scanning.mdx`
