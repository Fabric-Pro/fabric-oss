/**
 * Audit log helpers.
 *
 * - `recordAudit` is the DB-level helper used by Temporal activities and
 *   other non-API callers. It is fire-and-forget: the call returns `void`
 *   synchronously, the insert happens in the background, and any failure
 *   routes through `onAuditWriteFailure` (structured log, counter, stdout
 *   fallback) so the caller never has to handle it.
 * - `recordAuditTx` is the transactional form. It accepts a Prisma
 *   transaction client and awaits the insert, so the audit row commits or
 *   rolls back with the originating action. Errors propagate.
 * - `redactSensitiveKeys` is the metadata redactor. It is run
 *   unconditionally inside both helpers before insert — callers are NOT
 *   trusted to redact themselves. See D15 for the denylist and the rules.
 *
 * Snapshot fields (`actorEmailSnapshot`, `actorNameSnapshot`,
 * `resourceName`) are populated at write time from the input and never
 * updated after insert (D11).
 *
 * Full spec:
 *   docs/audit-log/README.md §7
 */

import {
	type AuditEventType,
	type AuditSeverity,
	logAuditEvent,
	logger,
} from "@repo/logs";
import { getCorrelationIdFromContext } from "@repo/utils/correlation-id";
import { keyIsSensitive, REDACTED } from "@repo/utils/sensitive-keys";
import { db, type Prisma } from "../client";

// ============================================================================
// Closed taxonomy (D2)
// ============================================================================

/**
 * Closed set of audit action keys per D2. The set spans user-triggered events
 * (auth/org/account/project/story/newsletter) and system-emitted ones (e.g.
 * `audit.retention.purged` from the Temporal retention activity, the
 * incident/weave lifecycle bridges). Any action not in this set is rejected by
 * `buildAuditRow` so a typo never silently lands in the ledger. The exact count
 * is asserted by the audit-taxonomy test — update it there when adding keys.
 */
