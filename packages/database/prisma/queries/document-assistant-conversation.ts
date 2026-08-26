/**
 * Query helpers for `DocumentAssistantConversation` (spec 2026-05-19 §4.1).
 *
 * Every helper that lists or reads tenant rows applies the multi-tenant XOR
 * pattern documented in CLAUDE.md and the rest of `@repo/database`:
 *
 *   { organizationId, userId } XOR { organizationId: null, userId }
 *
 * Visibility (`SHARED` vs `PRIVATE`) is enforced as an additional predicate
 * at the procedure layer; helpers expose it but never relax the tenant floor.
 */

import { db, type Prisma } from "../client";
import type {
	AgentConversation,
	DocumentAssistantConversation,
	DocumentAssistantVisibility,
	DocumentRefKind,
} from "../generated/client";
import { createAgentConversation } from "./agent-conversations";

/**
 * One of:
 *   { organizationId: string, userId: string }  (org context)
 *   { organizationId: null,   userId: string }  (personal context)
 *
 * `undefined` is intentionally not allowed — callers must commit to a tenant
 * before reaching the data layer, matching how `tenantProtectedProcedure`
 * resolves the XOR upstream.
 */
export type DocumentAssistantTenantFilter =
	| { organizationId: string; userId: string }
	| { organizationId: null; userId: string };

export class DocumentAssistantVisibilityLockedError extends Error {
	constructor(public readonly conversationId: string) {
		super(
			`Visibility is locked after the first message for conversation ${conversationId}`,
		);
		this.name = "DocumentAssistantVisibilityLockedError";
	}
}

/**
 * Build the Prisma `where` fragment for tenant scoping. Used by every list /
 * read helper. Keeps the XOR pattern in one place so a future refactor only
 * has to update this function.
 */
function buildTenantWhere(
	tenant: DocumentAssistantTenantFilter,
): Prisma.DocumentAssistantConversationWhereInput {
	return tenant.organizationId === null
		? { organizationId: null, userId: tenant.userId }
		: { organizationId: tenant.organizationId };
}

const CURSOR_DELIM = "__";

function encodeCursor(updatedAt: Date, id: string): string {
	return Buffer.from(
		`${updatedAt.toISOString()}${CURSOR_DELIM}${id}`,
		"utf8",
	).toString("base64url");
}

function decodeCursor(cursor: string): { updatedAt: Date; id: string } | null {
	try {
		const raw = Buffer.from(cursor, "base64url").toString("utf8");
		const [iso, id] = raw.split(CURSOR_DELIM);
		if (!iso || !id) {
			return null;
		}
		const updatedAt = new Date(iso);
		if (Number.isNaN(updatedAt.getTime())) {
			return null;
		}
		return { updatedAt, id };
	} catch {
		return null;
	}
}

export interface ListDocumentAssistantConversationsInput {
	tenantFilter: DocumentAssistantTenantFilter;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
	cursor?: string;
	limit?: number;
}

export interface ListDocumentAssistantConversationsResult {
	items: DocumentAssistantConversation[];
	nextCursor: string | null;
}

/**
 * List the SHARED + own-PRIVATE rows for one (documentRefKind, documentRefId)
 * scoped to the caller's tenant. Sorted by `updatedAt DESC, id DESC`;
 * cursor-paginated via opaque base64 of `(updatedAt, id)`.
 *
 * Note: visibility filter is applied here — the caller passes the SELF userId
 * via `tenantFilter.userId`, so the only way another user's PRIVATE row leaks
 * is if a teammate's userId equals the caller's userId, which the upstream
 * XOR has already ruled out.
 */
