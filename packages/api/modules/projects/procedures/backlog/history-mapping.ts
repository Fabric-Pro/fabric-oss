/**
 * Pure mapping helpers + output schemas shared by the two AI Backlog history
 * endpoints (`history.audit.list` and `history.sessions.list`).
 *
 * Kept dependency-light (only `zod`) so the mapping logic — especially the
 * AI-vs-user actor attribution (FR-11) — is unit-testable in isolation.
 */

import { z } from "zod";

/**
 * The backlog-item audit actions surfaced in the history view. Scoped to ticket
 * lifecycle changes. A status move the PM status sync applied
 * (`story.pm_status_synced`, Fizzy #2304) is one of them even though no person
 * made it; the other PM-sync / auto-hide book-keeping actions stay excluded from
 * the v1 history.
 */
export const STORY_AUDIT_ACTIONS = [
	"story.created",
	"story.updated",
	"story.status_changed",
	"story.pm_status_synced",
	"story.deleted",
] as const;

/** The PM status sync's own audit action (spec §4.4). */
const PM_STATUS_SYNC_AUDIT_ACTION = "story.pm_status_synced";

type HistoryActionFilter =
	| "all"
	| "created"
	| "updated"
	| "status_changed"
	| "deleted";
type HistoryActorFilter = "all" | "ai" | "human";

/** Friendly action-filter keys → the underlying `AuditLog.action` values. */
const ACTIONS_BY_FILTER: Record<
	Exclude<HistoryActionFilter, "all">,
	readonly string[]
> = {
	created: ["story.created"],
	updated: ["story.updated"],
	status_changed: ["story.status_changed", PM_STATUS_SYNC_AUDIT_ACTION],
	deleted: ["story.deleted"],
};

/**
 * The `AuditLog.action` values one history query covers. "Status changed"
 * includes the PM status sync's moves. The AI bucket selects `agent`/`system`
 * actors, and a synced move's actor is `system` — but the move is neither
 * AI-made nor person-made (`mapAuditRow` gives it `isAI: false` and the tool as
 * its actor), so the AI bucket leaves it out.
 */
export function resolveHistoryActions(filter: {
	action?: HistoryActionFilter;
	actor?: HistoryActorFilter;
}): string[] {
	const actions =
		filter.action && filter.action !== "all"
			? [...ACTIONS_BY_FILTER[filter.action]]
			: [...STORY_AUDIT_ACTIONS];
	return filter.actor === "ai"
		? actions.filter((action) => action !== PM_STATUS_SYNC_AUDIT_ACTION)
		: actions;
}

// ---------------------------------------------------------------------------
// Audit tab
// ---------------------------------------------------------------------------

export const auditHistoryItemSchema = z.object({
	id: z.string(),
	action: z.string(),
	actorType: z.string(),
	isAI: z.boolean(),
	actorName: z.string().nullable(),
	actorEmail: z.string().nullable(),
	actorImage: z.string().nullable(),
	resourceId: z.string().nullable(),
	resourceName: z.string().nullable(),
	/** Human ticket identifier (F-XXX / B-XXX); null when deleted or unresolved. */
	identifier: z.string().nullable(),
	/** Where the change came from — e.g. "AI Update" / "Slack" / "Teams"; null = manual. */
	source: z.string().nullable(),
	changedFields: z.array(z.string()).nullable(),
	statusName: z.string().nullable(),
	/** Id of the AI Update session that produced this change, when linkable. */
	sessionId: z.string().nullable(),
	/** True when the ticket no longer exists (deleted after this change). */
	deleted: z.boolean(),
	/**
	 * Stable key shared by changes from one request/bulk (request correlationId,
	 * else the originating proposal id). Null when neither is recorded — the UI
	 * then falls back to an actor+source+time cluster. Drives the bulk grouping.
	 */
	groupKey: z.string().nullable(),
	createdAt: z.coerce.date(),
});

export type BacklogAuditHistoryItem = z.infer<typeof auditHistoryItemSchema>;