export const AUDIT_ACTIONS = [
	// auth (8)
	"auth.login.success",
	"auth.login.failure",
	"auth.logout",
	"auth.mfa.enabled",
	"auth.mfa.disabled",
	"auth.password.changed",
	"auth.impersonation.started",
	"auth.impersonation.ended",
	// org (13)
	"org.created",
	"org.updated",
	"org.deleted",
	"org.settings.updated",
	"org.member.invited",
	"org.member.role_changed",
	"org.member.removed",
	"org.api_key.created",
	"org.api_key.revoked",
	"org.api_key.rotated",
	"org.integration.connected",
	"org.integration.disconnected",
	"org.integration.config_updated",
	// account (3) — personal-context API key lifecycle for the
	// public audit-log REST API. Mirrors `org.api_key.*` but writes
	// rows scoped to `userId` (personal) instead of the org.
	"account.api_key.created",
	"account.api_key.revoked",
	"account.api_key.rotated",
	// project (30)
	"project.ci_run.triggered",
	// Fabric dispatched a browser-driving test run against one of the project's
	// environments. One row per attempt, including refusals (cost cap, or a
	// production target nobody confirmed).
	"project.agentic_run.dispatched",
	// A sign-in credential for a deployment target was stored, changed or
	// cleared. Distinct from a repo token: this one logs in to the CUSTOMER's own
	// running system, so the row records whether the target was production.
	"project.environment_credential.updated",
	"project.environment.created",
	"project.environment.updated",
	"project.environment.deleted",
	"project.qa_settings.updated",
	// A person hid a CI failure from the findings list, or folded duplicate rows
	// into one. Both are judgements about what the team will act on rather than
	// observations, so unlike ingestion's own RESOLVED they belong in the ledger:
	// "why did this failure stop being tracked" has a person's name on it.
	"project.qa_finding.dismissed",
	"project.qa_finding.merged",
	"project.qa_webhook.created",
	"project.qa_webhook.rotated",
	"project.qa_webhook.expiry_updated",
	"project.qa_webhook.revoked",
	// Fabric reached out to the customer's forge with their own repository
	// credential and pulled a pull request's source diff in. Unlike ingesting a
	// CI result — which the customer's pipeline pushes — this is Fabric reading
	// their code because a person asked it to, so the row names who asked, which
	// repository, and which commit range (CC7.2).
	"project.pull_request.read",
	// A review LENS ran over a read pull request — a judgement that costs model
	// credits, unlike the read itself. The row carries how many findings survived
	// grounding and how many were dropped, because a run that discards most of
	// what it produced is the earliest signal the prompt or model has drifted.
	"project.pull_request.reviewed",
	// A person accepted or dismissed a finding. A dismissal reasoned INCORRECT is
	// what the false-positive rate is measured from, and a measurement nobody can
	// attribute is not evidence.
	"project.pull_request.finding_judged",
	// Fabric WROTE into the customer's repository — the only action here that
	// leaves the deployment and lands where their whole team reads it. It was
	// emitted from the posting procedure but missing from this list, so every
	// row logged `audit.unknown_action` and fell outside the set the admin
	// viewer filters on: the one event most worth finding was the one hardest to
	// find. `mode` distinguishes a new comment from an edit in place.
	"project.pull_request.comment_posted",
	"project.created",
	"project.updated",
	"project.archived",
	"project.deleted",
	"project.member.invited",
	"project.member.role_changed",
	"project.member.function_tags_changed",
	// A member CONFIRMED their own role on a project — self-service, and the
	// thing an administrator's own tag change deliberately does NOT do. An
	// admin edit clears confirmation; only the member can restore it. Without
	// this row, "who agreed to hold this role, and when" has no answer.
	"project.member.function_tags_confirmed",
	"project.member.removed",
	// Project-level Databricks Vector Search knowledge binding. Connecting
	// points every agent/retrieval flow in the project at an external
	// customer corpus via a stored org credential — exactly the kind of
	// event a CC6 review filters for by action.
	"project.databricks_knowledge.connected",
	"project.databricks_knowledge.disconnected",
	"project.invitation.widget_dismissed",
	"project.meeting_digest.inclusion_changed",
	"project.meeting_digest.action_item_toggled",
	// story (10)
	"story.created",
	"story.updated",
	"story.deleted",
	"story.status_changed",
	"story.pm_pushed",
	"story.auto_hidden",
	"story.auto_unhidden",
	"story.pm_ticket_unlinked",
	"story.pm_flag_missing_auto_dismissed",
	// One row per AI re-prioritization RUN (resource = the project), including
	// runs that moved nothing — "someone ran AI triage" is itself auditable.
	// Per-item band moves live in StoryPriorityChange, not here.
	"story.reprioritized",
	// audit (4)
	"audit.viewed",
	"audit.exported",
	"audit.retention.purged",
	// Per-request hit on the public audit-log REST API. Emitted by the
	// `requireAuditLogApiKey` middleware on every authenticated call
	// (success or failure). Sampled at 100% in v1; the metadata column
	// carries the matched endpoint, status, and key prefix (never the
	// raw key).
	"audit.api_request",
	// incident (6) — bridged from `IncidentEvent` rows (D17). State
	// transitions only — raw metric crossings are NOT mirrored into audit_log.
	// The `IncidentEvent` ledger stays canonical; these rows are a view onto
	// state transitions so a single timeline can show user actions and
	// incident lifecycle alongside.
	"incident.fired",
	"incident.re_fired",
	"incident.acknowledged",
	"incident.commented",
	"incident.auto_resolved",
	"incident.manual_resolved",
	// weave (2) — Weave/CodingRun session lifecycle. Both actions are
	// emitted from Temporal activities (never directly from workflow code).
	// `terminated_on_exit` is the happy-path teardown written by the
	// workflow's finally block on every exit (success, failure, OAuth
	// block, cancel, exception). `terminated_stale` is the watchdog
	// cron's force-kill of a row that exceeded its hard ceiling.
	"weave.session.terminated_on_exit",
	"weave.session.terminated_stale",
	// atlas (6) — Atlas analysis lifecycle + on-demand
	// node regeneration + monitored-branch configuration. `requested` is
	// user-initiated (UI Re-analyse); `cancelled` is the user-initiated
	// "Cancel analysis" (best-effort Temporal cancel + idempotent finalize to
	// FAILED with "Cancelled by user"); `completed`/`failed` are emitted from
	// the analysis workflow's finalize step; `node.regenerated` is the
	// per-node "Regenerate with AI"; `node.edited` is a saved user override
	// (description/category); `branch.changed` is the monitored-branch edit;
	// `branches.pinned` is the per-repo pinned-branch set update. `edge.edited`
	// saves a user description on a connection; `edge.created` is a user-drawn
	// (manual) connection (or the restore of a previously-deleted one);
	// `edge.deleted`/`edge.restored` soft-delete and revive a connection (solo or
	// System-map cross-repo).
	"atlas.analysis.requested",
	"atlas.analysis.cancelled",
	"atlas.analysis.completed",
	"atlas.analysis.failed",
	"atlas.node.regenerated",
	"atlas.node.edited",
	"atlas.edge.edited",
	"atlas.edge.created",
	"atlas.edge.deleted",
	"atlas.edge.restored",
	"atlas.branch.changed",
	"atlas.branches.pinned",
	// backlog (2) — AI Backlog Update apply-proposal recovery. Both are emitted
	// when a proposal stuck mid-apply is force-stopped: `cancelled` is the
	// user-initiated "Cancel apply" (manual, immediate); `timed_out` is the
	// stuck-apply watchdog cron's auto-stop after the apply exceeded its ceiling.
	// Both reuse the proposal's FAILED state so it stays retryable.
	"backlog.proposal.cancelled",
	"backlog.proposal.timed_out",
	// newsletter (3) — per-project embeddable release-notes widget owner actions.
	// A project OWNER turning the public widget on/off or rotating its embed
	// token is a public-exposure change, so each writes a row IN the same
	// transaction as the mutation (recordAuditTx). `enabled`/`disabled` fire only
	// on a REAL state transition (setPublicWidgetState.changed); `token_rotated`
	// fires on every regenerate (always a durable revocation of the prior token).
	"newsletter.widget.enabled",
	"newsletter.widget.disabled",
	"newsletter.widget.token_rotated",
	// newsletter approval gate (Fizzy 1869) — the release-notes approval gate is a
	// security-relevant external-publication control; changing the requirement or a
	// reviewer's approve/reject decision is audit-worthy.
	"newsletter.approval.required_changed",
	"newsletter.send.approved",
	"newsletter.send.rejected",
	// dailyBrief (2) — per-project release-notes curation (Fizzy 1869
	// follow-up). A project OWNER hiding/unhiding a PR from the Daily
	// Brief's Release Notes panel is a content-curation decision worth a
	// forensic trail, so both directions are recorded.
	"dailyBrief.releaseNote.hidden",
	"dailyBrief.releaseNote.unhidden",
	// user-activity (1) — meta-event mirroring `audit.viewed` (D12) for the
	// org-scoped User Activity dashboard. `userActivity.listMembers`
	// and `userActivity.memberHistory` both expose member login times, IPs, and
	// user agents, so every successful (authorized, flag-on) call of either
	// procedure emits this ONE action, with `metadata.endpoint` ("listMembers" |
	// "memberHistory") distinguishing which read occurred and, for
	// `memberHistory`, `metadata.targetUserId` naming the viewed member. Category
	// is explicitly "audit" (same forensic bucket as `audit.viewed`) rather than
	// derived from the action prefix.
	"userActivity.viewed",
	// mcp (4) — MCP data-source credential-config lifecycle (SOC 2 CC7.2). A
	// tenant creating/updating/deleting an MCP config manages stored credentials,
	// so each mutation is recorded in the audit ledger.
	"mcp.config.created",
	"mcp.config.updated",
	"mcp.config.deleted",
	// A protocol request named an organization its caller is not a member of,
	// and the server refused to serve it. Recorded because the refusal is the
	// only trace the attempt leaves — the request never reaches a tenant-scoped
	// query, so nothing downstream would log it. `metadata.requestedOrganizationId`
	// carries the tenant that was named; the row's own `organizationId` stays
	// null, because the caller has no standing in it and the row must not appear
	// in that organization's log.
	"mcp.session.organization_denied",
	// decision (1) — AI decision pre-check override. Written server-side when a
	// user accepts AI output that contradicts a logged architecture decision
	// (backlog "Apply Selected", or the document "Keep anyway" acknowledge).
	// One immutable row per conflicting decision so the admin Overrides list
	// maps 1:1 to decisions; all rows for one accept share `metadata.artifactId`.
	// Category derives from the `decision.` prefix.
	"decision.override_accepted",
	// featureFlag (2) — instance-admin global feature-flag changes (DB-backed
	// override replacing env-var-only flags). `updated` is one row per set-flag
	// call; `reset` is one row per clear-override call (returning a flag to its
	// env/registry default). `metadata` carries the before/after value and
	// source so an admin can see exactly what changed and where the prior value
	// was coming from.
	"featureFlag.updated",
	"featureFlag.reset",
	// statusUpdate (2) — customer-facing status announcements. Publishing text
	// that every customer reads, and every subsequent revision of it, is a
	// public-communication act and belongs in the forensic trail: "who told
	// customers what, when" is exactly the question an incident review asks.
	"statusUpdate.published",
	"statusUpdate.revised",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * Open-namespace error action keys (D16). Unlike `AUDIT_ACTIONS` (closed
 * success taxonomy), `ERROR_ACTIONS` is a small fixed list keyed off the
 * ORPCError code that the automatic error-capture middleware mapped the
 * thrown value to. It complements rather than replaces the closed set:
 * success emissions still use `AUDIT_ACTIONS`; only the middleware uses
 * these.
 *
 * Spec: docs/audit-log/README.md
 * D16 (automatic error capture).
 */
export const ERROR_ACTIONS = [
	"error.permission_denied", // ORPCError code: FORBIDDEN, UNAUTHORIZED
	"error.not_found", // NOT_FOUND
	"error.validation", // BAD_REQUEST, Zod input failures
	"error.rate_limited", // TOO_MANY_REQUESTS
	"error.unavailable", // SERVICE_UNAVAILABLE
	"error.timeout", // TIMEOUT
	"error.conflict", // CONFLICT (e.g. Prisma P2002)
	"error.internal", // INTERNAL_SERVER_ERROR or any uncaught Error
] as const;

export type ErrorAction = (typeof ERROR_ACTIONS)[number];

/** Category attribute used by every `error.*` action. */
export const ERROR_CATEGORY = "error" as const;

/**
 * Category and prefix for automatically-captured activity (D18).
 *
 * `AUDIT_ACTIONS` is a CLOSED taxonomy of curated, security-relevant events,
 * and that closedness is load-bearing: it is what makes a typo in a
 * hand-written action key observable instead of silent.
 *
 * But a closed taxonomy can only ever cover what somebody remembered to add,
 * and the long tail — every ordinary mutation across documents, workflows,
 * agents, test cases, prompts, reports — was therefore invisible in the
 * ledger. Extending the closed list to cover all of it would mean hundreds of
 * entries and hundreds of call sites, and would drift again the moment a new
 * procedure landed.
 *
 * So the coverage problem is solved by inversion instead: the activity
 * middleware derives an action key from the procedure path and writes it under
 * this OPEN namespace. `activity.*` keys are exempt from the closed-taxonomy
 * warning because they are machine-derived and cannot be misspelled by hand,
 * while every hand-written key keeps its guarantee.
 *
 * The two namespaces are deliberately distinguishable so the viewer can offer
 * "security events" separately from "all activity" — a curated ledger is
 * useless if the long tail buries it.
 */
export const ACTIVITY_CATEGORY = "activity" as const;
export const ACTIVITY_ACTION_PREFIX = "activity." as const;

/**
 * Is this a machine-derived activity key? Such keys are exempt from the
 * closed-taxonomy warning.
 */
export function isActivityAction(action: string): boolean {
	return action.startsWith(ACTIVITY_ACTION_PREFIX);
}

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set([
	...AUDIT_ACTIONS,
	...ERROR_ACTIONS,
]);

/**
 * Closed set of action categories. Derived deterministically from the
 * leading dot-segment of each action key in `AUDIT_ACTIONS` plus the
 * `error` namespace populated by the error-capture middleware (D16).
 */
export const AUDIT_CATEGORIES = [
	"auth",
	"org",
	"account",
	"project",
	"story",
	"audit",
	"error",
	"incident",
	"weave",
	"atlas",
	"backlog",
	"newsletter",
	"mcp",
	"dailyBrief",
	"decision",
	"featureFlag",
	"statusUpdate",
	// Machine-derived long-tail activity. Kept as its own category so the
	// viewer can separate curated security events from everyday activity —
	// a curated ledger is useless if the long tail buries it.
	ACTIVITY_CATEGORY,
] as const;

export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export type AuditSeverityLevel = "info" | "warning" | "error" | "critical";
export type AuditOutcome = "success" | "failure";
export type AuditActorType = "user" | "system" | "api_key" | "agent";

// ============================================================================
// Input shape
// ============================================================================

export interface AuditActor {
	type: AuditActorType;
	userId?: string | null;
	emailSnapshot?: string | null;
	nameSnapshot?: string | null;
	impersonatedById?: string | null;
}

export interface AuditResource {
	type: string;
	id?: string | null;
	name?: string | null;
}

export interface RecordAuditInput {
	/** Action key, must be a member of `AUDIT_ACTIONS`. */
	action: AuditAction | string;
	/** Optional — when omitted, derived from `action.split(".")[0]`. */
	category?: AuditCategory | string;
	/** Defaults to "info". */
	severity?: AuditSeverityLevel;
	/** Defaults to "success". */
	outcome?: AuditOutcome;
	actor: AuditActor;
	organizationId?: string | null;
	resource?: AuditResource;
	projectId?: string | null;
	metadata?: Record<string, unknown> | null;
	ipAddress?: string | null;
	userAgent?: string | null;
	requestId?: string | null;
	sessionId?: string | null;
	/**
	 * End-to-end correlation identifier. Persisted into
	 * `metadata.correlationId` rather than a dedicated column — OTEL
	 * convention places trace identity in attributes, not schema fields,
	 * and avoiding a migration keeps this addition backward-compatible.
	 * Callers SHOULD prefer reading from `getCorrelationIdFromContext()`
	 * (AsyncLocalStorage) so deeply-nested writers do not have to thread
	 * the id through every helper.
	 */
	correlationId?: string | null;
	/**
	 * Procedure latency in milliseconds. Populated by the
	 * `auditTimingMiddleware` for request-scoped emissions. Null/undefined
	 * for non-request emissions (Temporal activities, retention purges).
	 */
	durationMs?: number | null;
}

// ============================================================================
// Sensitive-key redactor (D15)
// ============================================================================

/**
 * Recursively redact values whose KEY matches the sensitive-key denylist.
 * Walks nested objects and arrays; primitives and `null` pass through.
 *
 * Behaviour matrix (see unit tests for full coverage):
 * - `{ password: "x" }` -> `{ password: "[REDACTED]" }`
 * - `{ Password: "x", ACCESSTOKEN: "y" }` -> both redacted (case-insensitive)
 * - `{ user_password_hash: "x" }` -> redacted (substring match)
 * - `{ note: "my password is x" }` -> preserved (value not inspected)
 * - `{ tokens: [{ accessToken: "x" }] }` -> array walked element-wise
 * - `redactSensitiveKeys("hello")` -> `"hello"` (primitive at top level)
 * - `redactSensitiveKeys(null)` -> `null`
 */
export function redactSensitiveKeys(input: unknown): unknown {
	if (input === null || input === undefined) {
		return input;
	}
	if (Array.isArray(input)) {
		return input.map((entry) => redactSensitiveKeys(entry));
	}
	if (typeof input !== "object") {
		return input;
	}

	const source = input as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(source)) {
		if (keyIsSensitive(key)) {
			output[key] = REDACTED;
			continue;
		}
		output[key] = redactSensitiveKeys(source[key]);
	}
	return output;
}

