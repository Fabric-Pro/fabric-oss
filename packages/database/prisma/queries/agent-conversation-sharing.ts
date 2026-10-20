import { db } from "../client";
import type {
	AgentConversation,
	AgentConversationStatus,
	AgentConversationVisibility,
	Prisma,
} from "../generated/client";
import {
	ConversationNotFoundError,
	withConversationTurnResults,
} from "./agent-conversations";

/**
 * Who may read a Fabric Agent session. The owner always can; every member of
 * the organization can when the owner set the session to ORGANIZATION. Only
 * the owner writes, and every writer in `agent-conversations.ts` still filters
 * on `userId`. The organization is required: there is no personal scope.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_SEARCH_LENGTH = 100;

export type AgentConversationListScope = "mine" | "shared";

export interface AgentConversationOwner {
	id: string;
	name: string;
}

export type AgentConversationForViewer = AgentConversation & {
	isOwn: boolean;
	owner: AgentConversationOwner;
};

export class AgentConversationCursorError extends Error {
	constructor() {
		super("The cursor is not valid");
		this.name = "AgentConversationCursorError";
	}
}

interface ListCursor {
	pinned: boolean;
	updatedAt: Date;
	id: string;
}

function assertOrganization(
	organizationId: unknown,
): asserts organizationId is string {
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new ConversationNotFoundError();
	}
}

function encodeCursor(row: ListCursor): string {
	return Buffer.from(
		JSON.stringify({
			p: row.pinned,
			u: row.updatedAt.toISOString(),
			i: row.id,
		}),
	).toString("base64url");
}

function decodeCursor(cursor: string): ListCursor {
	try {
		const parsed: unknown = JSON.parse(
			Buffer.from(cursor, "base64url").toString("utf8"),
		);
		if (
			parsed &&
			typeof parsed === "object" &&
			"p" in parsed &&
			"u" in parsed &&
			"i" in parsed &&
			typeof parsed.p === "boolean" &&
			typeof parsed.u === "string" &&
			typeof parsed.i === "string"
		) {
			const updatedAt = new Date(parsed.u);
			if (!Number.isNaN(updatedAt.getTime())) {
				return { pinned: parsed.p, updatedAt, id: parsed.i };
			}
		}
	} catch {
		// falls through to the error below
	}
	throw new AgentConversationCursorError();
}

/**
 * The rows after a cursor in the list order: pinned first (own list only),
 * then newest, then id.
 */
function afterCursor(
	cursor: ListCursor,
	scope: AgentConversationListScope,
): Prisma.AgentConversationWhereInput {
	const olderThanCursor: Prisma.AgentConversationWhereInput = {
		OR: [
			{ updatedAt: { lt: cursor.updatedAt } },
			{ updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
		],
	};
	if (scope === "shared") {
		return olderThanCursor;
	}
	return cursor.pinned
		? { OR: [{ pinned: false }, { pinned: true, ...olderThanCursor }] }
		: { pinned: false, ...olderThanCursor };
}

interface ListFilter {
	userId: string;
	organizationId: string;
	/** One agent's sessions; every agent's when left out. */
	agentId?: string;
	scope: AgentConversationListScope;
	search?: string;
	status?: AgentConversationStatus;
}

/** Which sessions a list is over, before any paging. */
function listFilter({
	userId,
	organizationId,
	agentId,
	scope,
	search,
	status,
}: ListFilter): Prisma.AgentConversationWhereInput {
	const term = search?.trim().slice(0, MAX_SEARCH_LENGTH);
	return {
		organizationId,
		...(agentId ? { agentId } : {}),
		...(scope === "mine" ? { userId } : { visibility: "ORGANIZATION" }),
		...(status ? { status } : {}),
		...(term ? { title: { contains: term, mode: "insensitive" } } : {}),
	};
}

/**
 * A page of the sessions the viewer can list: their own ("mine"), or every
 * session in the organization set to ORGANIZATION ("shared"), their own
 * included. `search` matches the title. The own list keeps pinned sessions
 * first; the shared list ignores pins, which belong to each owner. With an
 * `agentId` the list is that agent's; without one it spans every agent in the
 * organization (still the viewer's own, or the shared ones, so another
 * member's private sessions never appear).
 *
 * Pages are by cursor. `offset` is only for the public route's older clients
 * and is ignored when a cursor is given.
 */
export async function listAgentConversationsForViewer({
	cursor,
	limit,
	offset,
	...filter
}: ListFilter & {
	cursor?: string;
	limit: number;
	offset?: number;
}): Promise<{ items: AgentConversationForViewer[]; nextCursor?: string }> {
	const { userId, organizationId, scope } = filter;
	assertOrganization(organizationId);
	const take = Math.min(
		Math.max(Math.trunc(limit) || DEFAULT_LIST_LIMIT, 1),
		MAX_LIST_LIMIT,
	);
	const after = cursor ? decodeCursor(cursor) : undefined;
	const skip = !after && offset ? Math.max(Math.trunc(offset), 0) : undefined;

	const rows = await db.agentConversation.findMany({
		where: {
			...listFilter(filter),
			...(after ? afterCursor(after, scope) : {}),
		},
		include: { user: { select: { id: true, name: true } } },
		orderBy:
			scope === "mine"
				? [{ pinned: "desc" }, { updatedAt: "desc" }, { id: "desc" }]
				: [{ updatedAt: "desc" }, { id: "desc" }],
		...(skip ? { skip } : {}),
		take: take + 1,
	});

	const page = rows.slice(0, take);
	const last = page.at(-1);
	return {
		items: page.map(({ user, ...conversation }) => ({
			...conversation,
			isOwn: conversation.userId === userId,
			owner: user,
		})),
		...(rows.length > take && last
			? { nextCursor: encodeCursor(last) }
			: {}),
	};
}

/** How many sessions a list is over, with the same filter as the list itself. */
export async function countAgentConversationsForViewer(
	filter: ListFilter,
): Promise<number> {
	assertOrganization(filter.organizationId);
	return db.agentConversation.count({ where: listFilter(filter) });
}

/**
 * A session the viewer may read: their own, or one its owner shared with the
 * organization. Null for anything else, including another organization's.
 */
export async function getAgentConversationForViewer({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId: string;
}): Promise<AgentConversationForViewer | null> {
	assertOrganization(organizationId);
	const row = await db.agentConversation.findFirst({
		where: {
			id,
			organizationId,
			OR: [{ userId }, { visibility: "ORGANIZATION" }],
		},
		include: { user: { select: { id: true, name: true } } },
	});
	if (!row) {
		return null;
	}
	const { user, ...conversation } = row;
	return {
		...(await withConversationTurnResults(conversation)),
		isOwn: conversation.userId === userId,
		owner: user,
	};
}

/**
 * Sets who can read a session. Owner only: anyone else, and any session of
 * another organization, is "not found". Like any edit, it moves the session's
 * `updatedAt`, so a newly shared session leads the shared list.
 */
export async function setAgentConversationVisibility({
	id,
	userId,
	organizationId,
	visibility,
}: {
	id: string;
	userId: string;
	organizationId: string;
	visibility: AgentConversationVisibility;
}): Promise<AgentConversation> {
	assertOrganization(organizationId);
	const { count } = await db.agentConversation.updateMany({
		where: { id, userId, organizationId },
		data: { visibility },
	});
	if (count === 0) {
		throw new ConversationNotFoundError();
	}
	return db.agentConversation.findFirstOrThrow({
		where: { id, userId, organizationId },
	});
}