export async function listDocumentAssistantConversations({
	tenantFilter,
	documentRefKind,
	documentRefId,
	cursor,
	limit = 10,
}: ListDocumentAssistantConversationsInput): Promise<ListDocumentAssistantConversationsResult> {
	const pageSize = Math.min(Math.max(limit, 1), 50);

	const cursorPos = cursor ? decodeCursor(cursor) : null;

	const where: Prisma.DocumentAssistantConversationWhereInput = {
		...buildTenantWhere(tenantFilter),
		documentRefKind,
		documentRefId,
		OR: [{ visibility: "SHARED" }, { userId: tenantFilter.userId }],
		...(cursorPos
			? {
					OR: [
						{ updatedAt: { lt: cursorPos.updatedAt } },
						{
							updatedAt: cursorPos.updatedAt,
							id: { lt: cursorPos.id },
						},
					],
				}
			: {}),
	};

	// If a cursor is present we have two ORs that must AND together — promote
	// to AND so Prisma doesn't merge them into one big OR.
	const finalWhere: Prisma.DocumentAssistantConversationWhereInput = cursorPos
		? {
				...buildTenantWhere(tenantFilter),
				documentRefKind,
				documentRefId,
				AND: [
					{
						OR: [
							{ visibility: "SHARED" },
							{ userId: tenantFilter.userId },
						],
					},
					{
						OR: [
							{ updatedAt: { lt: cursorPos.updatedAt } },
							{
								updatedAt: cursorPos.updatedAt,
								id: { lt: cursorPos.id },
							},
						],
					},
				],
			}
		: where;

	const rows = await db.documentAssistantConversation.findMany({
		where: finalWhere,
		orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
		take: pageSize + 1,
	});

	let nextCursor: string | null = null;
	if (rows.length > pageSize) {
		const last = rows[pageSize - 1];
		nextCursor = encodeCursor(last.updatedAt, last.id);
	}

	return {
		items: rows.slice(0, pageSize),
		nextCursor,
	};
}

export interface GetActiveDocumentAssistantConversationInput {
	tenantFilter: DocumentAssistantTenantFilter;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
}

/**
 * Return the caller's most recent non-archived conversation for the given
 * document, joined with its underlying AgentConversation so the SSR loader
 * has everything it needs to hydrate `initialMessages` without a second
 * round-trip.
 */
export async function getActiveDocumentAssistantConversation({
	tenantFilter,
	documentRefKind,
	documentRefId,
}: GetActiveDocumentAssistantConversationInput) {
	return db.documentAssistantConversation.findFirst({
		where: {
			...buildTenantWhere(tenantFilter),
			userId: tenantFilter.userId,
			documentRefKind,
			documentRefId,
			archivedAt: null,
		},
		orderBy: { updatedAt: "desc" },
		include: { conversation: true },
	});
}

export interface GetDocumentAssistantConversationByIdAndDocumentInput {
	tenantFilter: DocumentAssistantTenantFilter;
	conversationId: string;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
	/**
	 * Used for the visibility predicate: rows with `visibility = "PRIVATE"`
	 * only match when `userId = currentUserId`. The XOR `tenantFilter.userId`
	 * already pins the personal-context floor, but PRIVATE rows owned by
	 * teammates inside the same org are still readable to the tenant filter
	 * and need this second predicate to be excluded.
	 */
	currentUserId: string;
}

export interface GetDocumentAssistantConversationByIdAndDocumentResult {
	joinRow: DocumentAssistantConversation;
	agentConversation: AgentConversation;
}

/**
 * Read one `DocumentAssistantConversation` by `conversationId`, locked to a
 * specific `(documentRefKind, documentRefId)` so callers can't fish for join
 * rows belonging to a different document. Applies the XOR tenant filter from
 * `tenantFilter` plus the visibility predicate (`visibility = SHARED OR
 * userId = currentUserId`) at the query level.
 *
 * Returns `null` for any miss (wrong tenant, wrong document, deleted, or
 * private and not author) so the caller can collapse all four into the same
 * UI branch — spec §9.3 / AC-11 information-leak avoidance. Consumers MUST
 * NOT throw `NOT_FOUND` from a null result.
 *
 * Used by `agents.conversations.getByIdForDocument` (Group F.13 hotfix) to
 * power the History drawer's "view a prior conversation" interaction.
 */