// ============================================================================
// Row builder
// ============================================================================

/**
 * Resolve the row payload from a `RecordAuditInput`. Centralised so the
 * fire-and-forget and transactional helpers agree on every default.
 *
 * Responsibilities:
 *  1. Validate `action` against the closed taxonomy. Unknown keys still
 *     persist (we never lose an audit event) but emit a warning log so
 *     the typo is observable.
 *  2. Derive `category` from the action prefix when the caller did not
 *     specify one.
 *  3. Run `metadata` through `redactSensitiveKeys`.
 *  4. Default `severity: "info"` and `outcome: "success"`.
 *  5. Snapshot the actor's email/name into the row from the actor
 *     argument (callers are expected to read User.email/name at write
 *     time and pass them in — see D11).
 */
function buildAuditRow(input: RecordAuditInput): Prisma.AuditLogCreateInput {
	if (!AUDIT_ACTION_SET.has(input.action)) {
		logger.warn(
			{
				event: "audit.unknown_action",
				action: input.action,
			},
			"Audit action is outside the closed taxonomy",
		);
	}

	const category = input.category ?? deriveCategoryFromAction(input.action);
	const severity = input.severity ?? "info";
	const outcome = input.outcome ?? "success";

	// Fold correlationId into metadata so it's queryable from the viewer
	// without a schema migration. The redactor sees the merged object, but
	// "correlationid" is not on the SENSITIVE_KEY_SUBSTRINGS denylist (it's
	// non-secret tracing data, intentionally non-redacted).
	const mergedMetadata: Record<string, unknown> | null = input.correlationId
		? { ...(input.metadata ?? {}), correlationId: input.correlationId }
		: (input.metadata ?? null);
	const metadata =
		mergedMetadata !== null
			? (redactSensitiveKeys(mergedMetadata) as Prisma.InputJsonValue)
			: undefined;

	const data: Prisma.AuditLogCreateInput = {
		actorType: input.actor.type,
		actorEmailSnapshot: input.actor.emailSnapshot ?? null,
		actorNameSnapshot: input.actor.nameSnapshot ?? null,
		impersonatedById: input.actor.impersonatedById ?? null,
		action: input.action,
		category,
		severity,
		outcome,
		resourceType: input.resource?.type ?? null,
		resourceId: input.resource?.id ?? null,
		resourceName: input.resource?.name ?? null,
		ipAddress: input.ipAddress ?? null,
		userAgent: input.userAgent ?? null,
		requestId: input.requestId ?? null,
		sessionId: input.sessionId ?? null,
		durationMs:
			typeof input.durationMs === "number" &&
			Number.isFinite(input.durationMs) &&
			input.durationMs >= 0
				? Math.round(input.durationMs)
				: null,
	};

	if (metadata !== undefined) {
		data.metadata = metadata;
	}

	// FK back-relations: only attach the relation when an id is present so
	// the row's FK columns stay nullable in personal/system contexts.
	if (input.actor.userId) {
		data.user = { connect: { id: input.actor.userId } };
	}
	if (input.organizationId) {
		data.organization = { connect: { id: input.organizationId } };
	}
	if (input.projectId) {
		data.project = { connect: { id: input.projectId } };
	}

	return data;
}

