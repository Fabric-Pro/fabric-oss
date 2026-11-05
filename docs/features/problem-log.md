# Problem Log

The project "Problem Log" tab — a persistent, organization-owned record of user-impacting failures Fabric observed, aggregated by error signature, with an audited resolution status.

- **Audience**: Engineers extending or maintaining the Problem Log
- **Owner**: Projects / Platform team

## Model

`ProblemLogEntry` (`problem_log_entry`) is organization-owned: `org_only` RLS, listed in `ORG_ONLY_TABLES` and never in `PROJECT_SCOPED_TABLES`, so an invited project guest cannot reach it. `projectId` is a filter, not a tenant route, and is null for organization-level events. The API additionally requires a live `member` row in the organization that owns the project (`packages/api/modules/problem-log/lib/access.ts`).

Each row aggregates occurrences under `dedupKey`, a hash over category, source, fingerprint, project and affected user. The same failure hitting another user or project is a separate entry. A recurrence increments `occurrenceCount`, moves `lastSeenAt`, escalates `severity`, and reopens a `RESOLVED` entry.

`reviewState` is `CONFIRMED` for system events. Entries drafted from project context start `PENDING` and become `CONFIRMED` or `DISMISSED` on review; only `CONFIRMED` entries are log items, take a status, or appear in the list by default.

## Writing

`recordProblem` (`packages/database/prisma/queries/problem-log.ts`) is the only writer for system events. It never throws, drops `INFO` severity and events with no organization, and drops a `projectId` that is not the organization's own (callers may pass one read from request input).

| Source | Hook | Category |
|---|---|---|
| oRPC request errors (5xx-class) | `auditErrorMiddleware` | `SYSTEM_ERROR` |
| oRPC access denials | `auditErrorMiddleware` | `SECURITY_EVENT` |
| Background job closed as FAILED (incl. watchdog timeouts) | `failBackgroundJob`, `failStaleBackgroundJobs` | by job kind: `DATA_PIPELINE_FAILURE`, `INTEGRATION_FAILURE`, `BACKGROUND_JOB_FAILURE` |
| Terminal PM sync failure of one item | `recordPmSyncFailureLog` | `INTEGRATION_FAILURE` |
| Email / webhook notification not delivered | notification delivery activities (webhook: final attempt only) | `NOTIFICATION_FAILURE` |

Validation, not-found, conflict and rate-limit errors are expected rejections and are not logged. A failure a retry recovers from is not logged: hooks sit only where the failure is already terminal.

## Drafts from meetings

Meeting insight extraction (`extractMeetingInsightsActivity`, run by the Daily Brief and on-demand extraction) also asks the model for `problems`: issues, blockers and risks raised in the meeting. Each is written by `draftProblemsFromContext` as a `PENDING` entry with `sourceType: MEETING_TRANSCRIPT`, `sourceId` = the transcript id, the verbatim `sourceQuote`, and the meeting subject and date in `metadata`.

- Categories: `PROJECT_ISSUE` and `PROJECT_RISK` draft as `WARNING`, `PROJECT_BLOCKER` as `ERROR`.
- The drafter never throws and is idempotent: the dedup key is the transcript plus the normalized title, so a retried or forced re-extraction adds nothing and a dismissed draft never comes back. The same problem raised in two meetings drafts twice; cross-source duplicate detection is open on the card.
- Drafting rides meeting transcript sync (`Project.meetingTranscriptSyncEnabled`), like the Decisions Log's meeting candidates; there is no separate switch. Transcripts already extracted at the current `MEETING_INSIGHTS_VERSION` are not re-read, so drafts appear for new or regenerated meetings only.

`problemLog.review` (`problem_log:manage`) confirms a draft, optionally with edits to title, description, category and severity, or dismisses it. The row and a `project.problem_log.reviewed` audit row (decision, source type, names of edited fields — never the text) commit together; a second review of the same draft is a `CONFLICT`. The tab shows managers the pending drafts above the log.

## Status changes

`setProblemLogEntryStatus` writes the entry and a `project.problem_log.status_changed` audit row in one transaction (`recordAuditTx`). Those append-only audit rows are the entry's transition history; a system reopen on recurrence writes one with a `system` actor.

## Incident reports

`problemLog.report` (`problem_log:read`) returns the confirmed entries for one entry or for the tab's status and category filters plus an optional date range. An entry is in the range when it was seen at any point inside it (`firstSeenAt <= to` and `lastSeenAt >= from`). Rows carry the affected user's display name and the project name, and stop at 1,000 with `truncated: true`. A report shows nothing the list does not, so it is not audited.

The browser renders the preview, the CSV (`incident-report.ts`, RFC 4180, a leading `= + - @` is prefixed with `'` so a spreadsheet cannot run it as a formula) and the PDF (jsPDF, loaded on demand).

## Permissions

| Permission | Granted to |
|---|---|
| `problem_log:read` | every organization role and project role |
| `problem_log:manage` | organization admins and owners, project admins and owners |

## Transports

The Problem Log is available in the Portal and through the oRPC procedures `problemLog.list`, `get`, `setStatus`, `review` and `report`. They are session-only: no API-key scope, CLI command or MCP tool exposes them yet. Until those exist, the CLI and MCP surfaces are unsupported for every Problem Log operation.

## Not yet built

Organization-wide views (an admin list and report across all projects, and entries recorded without a project), an auditor role for status changes, links from an entry to its source transcript, and emitters for credential expiry and for storage, vector database and GitHub failures. The Change Management Log, admin-tunable threshold breaches and break-glass access are tracked separately.