/** Subset of an `AuditLog` row that `mapAuditRow` reads. */
export interface AuditRowLike {
	id: string;
	action: string;
	actorType: string;
	userId: string | null;
	actorNameSnapshot: string | null;
	actorEmailSnapshot: string | null;
	resourceId: string | null;
	resourceName: string | null;
	metadata: unknown;
	createdAt: Date;
}

/** Live user resolved from `AuditLog.userId` at read time. */
export interface ResolvedActorUser {
	name: string | null;
	email: string | null;
	image: string | null;
}

/**
 * Extract the originating proposal id from an audit row's metadata. Used to
 * link an AI-attributed backlog change back to its `BacklogUpdateSession`.
 * Returns null when the row didn't carry one (e.g. a manual user change).
 */
export function extractProposalId(metadata: unknown): string | null {
	if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
		const value = (metadata as Record<string, unknown>).proposalId;
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return null;
}

/** The PM tool a status-sync audit row names, or a generic fallback. */
function pmToolName(meta: Record<string, unknown>): string {
	const tool = typeof meta.pmTool === "string" ? meta.pmTool.trim() : "";
	return tool.length > 0 ? tool : "PM tool";
}

/**
 * Human-readable source of a change, derived from the audit metadata. Returns
 * null for ordinary manual user actions (the actor's name already conveys
 * that). Covers the AI Update sidebar, the Slack/Teams channel proposals and
 * the hourly PM status sync — the only paths that stamp a `source` today.
 */
export function deriveChangeSource(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const meta = metadata as Record<string, unknown>;
	const src = typeof meta.source === "string" ? meta.source : null;
	const reporter =
		typeof meta.reporterSource === "string" ? meta.reporterSource : null;
	if (src === "AI_UPDATE" || src === "AI_BACKLOG_UPDATE") {
		return "AI Update";
	}
	if (src === "APPROVED_PROPOSAL") {
		if (reporter === "SLACK") {
			return "Slack";
		}
		if (reporter === "TEAMS") {
			return "Teams";
		}
		return "Monitored channel";
	}
	// Fizzy #2304: a status move the hourly PM status sync applied.
	if (src === "PM_STATUS_SYNC") {
		return `${pmToolName(meta)} sync`;
	}
	return null;
}

export function mapAuditRow(
	row: AuditRowLike,
	resolved?: {
		user?: ResolvedActorUser | null;
		sessionId?: string | null;
		identifier?: string | null;
		/** True when the resource (ticket) no longer exists. */
		deleted?: boolean;
	},
): BacklogAuditHistoryItem {
	const meta =
		row.metadata &&
		typeof row.metadata === "object" &&
		!Array.isArray(row.metadata)
			? (row.metadata as Record<string, unknown>)
			: {};
	// A move the PM status sync applied is written by the `system` actor, but it
	// is not an AI change: the PM tool made it (Fizzy #2304). Every other
	// agent/system-authored backlog change gets the "AI" tag; within the story.*
	// action set only the agent instrumentation writes those.
	const isPmStatusSync = row.action === PM_STATUS_SYNC_AUDIT_ACTION;
	const isAI =
		!isPmStatusSync &&
		(row.actorType === "agent" || row.actorType === "system");
	const user = resolved?.user ?? null;
	const changedFields = Array.isArray(meta.changedFields)
		? (meta.changedFields.filter((f) => typeof f === "string") as string[])
		: null;
	// Group changes from one request/bulk: the request correlationId, else the
	// originating proposal id. Null ⇒ the UI clusters by actor+source+time.
	const groupKey =
		(typeof meta.correlationId === "string" && meta.correlationId) ||
		(typeof meta.proposalId === "string" && meta.proposalId) ||
		null;
	return {
		id: row.id,
		action: row.action,
		actorType: row.actorType,
		isAI,
		// Prefer the live user resolved from `userId` so an AI-attributed row
		// shows the *human* who triggered it (with `isAI` adding the "AI" tag),
		// falling back to the write-time snapshot, then to the PM tool for a
		// synced move, then to "Fabric AI".
		actorName:
			user?.name ??
			row.actorNameSnapshot ??
			(isPmStatusSync ? pmToolName(meta) : isAI ? "Fabric AI" : null),
		actorEmail: user?.email ?? row.actorEmailSnapshot ?? null,
		actorImage: user?.image ?? null,
		resourceId: row.resourceId ?? null,
		resourceName: row.resourceName ?? null,
		identifier: resolved?.identifier ?? null,
		source: deriveChangeSource(row.metadata),
		changedFields,
		statusName:
			typeof meta.statusName === "string" ? meta.statusName : null,
		sessionId: resolved?.sessionId ?? null,
		deleted: resolved?.deleted ?? false,
		groupKey,
		createdAt: row.createdAt,
	};
}