function deriveCategoryFromAction(action: string): string {
	const prefix = action.split(".")[0];
	return prefix && prefix.length > 0 ? prefix : "audit";
}

// ============================================================================
// Observability counters (gap-friendly)
// ============================================================================

/**
 * Counter contract — implemented by `@repo/observability/lib/metrics.ts`
 * via the `auditWriteFailures` / `auditWritesTotal` Prometheus counters.
 * We import lazily through a no-op fallback so the database package can
 * stay free of an observability dependency at module load. Wiring is
 * completed by the API package's bootstrap (see `wireAuditObservability`
 * in `@repo/api/lib/audit`) before any real audit row is written; tests
 * can override via `__setAuditCountersForTest`.
 */
type AuditCounters = {
	incFailure: (action: string, category: string) => void;
	incWrite: (action: string, category: string, outcome: string) => void;
};

const noopCounters: AuditCounters = {
	incFailure: () => undefined,
	incWrite: () => undefined,
};

let auditCounters: AuditCounters = noopCounters;

/**
 * Wire real Prometheus counters from `@repo/observability`. Called once
 * at API/Temporal startup so the database package does not need a hard
 * dependency on the observability package. Safe to call multiple times.
 */
export function setAuditCounters(counters: AuditCounters): void {
	auditCounters = counters;
}

/** Test-only helper to replace or restore the counters. */
export function __setAuditCountersForTest(
	counters: AuditCounters | null,
): void {
	auditCounters = counters ?? noopCounters;
}

// ============================================================================
// Legacy-event mapping (fallback path)
// ============================================================================

/**
 * Collapse a new dot-action key onto the legacy SCREAMING_SNAKE
 * `AuditEventType` set so the stdout/webhook fallback at
 * `@repo/logs/audit-logger.ts` still has a structurally valid event to
 * emit when DB writes fail. Unknown actions fall back to `DATA_CREATE`.
 */
export function mapToLegacyEventType(action: string): AuditEventType {
	switch (action) {
		case "auth.login.success":
			return "AUTH_LOGIN_SUCCESS";
		case "auth.login.failure":
			return "AUTH_LOGIN_FAILED";
		case "auth.logout":
			return "AUTH_LOGOUT";
		case "auth.mfa.enabled":
			return "AUTH_MFA_ENABLED";
		case "auth.mfa.disabled":
			return "AUTH_MFA_DISABLED";
		case "auth.password.changed":
			return "AUTH_PASSWORD_CHANGED";
		case "auth.impersonation.started":
		case "auth.impersonation.ended":
			return "ADMIN_USER_SUSPENDED";
		case "org.api_key.created":
		case "account.api_key.created":
			return "AUTH_API_KEY_CREATED";
		case "org.api_key.revoked":
		case "account.api_key.revoked":
			return "AUTH_API_KEY_REVOKED";
		case "org.api_key.rotated":
		case "account.api_key.rotated":
			return "AUTH_API_KEY_CREATED";
		case "audit.api_request":
			return "DATA_READ";
		case "org.member.invited":
		case "org.member.role_changed":
		case "org.member.removed":
			return "AUTHZ_ROLE_CHANGED";
		case "org.integration.connected":
			return "ADMIN_INTEGRATION_ADDED";
		case "org.integration.disconnected":
			return "ADMIN_INTEGRATION_REMOVED";
		case "audit.viewed":
		case "userActivity.viewed":
			return "DATA_READ";
		case "audit.exported":
			return "DATA_EXPORT";
		case "audit.retention.purged":
			return "DATA_DELETE";
		case "org.deleted":
		case "project.deleted":
		case "story.deleted":
			return "DATA_DELETE";
		case "org.updated":
		case "org.settings.updated":
		case "project.updated":
		case "story.updated":
		case "story.status_changed":
		case "story.pm_pushed":
		case "story.reprioritized":
		case "org.integration.config_updated":
			return "DATA_UPDATE";
		case "project.archived":
			return "DATA_UPDATE";
		default:
			return "DATA_CREATE";
	}
}

function severityToLegacy(severity: AuditSeverityLevel): AuditSeverity {
	return severity;
}

// ============================================================================
// Failure handler (§7.2)
// ============================================================================

/**
 * Centralised handler for failed audit writes. Three actions per spec:
 *
 *  1. Structured `logger.error` with `event: "audit.write_failed"` so
 *     operators see the failure on stdout / in their log aggregator.
 *  2. Increment `fabric_audit_write_failures_total{action, category}` so
 *     dashboards can alert on a sustained increase.
 *  3. Fall back to the existing `@repo/logs/audit-logger.ts` (stdout +
 *     optional webhook) so the event itself is not lost even when the DB
 *     is unavailable. This is an emergency fallback, not a permanent
 *     dual-write — Phase 2 unifies the two paths.
 *
 * Exported for tests; production callers should NOT invoke directly.
 */
export function onAuditWriteFailure(
	input: RecordAuditInput,
	err: unknown,
): void {
	const action = input.action;
	const category =
		input.category ?? deriveCategoryFromAction(input.action) ?? "audit";

	const errorMessage = err instanceof Error ? err.message : String(err);
	const errorName = err instanceof Error ? err.name : "UnknownError";
	// Surface correlationId on every failure so operators can trace which
	// request the write attempt belongs to. Prefer the explicit input
	// (set by `recordAuditFromRequest`) over the AsyncLocalStorage fallback;
	// the explicit value is what landed (or would have landed) on the row.
	const correlationId =
		input.correlationId ?? getCorrelationIdFromContext() ?? null;

	logger.error(
		{
			event: "audit.write_failed",
			action,
			category,
			actorType: input.actor.type,
			correlationId,
			err: { message: errorMessage, name: errorName },
		},
		"Audit write failed",
	);

	auditCounters.incFailure(action, category);

	// Fire-and-forget the fallback emit; logAuditEvent itself never throws
	// but its internal transport sends can. We swallow any rejection so
	// the failure handler cannot itself become a failure source.
	void logAuditEvent(
		mapToLegacyEventType(action),
		`audit.write_failed: ${action}`,
		severityToLegacy(input.severity ?? "warning"),
		{
			userId:
				input.actor.type === "user" && input.actor.userId
					? input.actor.userId
					: undefined,
			organizationId: input.organizationId ?? undefined,
			resourceType: input.resource?.type,
			resourceId: input.resource?.id ?? undefined,
			clientIp: input.ipAddress ?? undefined,
			userAgent: input.userAgent ?? undefined,
		},
	).catch(() => undefined);
}

// ============================================================================
// Public helpers
// ============================================================================

/**
 * Fire-and-forget audit write. Returns `void` synchronously and never
 * throws — failures are routed to `onAuditWriteFailure` (structured log,
 * counter, stdout fallback). The default for API procedure callsites and
 * Temporal activities that don't need transactional parity with the
 * originating action.
 */
export function recordAudit(input: RecordAuditInput): void {
	void writeAuditRow(input).catch((err) => onAuditWriteFailure(input, err));
}

