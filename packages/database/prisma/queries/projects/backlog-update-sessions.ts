/**
 * Database queries for BacklogUpdateSession — the read-only "Session history"
 * log of AI Backlog Update runs (the AI Update assistant).
 *
 * One row is created per apply in the `backlog.applyChanges` procedure (request
 * time, status APPLYING) and finalized to a terminal status from the apply
 * workflow's existing finalize activity (correlated by `pendingProposalId`).
 *
 * Kept deliberately SEPARATE from the AuditLog (the ticket-tied audit trail) —
 * two stores, never combined.
 *
 * Tenant XOR ({ organizationId, userId }) is enforced by the procedure layer
 * (the `tenantProtectedProcedure` resolves the project's tenancy and calls
 * these with a `projectId` already scoped to it); RLS is the DB-level floor.
 */

import { db } from "../../client";
import type { Prisma } from "../../generated/client";
import type { BacklogUpdateSessionStatus } from "../../generated/enums";

/** Fields surfaced to the read-only Session history tab. */
const SESSION_SELECT = {
	id: true,
	status: true,
	source: true,
	summary: true,
	changes: true,
	changeCount: true,
	createCount: true,
	updateCount: true,
	appliedCount: true,
	failedCount: true,
	syncedToPMCount: true,
	errors: true,
	createdAt: true,
	finalizedAt: true,
	user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.BacklogUpdateSessionSelect;

export type BacklogUpdateSessionRow = Prisma.BacklogUpdateSessionGetPayload<{
	select: typeof SESSION_SELECT;
}>;

/**
 * Session-detail projection — adds the message transcript (omitted from lists)
 * and the `pendingProposalId` used to resolve the applied tickets (their
 * post-apply identifiers) from the audit trail.
 */
const SESSION_DETAIL_SELECT = {
	...SESSION_SELECT,
	pendingProposalId: true,
	messages: true,
} satisfies Prisma.BacklogUpdateSessionSelect;

export type BacklogUpdateSessionDetail = Prisma.BacklogUpdateSessionGetPayload<{
	select: typeof SESSION_DETAIL_SELECT;
}>;

/**
 * Create a session row at apply time (status APPLYING). Author + createdAt come
 * from the authenticated request so they are accurate even if the apply
 * workflow never reaches its finalize step.
 */
export async function createBacklogUpdateSession(params: {
	projectId: string;
	pendingProposalId?: string | null;
	conversationId?: string | null;
	source?: string;
	summary: string;
	changes: Prisma.InputJsonValue;
	changeCount: number;
	createCount: number;
	updateCount: number;
	/** Snapshot of the AI Update chat transcript captured at apply time. */
	messages?: Prisma.InputJsonValue | null;
	userId?: string | null;
	organizationId?: string | null;
}) {
	return await db.backlogUpdateSession.create({
		data: {
			projectId: params.projectId,
			pendingProposalId: params.pendingProposalId ?? null,
			conversationId: params.conversationId ?? null,
			source: params.source ?? "AI_UPDATE_SIDEBAR",
			status: "APPLYING",
			summary: params.summary,
			changes: params.changes,
			changeCount: params.changeCount,
			createCount: params.createCount,
			updateCount: params.updateCount,
			messages: params.messages ?? undefined,
			userId: params.userId ?? null,
			organizationId: params.organizationId ?? null,
		},
	});
}

/**
 * Finalize the session tied to a PendingBacklogProposal with the terminal
 * outcome produced by the apply workflow's finalize activity. Correlated by
 * `pendingProposalId` (at most one session per proposal). No-op (returns 0) if
 * no matching session exists — the apply path must never fail because a session
 * row could not be finalized, and channel-monitor proposals have no session.
 *
 * The proposed `createCount`/`updateCount` snapshot is left untouched; only the
 * terminal status + applied/failed split are written. When `appliedCount` is
 * omitted it is derived from the status (APPLIED ⇒ all proposed changes applied;
 * otherwise none).
 */
export async function finalizeBacklogUpdateSession(params: {
	pendingProposalId: string;
	status: BacklogUpdateSessionStatus;
	appliedCount?: number | null;
	syncedToPMCount?: number | null;
	errors?: Prisma.InputJsonValue | null;
}): Promise<number> {
	const session = await db.backlogUpdateSession.findFirst({
		where: { pendingProposalId: params.pendingProposalId },
		orderBy: { createdAt: "desc" },
		select: { id: true, changeCount: true },
	});
	if (!session) {
		return 0;
	}

	const appliedCount =
		params.appliedCount != null
			? Math.max(0, Math.min(params.appliedCount, session.changeCount))
			: params.status === "APPLIED"
				? session.changeCount
				: 0;
	const failedCount = Math.max(0, session.changeCount - appliedCount);

	await db.backlogUpdateSession.update({
		where: { id: session.id },
		data: {
			status: params.status,
			appliedCount,
			failedCount,
			syncedToPMCount: params.syncedToPMCount ?? undefined,
			errors:
				params.errors === undefined || params.errors === null
					? undefined
					: params.errors,
			finalizedAt: new Date(),
		},
	});
	return 1;
}

const DEFAULT_SESSION_LIMIT = 25;
const MAX_SESSION_LIMIT = 100;

interface SessionCursor {
	createdAt: string;
	id: string;
}

function encodeSessionCursor(row: { createdAt: Date; id: string }): string {
	return Buffer.from(
		JSON.stringify({ createdAt: row.createdAt.toISOString(), id: row.id }),
	).toString("base64");
}

export function decodeSessionCursor(raw: string): SessionCursor | null {
	try {
		const parsed = JSON.parse(
			Buffer.from(raw, "base64").toString("utf8"),
		) as Partial<SessionCursor>;
		if (
			typeof parsed.createdAt === "string" &&
			typeof parsed.id === "string"
		) {
			return { createdAt: parsed.createdAt, id: parsed.id };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * List sessions for a project, newest first, with opaque cursor pagination
 * keyed by `(createdAt desc, id desc)`. Returns `limit` items plus a
 * `nextCursor` when more rows exist.
 */
export async function listBacklogUpdateSessions(params: {
	projectId: string;
	cursor?: string | null;
	limit?: number;
}): Promise<{ items: BacklogUpdateSessionRow[]; nextCursor: string | null }> {
	const limit = Math.min(
		Math.max(1, params.limit ?? DEFAULT_SESSION_LIMIT),
		MAX_SESSION_LIMIT,
	);

	const cursor = params.cursor ? decodeSessionCursor(params.cursor) : null;
	const cursorWhere: Prisma.BacklogUpdateSessionWhereInput = cursor
		? {
				OR: [
					{ createdAt: { lt: new Date(cursor.createdAt) } },
					{
						createdAt: new Date(cursor.createdAt),
						id: { lt: cursor.id },
					},
				],
			}
		: {};

	const rows = await db.backlogUpdateSession.findMany({
		where: { projectId: params.projectId, ...cursorWhere },
		select: SESSION_SELECT,
		orderBy: [{ createdAt: "desc" }, { id: "desc" }],
		take: limit + 1,
	});

	let nextCursor: string | null = null;
	if (rows.length > limit) {
		const last = rows[limit - 1];
		nextCursor = encodeSessionCursor({
			createdAt: last.createdAt,
			id: last.id,
		});
		rows.length = limit;
	}

	return { items: rows, nextCursor };
}

/**
 * Fetch a single session by id, scoped to a project (the procedure layer has
 * already authorized read on that project). Includes the message transcript,
 * which `listBacklogUpdateSessions` omits to stay light. Returns null when the
 * id is not found within the project.
 */
export async function getBacklogUpdateSession(params: {
	id: string;
	projectId: string;
}): Promise<BacklogUpdateSessionDetail | null> {
	return await db.backlogUpdateSession.findFirst({
		where: { id: params.id, projectId: params.projectId },
		select: SESSION_DETAIL_SELECT,
	});
}

/** A ticket an AI Update session created or updated, with its current id. */
export interface AppliedTicket {
	action: "create" | "update";
	storyId: string;
	/** Current F-XXX / B-XXX identifier; null if the story was since deleted. */
	identifier: string | null;
	title: string;
	/** True when the story no longer exists (deleted after the apply). */
	deleted: boolean;
}

/**
 * Resolve the tickets an AI Update session actually created/updated — with their
 * current identifier (F-XXX / B-XXX) for deep-linking — from the story-lifecycle
 * audit rows the apply writes (`story.created` / `story.updated`).
 *
 * Correlation is two-tier so EVERY session links its tickets, not just the ones
 * whose audit rows happen to carry the proposal id:
 *  1. Primary — by `metadata.proposalId` (precise; what current applies tag).
 *  2. Fallback — for applies whose audit rows weren't tagged (older runs): the
 *     story.created/updated rows written during the session's apply window whose
 *     creation-time snapshot title matches one of the proposed changes. Robust
 *     to later renames (the audit `resourceName` and the proposed title are both
 *     creation-time snapshots, while the id is resolved live) and scoped by the
 *     window + titles so a concurrent apply's rows aren't picked up.
 *
 * Deduped by story (a create-then-update within one apply surfaces once, headed
 * by "create"). A since-deleted story resolves to `deleted: true` + a null
 * identifier so the caller renders it without a link. Returns [] when nothing
 * matches (e.g. an apply that wrote nothing, or a dedup-skip that created no new
 * row).
 */
export async function getAppliedTicketsForProposal(params: {
	projectId: string;
	proposalId: string | null;
	/** Apply window (session.createdAt .. finalizedAt) — drives the fallback. */
	window?: { from: Date; to: Date | null };
	/** Proposed-change titles — the fallback's snapshot-title match set. */
	proposedTitles?: string[];
	limit?: number;
}): Promise<AppliedTicket[]> {
	const limit = Math.min(Math.max(1, params.limit ?? 100), 200);

	// 1) Primary: audit rows tagged with this proposal id.
	let rows: {
		action: string;
		resourceId: string | null;
		resourceName: string | null;
	}[] = params.proposalId
		? await db.auditLog.findMany({
				where: {
					projectId: params.projectId,
					action: { in: ["story.created", "story.updated"] },
					// Same jsonb path filter the audit viewer uses for correlationId.
					metadata: {
						path: ["proposalId"],
						equals: params.proposalId,
					},
				},
				select: { action: true, resourceId: true, resourceName: true },
				orderBy: { createdAt: "asc" },
				take: limit,
			})
		: [];

	// 2) Fallback: the apply didn't tag its audit rows with the proposal id —
	// re-find this session's stories from the apply window + snapshot titles.
	if (
		rows.length === 0 &&
		params.window &&
		(params.proposedTitles?.length ?? 0) > 0
	) {
		const to =
			params.window.to ??
			new Date(params.window.from.getTime() + 30 * 60 * 1000);
		rows = await db.auditLog.findMany({
			where: {
				projectId: params.projectId,
				action: { in: ["story.created", "story.updated"] },
				resourceName: { in: params.proposedTitles },
				createdAt: {
					gte: params.window.from,
					// Small trailing buffer — the audit write is fire-and-forget
					// and may land just after the workflow finalises.
					lte: new Date(to.getTime() + 60 * 1000),
				},
			},
			select: { action: true, resourceId: true, resourceName: true },
			orderBy: { createdAt: "asc" },
			take: limit,
		});
	}

	// Dedupe by story id; prefer "create" as the headline action when a story
	// was created and then updated within the same apply.
	const byStory = new Map<
		string,
		{ action: "create" | "update"; title: string }
	>();
	for (const row of rows) {
		if (!row.resourceId) {
			continue;
		}
		const action = row.action === "story.created" ? "create" : "update";
		const existing = byStory.get(row.resourceId);
		if (!existing) {
			byStory.set(row.resourceId, {
				action,
				title: row.resourceName ?? "Untitled",
			});
		} else if (action === "create") {
			byStory.set(row.resourceId, { action, title: existing.title });
		}
	}

	const storyIds = [...byStory.keys()];
	if (storyIds.length === 0) {
		return [];
	}

	// Resolve current identifiers in one query; a deleted story simply won't
	// appear here, leaving its identifier null (link-less render).
	const stories = await db.userStory.findMany({
		where: { id: { in: storyIds }, projectId: params.projectId },
		select: { id: true, identifier: true },
	});
	const identifierById = new Map(stories.map((s) => [s.id, s.identifier]));

	return storyIds.map((storyId) => {
		const entry = byStory.get(storyId) as {
			action: "create" | "update";
			title: string;
		};
		return {
			action: entry.action,
			storyId,
			identifier: identifierById.get(storyId) ?? null,
			title: entry.title,
			// The story isn't in the identifier lookup ⇒ it was deleted after
			// the apply (so there is no ticket to link to). Surfaced explicitly
			// rather than inferred from a null identifier.
			deleted: !identifierById.has(storyId),
		};
	});
}