export async function getDocumentAssistantConversationByIdAndDocument({
	tenantFilter,
	conversationId,
	documentRefKind,
	documentRefId,
	currentUserId,
}: GetDocumentAssistantConversationByIdAndDocumentInput): Promise<GetDocumentAssistantConversationByIdAndDocumentResult | null> {
	const joinRow = await db.documentAssistantConversation.findFirst({
		where: {
			...buildTenantWhere(tenantFilter),
			conversationId,
			documentRefKind,
			documentRefId,
			OR: [{ visibility: "SHARED" }, { userId: currentUserId }],
		},
		include: { conversation: true },
	});

	if (!joinRow) {
		return null;
	}

	// Prisma's `include` returns the relation typed loosely; pull the
	// conversation out and re-bind it so the caller has a strongly-typed
	// `AgentConversation` to read `messages` / `title` / `parentConversationId`
	// from.
	const { conversation, ...joinOnly } =
		joinRow as DocumentAssistantConversation & {
			conversation: AgentConversation;
		};
	return {
		joinRow: joinOnly as DocumentAssistantConversation,
		agentConversation: conversation,
	};
}

/**
 * Realtime authorization helper for `/api/conversations/[id]/realtime`.
 *
 * The realtime SSE only delivers `message_appended` *notifications* (the message
 * content itself is always re-fetched through `getByIdForDocument`, which
 * re-applies the full predicate). It still must scope subscriptions so it never
 * reveals that a conversation exists in another tenant.
 *
 * Returns `true` iff `conversationId` is a **document-assistant** conversation
 * the caller may see: either they OWN it (any visibility), or it is `SHARED` and
 * the caller is a member of the conversation's organization.
 *
 * The tenant is derived from the conversation's OWN join row, NOT from the
 * session's active org. This app's org context is URL-driven, so
 * `session.activeOrganizationId` is frequently `null` even while inside an org —
 * keying authorization off it would 404 every org-scoped conversation. Instead
 * we read the conversation's real org and verify the caller's membership of it,
 * so there is no cross-tenant reach.
 *
 * A PRIVATE conversation owned by someone else, a SHARED conversation in an org
 * the caller doesn't belong to, and every non-document-assistant conversation
 * (standalone Fabric AI, Sidekick, Backlog — no join row) all return `false`.
 * Intended as the authorization gate for the realtime route.
 */
export async function canSubscribeToDocumentAssistantConversation({
	conversationId,
	userId,
}: {
	conversationId: string;
	userId: string;
}): Promise<boolean> {
	// Resolve the conversation's own tenant + visibility from its (unique) join
	// row, without a caller-tenant filter, so we can authorize against the
	// conversation's real org rather than the session's unreliable active org.
	const joinRow = await db.documentAssistantConversation.findFirst({
		where: { conversationId },
		select: { organizationId: true, userId: true, visibility: true },
	});

	// No join row → not a document-assistant conversation (standalone agent
	// chats, Sidekick, Backlog). Those stay strictly owner-gated upstream.
	if (!joinRow) {
		return false;
	}

	// The owner may always subscribe, regardless of visibility.
	if (joinRow.userId === userId) {
		return true;
	}

	// Non-owners may subscribe only to SHARED conversations.
	if (joinRow.visibility !== "SHARED") {
		return false;
	}

	// A SHARED conversation with no org is personal (single-user); a non-owner
	// can never reach it.
	if (joinRow.organizationId === null) {
		return false;
	}

	// Tenant-isolation boundary: the caller must be a member of the
	// conversation's organization (mirrors verifyOrganizationMembership).
	const membership = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: joinRow.organizationId,
				userId,
			},
		},
		select: { userId: true },
	});

	return membership !== null;
}

export interface CreateDocumentAssistantConversationInput {
	tenantFilter: DocumentAssistantTenantFilter;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
	projectId: string;
	agentId: string;
	visibility?: DocumentAssistantVisibility;
	title?: string;
}