/**
 * Durable audit write. Awaits the insert (in its own transaction) and
 * PROPAGATES failures instead of routing them to the fire-and-forget failure
 * handler. Use when the row must be COMMITTED before a subsequent related
 * mutation — the canonical case is the `org.deleted` row written in
 * `beforeDeleteOrganization`: awaiting it there guarantees the row lands
 * BEFORE the organization-delete cascade, after which
 * `AuditLog.organizationId`'s ON DELETE SET NULL preserves it (a
 * fire-and-forget `recordAudit` races the cascade and can lose the row when
 * the delete's FK teardown wins). The caller decides whether a failure should
 * abort the operation or merely be logged.
 */
export async function recordAuditDurable(
	input: RecordAuditInput,
): Promise<void> {
	await writeAuditRow(input);
}

/**
 * Fill in the owning organization from the project when a caller omitted it.
 *
 * The organization audit log filters STRICTLY on `organizationId`, so a
 * project-scoped row written without one is persisted and then unreachable from
 * the surface that exists to read it. That is not hypothetical: every QA event —
 * a test run dispatched, a credential changed, a CI run triggered — was written
 * that way and invisible in the org log until each call site was found and fixed
 * individually. Deriving it here closes the class instead of the instances, so a
 * new project-scoped caller cannot reintroduce it.
 *
 * Derives ONLY when the field is absent. An explicit `null` is a caller SAYING
 * "personal context" — `audit-error-middleware.ts` returns exactly that to
 * distinguish it from "the input does not carry the field" — and overriding it
 * would move a row into an organization its author deliberately kept out of.
 * Omission is the only unambiguous "I don't know".
 *
 * A personal-context project has no organization, so this returns null for it
 * anyway: the correct value, not a fallback.
 */
async function resolveAuditOrganizationId(
	input: RecordAuditInput,
	client: Prisma.TransactionClient = db,
): Promise<string | null | undefined> {
	if (input.organizationId !== undefined || !input.projectId) {
		return input.organizationId;
	}
	try {
		const project = await client.project.findUnique({
			where: { id: input.projectId },
			select: { organizationId: true },
		});
		return project?.organizationId ?? null;
	} catch (err) {
		// An audit row with a null organization is bad; losing the row, or
		// failing the mutation it was auditing, is worse. Report and carry on
		// with whatever the caller gave us.
		logger.warn(
			{
				event: "audit.organization_derivation_failed",
				action: input.action,
				projectId: input.projectId,
				err: {
					message: err instanceof Error ? err.message : String(err),
				},
			},
			"Could not derive the audit row's organization from its project",
		);
		return input.organizationId;
	}
}

async function writeAuditRow(input: RecordAuditInput): Promise<void> {
	const organizationId = await resolveAuditOrganizationId(input);
	const data = buildAuditRow({ ...input, organizationId });
	await db.auditLog.create({ data });
	auditCounters.incWrite(
		input.action,
		input.category ?? deriveCategoryFromAction(input.action),
		input.outcome ?? "success",
	);
}

/**
 * Transactional audit write. Awaits the insert inside the caller's
 * transaction so the audit row commits or rolls back with the
 * originating action. Errors propagate — the caller can choose to
 * abandon the transaction (canonical use: a security-critical mutation
 * that must NOT happen if the audit row cannot be persisted).
 *
 * Note: `AuditLog.organizationId` is ON DELETE SET NULL (not cascade) as of
 * migration 20260702130000_audit_log_worm_tamper_evidence, so an `org.deleted`
 * row now SURVIVES the organization delete — the FK is nulled and the
 * actor/resource/metadata snapshots retain the org identity. The
 * `beforeDeleteOrganization` hook records it with `recordAuditDurable` (which
 * awaits the commit before the delete proceeds); this transactional form
 * remains available for callers that must commit an audit row atomically with
 * a security-critical mutation inside their own transaction.
 */
export async function recordAuditTx(
	tx: Prisma.TransactionClient,
	input: RecordAuditInput,
): Promise<void> {
	// Read the project through the caller's transaction, not a fresh connection:
	// a project created earlier in this same transaction is invisible outside it,
	// and an audit row for it must not lose its organization.
	const organizationId = await resolveAuditOrganizationId(input, tx);
	const data = buildAuditRow({ ...input, organizationId });
	await tx.auditLog.create({ data });
	auditCounters.incWrite(
		input.action,
		input.category ?? deriveCategoryFromAction(input.action),
		input.outcome ?? "success",
	);
}

// ============================================================================
// Read API: filter / cursor / list / export (Task 2.3, 2.4)
// ============================================================================

/**
 * Shape of a returned `AuditLog` row. We intentionally avoid coupling the
 * API layer to the raw Prisma type so that the SELECT projection can stay
 * stable even if columns are added or renamed downstream.
 */
export interface AuditLogRow {
	id: string;
	organizationId: string | null;
	userId: string | null;
	actorType: string;
	actorEmailSnapshot: string | null;
	actorNameSnapshot: string | null;
	impersonatedById: string | null;
	action: string;
	category: string;
	severity: string;
	outcome: string;
	resourceType: string | null;
	resourceId: string | null;
	resourceName: string | null;
	projectId: string | null;
	ipAddress: string | null;
	userAgent: string | null;
	requestId: string | null;
	sessionId: string | null;
	metadata: unknown;
	/**
	 * Procedure latency in milliseconds. Populated by the
	 * `auditTimingMiddleware` for request-scoped emissions; null for rows
	 * written outside the request boundary (e.g., retention activities).
	 */
	durationMs: number | null;
	createdAt: Date;
}

/**
 * Filter shape shared by `listAuditLog` and `exportAuditLog`. Every field
 * is optional; an empty filter means "all rows visible to the current
 * tenant scope". The tenant scope itself (organizationId / userId) is
 * passed separately because the deployment-admin bypass changes who can
 * resolve which scope.
 */
export interface AuditLogFilter {
	actions?: string[];
	categories?: string[];
	actorIds?: string[];
	/**
	 * Filter to actor type buckets (`user`, `api_key`, `system`, `agent`).
	 * Allows operators to scope to API-key traffic or system writes without
	 * picking individual members.
	 */
	actorTypes?: string[];
	projectId?: string | null;
	severities?: string[];
	outcomes?: string[];
	dateFrom?: Date;
	dateTo?: Date;
	/**
	 * Exact-match filter on `metadata.correlationId`. Used by the viewer to
	 * pull every row participating in a single request flow.
	 */
	correlationId?: string;
	/**
	 * Case-insensitive substring match on `ipAddress`.
	 */
	ipAddressContains?: string;
	/**
	 * Case-insensitive substring match across the human-readable columns
	 * (`resourceName`, `actorNameSnapshot`, `actorEmailSnapshot`). Backs the
	 * history viewer's free-text search box.
	 */
	search?: string;
	/**
	 * User ids whose name/email matched the viewer's `search` term. ORed into
	 * the search clause so AI-attributed rows (whose actor snapshot is
	 * "Fabric AI") still surface when searching for the human who triggered
	 * them — keeping search consistent with the displayed attribution.
	 */
	searchUserIds?: string[];
}

/**
 * Sort order applied by `listAuditLog`. Default `newest` keeps the
 * existing (createdAt DESC, id DESC) plan so the BTREE index continues
 * to back the dominant query shape.
 */
export type AuditLogSort = "newest" | "oldest" | "severity_desc";

/**
 * Tenant scope for a list/export call. `organizationId` non-null selects
 * the org viewer; `organizationId === null` selects personal context and
 * also requires `userId` so we can constrain the query to that user.
 */
export interface AuditLogScope {
	organizationId: string | null;
	userId?: string | null;
}

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;
/**
 * Hard cap on export rows per D7. Beyond this the procedure rejects so
 * an operator can refine filters; v1 does not stream async export jobs.
 */
export const AUDIT_EXPORT_ROW_CAP = 50_000;