// ---------------------------------------------------------------------------
// Session history tab
// ---------------------------------------------------------------------------

const sessionChangeSchema = z.object({
	action: z.string(),
	type: z.string(),
	title: z.string(),
});

export const sessionItemSchema = z.object({
	id: z.string(),
	status: z.string(),
	source: z.string(),
	summary: z.string(),
	changeCount: z.number(),
	createCount: z.number(),
	updateCount: z.number(),
	appliedCount: z.number(),
	failedCount: z.number(),
	syncedToPMCount: z.number(),
	changes: z.array(sessionChangeSchema),
	errors: z.array(z.string()).nullable(),
	authorName: z.string().nullable(),
	authorEmail: z.string().nullable(),
	createdAt: z.coerce.date(),
	finalizedAt: z.coerce.date().nullable(),
});

/** Cap how many per-change descriptors we ship per session row. */
const MAX_CHANGES_PER_ROW = 100;

export function toLightweightChanges(
	raw: unknown,
): { action: string; type: string; title: string }[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	return raw.slice(0, MAX_CHANGES_PER_ROW).map((change) => {
		const obj =
			change && typeof change === "object"
				? (change as Record<string, unknown>)
				: {};
		const titleObj =
			obj.title && typeof obj.title === "object"
				? (obj.title as Record<string, unknown>)
				: {};
		const title =
			typeof titleObj.to === "string"
				? titleObj.to
				: typeof obj.title === "string"
					? obj.title
					: "Untitled";
		return {
			action: typeof obj.action === "string" ? obj.action : "update",
			type: typeof obj.type === "string" ? obj.type : "feature",
			title,
		};
	});
}

export function toErrorList(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) {
		return null;
	}
	const errors = raw.filter((e): e is string => typeof e === "string");
	return errors.length > 0 ? errors : null;
}

const sessionMessageSchema = z.object({
	role: z.string(),
	content: z.string(),
});

/**
 * A ticket the session actually created/updated, resolved from the audit trail
 * so the result card can deep-link to it. `identifier`/`storyId` are null-safe:
 * a since-deleted story keeps its action + title but loses the link.
 */
const appliedTicketSchema = z.object({
	action: z.enum(["create", "update"]),
	storyId: z.string(),
	identifier: z.string().nullable(),
	title: z.string(),
	/** True when the ticket no longer exists (deleted after the apply). */
	deleted: z.boolean(),
});

/**
 * Session detail = the list row plus the captured chat transcript and the
 * applied-ticket result list (with links).
 */
export const sessionDetailSchema = sessionItemSchema.extend({
	/**
	 * The proposal this session applied — the cancel target when the session is
	 * still APPLYING (the detail view shows a "Cancel apply" control). Null for
	 * legacy sessions created before proposal correlation.
	 */
	pendingProposalId: z.string().nullable(),
	messages: z.array(sessionMessageSchema),
	appliedItems: z.array(appliedTicketSchema),
});

/**
 * Parse the stored `messages` JSON into a clean {role, content}[] transcript.
 * Defensive: tolerates a null / legacy / missing column (sessions created
 * before message capture) and caps the count.
 */
export function toSessionMessages(
	raw: unknown,
): { role: string; content: string }[] {
	if (!Array.isArray(raw)) {
		return [];
	}
	const out: { role: string; content: string }[] = [];
	for (const m of raw) {
		if (!m || typeof m !== "object") {
			continue;
		}
		const role = (m as Record<string, unknown>).role;
		const content = (m as Record<string, unknown>).content;
		if (typeof content === "string" && content.length > 0) {
			out.push({
				role: typeof role === "string" ? role : "assistant",
				content,
			});
		}
	}
	return out.slice(0, 100);
}