/**
 * Create the underlying `AgentConversation` + the new join row in a single
 * transaction so a partial write can never leave an orphan on either side.
 */
export async function createDocumentAssistantConversation({
	tenantFilter,
	documentRefKind,
	documentRefId,
	projectId,
	agentId,
	visibility = "SHARED",
	title,
}: CreateDocumentAssistantConversationInput) {
	return db.$transaction(async (tx) => {
		const conversation = await tx.agentConversation.create({
			data: {
				userId: tenantFilter.userId,
				organizationId: tenantFilter.organizationId,
				agentId,
				title,
				messages: [],
			},
		});

		const join = await tx.documentAssistantConversation.create({
			data: {
				conversationId: conversation.id,
				documentRefKind,
				documentRefId,
				projectId,
				organizationId: tenantFilter.organizationId,
				userId: tenantFilter.userId,
				visibility,
			},
		});

		return { conversation, join };
	});
}

export interface SetDocumentAssistantConversationVisibilityInput {
	id: string;
	visibility: DocumentAssistantVisibility;
	/**
	 * When true, throw `DocumentAssistantVisibilityLockedError` if
	 * `visibilityLockedAt IS NOT NULL`. Procedures should pass `true`;
	 * background jobs or admin tooling could pass `false` to bypass.
	 */
	expectUnlocked: boolean;
}

/**
 * Conditional visibility update. Atomic check-and-set on `visibilityLockedAt`
 * so a racing first-message-send can't slip a PRIVATE→SHARED flip past us.
 */
export async function setDocumentAssistantConversationVisibility({
	id,
	visibility,
	expectUnlocked,
}: SetDocumentAssistantConversationVisibilityInput) {
	if (!expectUnlocked) {
		return db.documentAssistantConversation.update({
			where: { id },
			data: { visibility },
		});
	}

	const result = await db.documentAssistantConversation.updateMany({
		where: { id, visibilityLockedAt: null },
		data: { visibility },
	});

	if (result.count === 0) {
		throw new DocumentAssistantVisibilityLockedError(id);
	}

	return db.documentAssistantConversation.findUniqueOrThrow({
		where: { id },
	});
}

export interface ArchiveDocumentAssistantConversationInput {
	id: string;
}

export async function archiveDocumentAssistantConversation({
	id,
}: ArchiveDocumentAssistantConversationInput) {
	const now = new Date();
	return db.$transaction(async (tx) => {
		const join = await tx.documentAssistantConversation.update({
			where: { id },
			data: { archivedAt: now },
		});
		await tx.agentConversation.update({
			where: { id: join.conversationId },
			data: { status: "ARCHIVED" },
		});
		return join;
	});
}

export interface DeleteDocumentAssistantConversationByConversationIdInput {
	conversationId: string;
}

/**
 * Delete the underlying `AgentConversation` — the FK cascade removes the
 * join row. Returning void because the caller has the conversationId
 * already and a 0-row count would already have failed earlier.
 */
export async function deleteDocumentAssistantConversationByConversationId({
	conversationId,
}: DeleteDocumentAssistantConversationByConversationIdInput) {
	await db.agentConversation.delete({ where: { id: conversationId } });
}

export interface CountDocumentAssistantConversationsInLast24hInput {
	userId: string;
	documentRefKind: DocumentRefKind;
	documentRefId: string;
}

/**
 * Used by the append-turn procedure to enforce the 50/(user, documentRef)/day
 * soft cap. Rolling 24-hour window — anchored on
 * `createdAt >= now() - 24h`.
 */
export async function countDocumentAssistantConversationsInLast24h({
	userId,
	documentRefKind,
	documentRefId,
}: CountDocumentAssistantConversationsInLast24hInput): Promise<number> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	return db.documentAssistantConversation.count({
		where: {
			userId,
			documentRefKind,
			documentRefId,
			createdAt: { gte: since },
		},
	});
}

// Re-export for callers that need to use the helper from one import.
export { createAgentConversation };