/**
 * Cursor payload — opaque to the client but a structured shape on the
 * server. Encoded as base64 of JSON `{ createdAt: ISO, id: string }` so
 * the (createdAt, id) page-tuple is round-trippable without ambiguity
 * when two rows share a millisecond timestamp.
 */
interface AuditLogCursorPayload {
	createdAt: string;
	id: string;
}

export function encodeAuditLogCursor(payload: {
	createdAt: Date;
	id: string;
}): string {
	const json = JSON.stringify({
		createdAt: payload.createdAt.toISOString(),
		id: payload.id,
	});
	return Buffer.from(json, "utf8").toString("base64");
}

/**
 * Decode an opaque cursor produced by `encodeAuditLogCursor`. Returns
 * null when the cursor is malformed so the caller can throw `BAD_REQUEST`
 * without us having to import `@orpc/server` from the database package.
 */
export function decodeAuditLogCursor(
	raw: string,
): AuditLogCursorPayload | null {
	try {
		const json = Buffer.from(raw, "base64").toString("utf8");
		const parsed = JSON.parse(json) as unknown;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			Array.isArray(parsed)
		) {
			return null;
		}
		const candidate = parsed as Record<string, unknown>;
		if (
			typeof candidate.createdAt !== "string" ||
			typeof candidate.id !== "string"
		) {
			return null;
		}
		const parsedDate = new Date(candidate.createdAt);
		if (Number.isNaN(parsedDate.getTime())) {
			return null;
		}
		return {
			createdAt: candidate.createdAt,
			id: candidate.id,
		};
	} catch {
		return null;
	}
}

/**
 * Compose the WHERE clause shared by list and count queries. Tenant
 * scoping is REQUIRED here — never call without a scope.
 *
 * The XOR pattern from AGENTS.md is enforced by the caller passing the
 * resolved scope; in personal context, `organizationId` is `null` AND
 * `userId` is set so the helper anchors the result on the caller's user
 * id.
 */
function buildAuditWhere(
	scope: AuditLogScope,
	filter: AuditLogFilter,
): Prisma.AuditLogWhereInput {
	const where: Prisma.AuditLogWhereInput = {};

	if (scope.organizationId) {
		where.organizationId = scope.organizationId;
	} else {
		// Personal context — XOR per D14. Requires userId so we cannot leak
		// rows from another user's personal context.
		where.organizationId = null;
		if (scope.userId) {
			where.userId = scope.userId;
		}
	}

	if (filter.actions && filter.actions.length > 0) {
		where.action = { in: filter.actions };
	}
	if (filter.categories && filter.categories.length > 0) {
		where.category = { in: filter.categories };
	}
	if (filter.actorIds && filter.actorIds.length > 0) {
		// SECURITY (SOC 2 CC7.2): actor filtering is only valid in ORG context,
		// where `where.organizationId` isolates the tenant. In personal context
		// the where is anchored to the caller's own `userId` above; overwriting
		// it with attacker-supplied actorIds would expose another user's
		// personal audit trail. In personal context the caller is the only
		// actor, so narrowing by actorIds is redundant anyway.
		if (scope.organizationId) {
			where.userId = { in: filter.actorIds };
		}
	}
	if (filter.actorTypes && filter.actorTypes.length > 0) {
		where.actorType = { in: filter.actorTypes };
	}
	if (filter.projectId) {
		where.projectId = filter.projectId;
	}
	if (filter.severities && filter.severities.length > 0) {
		where.severity = { in: filter.severities };
	}
	if (filter.outcomes && filter.outcomes.length > 0) {
		where.outcome = { in: filter.outcomes };
	}
	if (filter.dateFrom || filter.dateTo) {
		where.createdAt = {};
		if (filter.dateFrom) {
			where.createdAt.gte = filter.dateFrom;
		}
		if (filter.dateTo) {
			where.createdAt.lt = filter.dateTo;
		}
	}

	if (filter.correlationId && filter.correlationId.length > 0) {
		// Prisma's JSON filtering reaches into the metadata object via the
		// `path` notation. Postgres' jsonb operators back this so the existing
		// btree indexes on metadata-less columns are unaffected; for high
		// volume this would benefit from a partial GIN index, deferred to
		// Phase 2 (see performance-notes.md).
		where.metadata = {
			path: ["correlationId"],
			equals: filter.correlationId,
		};
	}

	if (filter.ipAddressContains && filter.ipAddressContains.length > 0) {
		where.ipAddress = {
			contains: filter.ipAddressContains,
			mode: "insensitive",
		};
	}

	if (filter.search && filter.search.trim().length > 0) {
		// Case-insensitive substring across the human-readable columns so the
		// history viewer's search box can match a ticket title or an actor.
		// `searchUserIds` (resolved by the caller from the same term) lets an
		// AI-attributed row surface when searching for the human who triggered
		// it, even though its actor snapshot reads "Fabric AI".
		const term = filter.search.trim();
		const searchOr: Prisma.AuditLogWhereInput[] = [
			{ resourceName: { contains: term, mode: "insensitive" } },
			{ actorNameSnapshot: { contains: term, mode: "insensitive" } },
			{ actorEmailSnapshot: { contains: term, mode: "insensitive" } },
		];
		if (filter.searchUserIds && filter.searchUserIds.length > 0) {
			searchOr.push({ userId: { in: filter.searchUserIds } });
		}
		// Push into `where.AND` (not top-level `where.OR`) so it composes
		// safely with the keyset cursor clause that `applyCursorToWhere` also
		// appends to `where.AND`.
		const searchClause: Prisma.AuditLogWhereInput = { OR: searchOr };
		where.AND = where.AND
			? Array.isArray(where.AND)
				? [...where.AND, searchClause]
				: [where.AND, searchClause]
			: [searchClause];
	}

	return where;
}

/**
 * Compose an `OR` clause that implements "(createdAt, id) < cursor" (or
 * `>` for ascending sort) with Prisma's strict-typed where shape.
 * Required because Prisma does not support tuple comparisons in `where`
 * directly; the cursor is applied as a strict less-than/greater-than on
 * `createdAt`, OR equal `createdAt` AND `id` less-than/greater-than. This
 * keeps tie-breaks at the millisecond level deterministic.
 */
function applyCursorToWhere(
	where: Prisma.AuditLogWhereInput,
	cursor: AuditLogCursorPayload,
	direction: "desc" | "asc" = "desc",
): Prisma.AuditLogWhereInput {
	const cursorDate = new Date(cursor.createdAt);
	const cursorClause: Prisma.AuditLogWhereInput =
		direction === "asc"
			? {
					OR: [
						{ createdAt: { gt: cursorDate } },
						{
							AND: [
								{ createdAt: cursorDate },
								{ id: { gt: cursor.id } },
							],
						},
					],
				}
			: {
					OR: [
						{ createdAt: { lt: cursorDate } },
						{
							AND: [
								{ createdAt: cursorDate },
								{ id: { lt: cursor.id } },
							],
						},
					],
				};
	// AND together whatever filter the user passed and the cursor.
	if (!where.AND) {
		return { ...where, AND: [cursorClause] };
	}
	const existing = Array.isArray(where.AND) ? where.AND : [where.AND];
	return { ...where, AND: [...existing, cursorClause] };
}

/**
 * Map a sort enum to a Prisma `orderBy` clause. `newest`/`oldest`
 * compose directly on (createdAt, id); `severity_desc` is implemented
 * via the BTREE-backed (createdAt, id) order with a post-fetch re-rank
 * by `SEVERITY_RANK` so the cursor encoding (`createdAt`,`id`) keeps
 * the cursor stable across pages.
 */
function buildAuditOrderBy(
	sort: AuditLogSort,
): Prisma.AuditLogOrderByWithRelationInput[] {
	if (sort === "oldest") {
		return [{ createdAt: "asc" }, { id: "asc" }];
	}
	// severity_desc and newest both fetch newest-first; severity_desc
	// re-ranks the page in JS by severity bucket (critical > error >
	// warning > info) before returning.
	return [{ createdAt: "desc" }, { id: "desc" }];
}

/**
 * Numerical rank for the severity string. Higher rank = more severe.
 * Used by the `severity_desc` sort to reorder the in-memory page after
 * the DB fetch.
 */
const SEVERITY_RANK: Record<string, number> = {
	critical: 4,
	error: 3,
	warning: 2,
	info: 1,
};

function rerankBySeverity(rows: AuditLogRow[]): AuditLogRow[] {
	return [...rows].sort((a, b) => {
		const ra = SEVERITY_RANK[a.severity] ?? 0;
		const rb = SEVERITY_RANK[b.severity] ?? 0;
		if (ra !== rb) {
			return rb - ra;
		}
		// Tie-break on createdAt DESC, then id DESC so identical severities
		// keep the chronological-newest order.
		const ta = a.createdAt.getTime();
		const tb = b.createdAt.getTime();
		if (ta !== tb) {
			return tb - ta;
		}
		return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
	});
}

/**
 * Read a page of audit-log rows. Default order is `createdAt DESC, id
 * DESC`. The returned `nextCursor` is opaque and can be passed back as
 * `input.cursor` to the next call to continue paginating.
 *
 * `totalCount` is populated ONLY when `cursor` is unset (initial query)
 * so the client export button can show a confirm dialog above 5k rows.
 * Subsequent pages skip the count query for performance.
 *
 * Sort:
 *  - `newest` (default): `(createdAt DESC, id DESC)` — direct index hit.
 *  - `oldest`:           `(createdAt ASC, id ASC)`  — index still used.
 *  - `severity_desc`:    fetches the page newest-first then reorders the
 *                        in-memory page by severity rank. The cursor is
 *                        still keyed off `(createdAt, id)` so subsequent
 *                        pages remain stable.
 */
export async function listAuditLog(args: {
	scope: AuditLogScope;
	filter: AuditLogFilter;
	cursor: string | null;
	limit: number;
	sort?: AuditLogSort;
}): Promise<{
	items: AuditLogRow[];
	nextCursor: string | null;
	totalCount?: number;
}> {
	const limit = Math.min(
		Math.max(1, args.limit || DEFAULT_LIST_LIMIT),
		MAX_LIST_LIMIT,
	);
	const sort: AuditLogSort = args.sort ?? "newest";

	const baseWhere = buildAuditWhere(args.scope, args.filter);

	let where = baseWhere;
	if (args.cursor) {
		const decoded = decodeAuditLogCursor(args.cursor);
		if (!decoded) {
			throw new Error("Invalid cursor");
		}
		where = applyCursorToWhere(
			baseWhere,
			decoded,
			sort === "oldest" ? "asc" : "desc",
		);
	}

	const orderBy = buildAuditOrderBy(sort);

	// Fetch limit+1 so we know whether another page exists without an
	// extra count query.
	const rows = await db.auditLog.findMany({
		where,
		orderBy,
		take: limit + 1,
	});

	const hasMore = rows.length > limit;
	const dbRows = (hasMore ? rows.slice(0, limit) : rows) as AuditLogRow[];

	// For severity_desc we re-rank the visible page in memory. The cursor
	// encoded below still uses the DB-order's last row so subsequent
	// pages remain index-backed.
	const items = sort === "severity_desc" ? rerankBySeverity(dbRows) : dbRows;
	const lastDbRow = dbRows.at(-1);

	const nextCursor =
		hasMore && lastDbRow
			? encodeAuditLogCursor({
					createdAt: lastDbRow.createdAt,
					id: lastDbRow.id,
				})
			: null;

	const result: {
		items: AuditLogRow[];
		nextCursor: string | null;
		totalCount?: number;
	} = { items, nextCursor };

	if (!args.cursor) {
		result.totalCount = await db.auditLog.count({ where: baseWhere });
	}

	return result;
}

/**
 * Count audit-log rows matching a scope+filter. Used by the export
 * procedure to enforce the 50k cap before streaming a file.
 */
export async function countAuditLog(args: {
	scope: AuditLogScope;
	filter: AuditLogFilter;
}): Promise<number> {
	const where = buildAuditWhere(args.scope, args.filter);
	return await db.auditLog.count({ where });
}

/**
 * Fetch all rows matching a scope+filter, ordered ASC by `createdAt`,
 * for export. Caller MUST call `countAuditLog` first and reject when
 * the count exceeds `AUDIT_EXPORT_ROW_CAP`. Returning ASC so analysts
 * reading the file top-to-bottom see oldest→newest.
 */
export async function fetchAuditLogForExport(args: {
	scope: AuditLogScope;
	filter: AuditLogFilter;
}): Promise<AuditLogRow[]> {
	const where = buildAuditWhere(args.scope, args.filter);
	const rows = await db.auditLog.findMany({
		where,
		orderBy: [{ createdAt: "asc" }, { id: "asc" }],
	});
	return rows as AuditLogRow[];
}

/** Default page size for the read-only decision-overrides list. */
const DECISION_OVERRIDE_LIST_LIMIT = 100;

/**
 * List the immutable `decision.override_accepted` rows for a single project,
 * newest-first. A thin wrapper over `listAuditLog` so the read-only Overrides
 * view in the Decisions tab reuses the same scope-aware WHERE (XOR tenant
 * isolation) and index plan instead of issuing its own query. Returns just the
 * rows (no pagination) — the view shows the most recent overrides, capped.
 */
export async function listDecisionOverrideAuditRows(args: {
	scope: AuditLogScope;
	projectId: string;
	limit?: number;
}): Promise<AuditLogRow[]> {
	const { items } = await listAuditLog({
		scope: args.scope,
		filter: {
			projectId: args.projectId,
			actions: ["decision.override_accepted"],
		},
		cursor: null,
		limit: args.limit ?? DECISION_OVERRIDE_LIST_LIMIT,
	});
	return items;
}

export interface AuditLogStatsResult {
	eventsToday: number;
	failuresToday: number;
	uniqueActorsToday: number;
	lastEventAt: Date | null;
	/**
	 * Most-frequent action key in today's window, with its count. Null
	 * when there are no events today.
	 */
	topAction: { action: string; count: number } | null;
	/**
	 * Hourly event counts for the rolling 24-hour window, oldest first
	 * (24 entries). Empty hours are zero.
	 */
	hourlyVolume: number[];
	/**
	 * Distinct sessionIds today — proxy for "active sessions across the
	 * tenant". Null-safe: rows without a session (REST API, system) are
	 * excluded.
	 */
	sessionsToday: number;
	/**
	 * Average procedure latency in milliseconds across the requested
	 * window (v2 item 5). NULL when no rows in the window carry a
	 * `durationMs` value.
	 */
	averageLatencyMs: number | null;
	/**
	 * Bucketed average latency over the requested window. Bucket count
	 * matches the resolution implied by `latencyWindow`:
	 *   1h  → 12 buckets of  5 min each
	 *   6h  → 12 buckets of 30 min each
	 *   24h → 24 buckets of  1 hr  each (default)
	 *   7d  →  7 buckets of  1 day each
	 *
	 * Each entry is the mean `durationMs` of rows landing in that bucket,
	 * or 0 if the bucket is empty.
	 */
	latencySparkline: number[];
	/**
	 * The window the latency stats were computed over. Echoed back so the
	 * caller doesn't need to remember which value it sent.
	 */
	latencyWindow: AuditLatencyWindow;
}

/**
 * Supported latency windows for the stats strip's average-latency card.
 */
export type AuditLatencyWindow = "1h" | "6h" | "24h" | "7d";

function latencyWindowConfig(window: AuditLatencyWindow): {
	durationMs: number;
	bucketCount: number;
} {
	switch (window) {
		case "1h":
			return { durationMs: 60 * 60 * 1000, bucketCount: 12 };
		case "6h":
			return { durationMs: 6 * 60 * 60 * 1000, bucketCount: 12 };
		case "7d":
			return { durationMs: 7 * 24 * 60 * 60 * 1000, bucketCount: 7 };
		default:
			return { durationMs: 24 * 60 * 60 * 1000, bucketCount: 24 };
	}
}

/**
 * Aggregate counts for the stats strip above the viewer.
 *
 * Uses the same scope-aware WHERE the list/export helpers build so RLS +
 * XOR isolation are preserved. "Today" is anchored at server-side
 * midnight UTC; clients display the result in their local timezone via
 * `formatDistanceToNow` so the boundary feels consistent. Two queries
 * back this:
 *
 *   1. Three count() calls with merged AND filters for events, failures,
 *      and the distinct-actors count via `findMany({ distinct })`.
 *   2. One `findFirst` to pick up the most recent event timestamp across
 *      the full scope (NOT bounded to today, so the strip is still useful
 *      on quiet days).
 *
 * Distinct on `userId` is null-safe — `null` is one of the distinct
 * values returned for system events, which we exclude in the count.
 */
export async function aggregateAuditLogStats(args: {
	scope: AuditLogScope;
	/**
	 * Time window for the latency aggregation (v2 item 5). Defaults to
	 * "24h" so callers that haven't yet adopted the selector get a
	 * sensible default.
	 */
	latencyWindow?: AuditLatencyWindow;
}): Promise<AuditLogStatsResult> {
	const now = new Date();
	const startOfToday = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	// Hourly volume covers the last 24 hours (rolling), bucketed by
	// UTC hour. We fetch the per-row createdAt so the in-app aggregation
	// stays portable across Postgres versions (no date_trunc usage).
	const startOfWindow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const latencyWindow: AuditLatencyWindow = args.latencyWindow ?? "24h";
	const { durationMs: latencyWindowMs, bucketCount: latencyBucketCount } =
		latencyWindowConfig(latencyWindow);
	const startOfLatencyWindow = new Date(now.getTime() - latencyWindowMs);
	const scopeWhere = buildAuditWhere(args.scope, {});
	const todayWhere: Prisma.AuditLogWhereInput = {
		...scopeWhere,
		createdAt: { gte: startOfToday },
	};
	const last24hWhere: Prisma.AuditLogWhereInput = {
		...scopeWhere,
		createdAt: { gte: startOfWindow },
	};
	const latencyWhere: Prisma.AuditLogWhereInput = {
		...scopeWhere,
		createdAt: { gte: startOfLatencyWindow },
		durationMs: { not: null },
	};
	const failuresWhere: Prisma.AuditLogWhereInput = {
		...todayWhere,
		outcome: "failure",
	};

	const [
		eventsToday,
		failuresToday,
		actorRows,
		latest,
		topActionRows,
		last24Rows,
		latencyRows,
		sessionRows,
	] = await Promise.all([
		db.auditLog.count({ where: todayWhere }),
		db.auditLog.count({ where: failuresWhere }),
		db.auditLog.findMany({
			where: { ...todayWhere, userId: { not: null } },
			distinct: ["userId"],
			select: { userId: true },
		}),
		db.auditLog.findFirst({
			where: scopeWhere,
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			select: { createdAt: true },
		}),
		// Group by action; Prisma's `_count` runs as a Postgres aggregate.
		// Top action today is bounded by the today window so the strip's
		// label "Top action today" is correct.
		db.auditLog.groupBy({
			by: ["action"],
			where: todayWhere,
			_count: { action: true },
			orderBy: { _count: { action: "desc" } },
			take: 1,
		}),
		// Volume: createdAt only — we bucket in JS to keep the query plan
		// trivial. Cardinality is bounded by event volume × 24h, which is
		// well within the indexed range for any sane org.
		db.auditLog.findMany({
			where: last24hWhere,
			select: { createdAt: true },
		}),
		// Latency rows. We pull only `(createdAt, durationMs)` so the
		// per-row payload stays tiny and the existing
		// `audit_log_idx_org_created` index covers the read. Aggregation
		// happens in JS so the bucket math is identical across DB
		// engines and we don't need a Postgres date_trunc dependency.
		db.auditLog.findMany({
			where: latencyWhere,
			select: { createdAt: true, durationMs: true },
		}),
		// Sessions today: distinct sessionIds (excluding NULL — system
		// writes don't carry one).
		db.auditLog.findMany({
			where: { ...todayWhere, sessionId: { not: null } },
			distinct: ["sessionId"],
			select: { sessionId: true },
		}),
	]);

	const topActionEntry = topActionRows[0];
	const topAction = topActionEntry
		? {
				action: topActionEntry.action as string,
				count: (topActionEntry._count?.action ?? 0) as number,
			}
		: null;

	const hourlyVolume = Array.from({ length: 24 }, () => 0) as number[];
	const windowStart = startOfWindow.getTime();
	for (const row of last24Rows) {
		const offsetMs = row.createdAt.getTime() - windowStart;
		if (offsetMs < 0) {
			continue;
		}
		const hourIdx = Math.floor(offsetMs / (60 * 60 * 1000));
		const safeIdx = Math.min(23, Math.max(0, hourIdx));
		hourlyVolume[safeIdx] = (hourlyVolume[safeIdx] ?? 0) + 1;
	}

	// Latency aggregate + per-bucket mean.
	let latencyTotal = 0;
	let latencyCount = 0;
	const latencyBucketSum = Array.from(
		{ length: latencyBucketCount },
		() => 0,
	);
	const latencyBucketCountArr = Array.from(
		{ length: latencyBucketCount },
		() => 0,
	);
	const latencyWindowStart = startOfLatencyWindow.getTime();
	const bucketMs = latencyWindowMs / latencyBucketCount;
	for (const row of latencyRows) {
		const dur =
			typeof row.durationMs === "number" &&
			Number.isFinite(row.durationMs)
				? row.durationMs
				: null;
		if (dur === null || dur < 0) {
			continue;
		}
		const offsetMs = row.createdAt.getTime() - latencyWindowStart;
		if (offsetMs < 0) {
			continue;
		}
		const bIdx = Math.min(
			latencyBucketCount - 1,
			Math.max(0, Math.floor(offsetMs / bucketMs)),
		);
		latencyTotal += dur;
		latencyCount += 1;
		latencyBucketSum[bIdx] = (latencyBucketSum[bIdx] ?? 0) + dur;
		latencyBucketCountArr[bIdx] = (latencyBucketCountArr[bIdx] ?? 0) + 1;
	}
	const averageLatencyMs =
		latencyCount > 0 ? latencyTotal / latencyCount : null;
	const latencySparkline = latencyBucketSum.map((sum, i) => {
		const c = latencyBucketCountArr[i] ?? 0;
		return c > 0 ? sum / c : 0;
	});

	return {
		eventsToday,
		failuresToday,
		uniqueActorsToday: actorRows.length,
		lastEventAt: latest?.createdAt ?? null,
		topAction,
		hourlyVolume,
		sessionsToday: sessionRows.length,
		averageLatencyMs,
		latencySparkline,
		latencyWindow,
	};
}
