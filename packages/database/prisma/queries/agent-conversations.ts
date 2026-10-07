import { db } from "../client";
import type { AgentConversationStatus, Prisma } from "../generated/client";

/**
 * Prefix prepended to the synthetic assistant turn that seeds a continued
 * conversation with the parent's exhaustion-synthesis summary. Used both
 * to build the seeding turn and to detect it on subsequent launches so the
 * orchestrator's launch route stays idempotent.
 */
export const CARRIED_OVER_MARKER_PREFIX =
	"[CARRIED OVER FROM PREVIOUS CHAT — established context for this conversation. Treat the items below as facts the previous session already established; do not re-fetch information already noted here.]";

export class ParentConversationNotFoundError extends Error {
	readonly parentConversationId: string;
	constructor(parentConversationId: string, userId: string) {
		super(
			`Parent conversation ${parentConversationId} not found for user ${userId}`,
		);
		this.name = "ParentConversationNotFoundError";
		this.parentConversationId = parentConversationId;
	}
}

// Types for conversation messages and trajectory
export interface ConversationMessage {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result?: string;
		status?: "pending" | "running" | "success" | "error";
	}>;
	agentId?: string;
	metadata?: Record<string, unknown>;
}

export interface TrajectoryNode {
	id: string;
	type:
		| "start"
		| "agent"
		| "tool_call"
		| "tool_result"
		| "decision"
		| "hitl"
		| "end";
	agentId?: string;
	agentName?: string;
	label: string;
	status: "pending" | "running" | "success" | "error";
	timestamp: string;
	duration?: number;
	input?: Record<string, unknown>;
	output?: Record<string, unknown>;
	error?: string;
	children: string[];
}

export interface AgentTrajectory {
	id: string;
	nodes: TrajectoryNode[];
	edges: Array<{ source: string; target: string }>;
	startTime: string;
	endTime?: string;
	status: "running" | "completed" | "failed";
}

/**
 * Build organization filter for strict isolation
 * - When organizationId is provided: only show conversations for that organization
 * - When organizationId is null or undefined: only show personal conversations
 *
 * `undefined` used to mean "legacy: match by userId only", which let a caller
 * in one context read, append to, archive or delete the same user's
 * conversations from another tenant. `resolveOrganizationId()` returns
 * `undefined` whenever it cannot name an organization, so the omission was
 * silently widening the filter. It now collapses to the personal scope, the
 * same XOR shape `continueConversationInNewChat` already enforces.
 */
function buildOrgFilter(
	organizationId: string | null | undefined,
): Prisma.AgentConversationWhereInput {
	if (!organizationId) {
		return { organizationId: null };
	}
	return { organizationId };
}

/**
 * List conversations for a user (with optional agent filter)
 * Enforces strict isolation between personal and organizational conversations:
 * - When organizationId is provided: only show conversations for that organization
 * - When organizationId is NOT provided: only show personal conversations (organizationId = null)
 */
export async function listAgentConversations({
	userId,
	organizationId,
	agentId,
	status,
	limit = 50,
	offset = 0,
}: {
	userId: string;
	organizationId?: string | null;
	agentId?: string;
	status?: AgentConversationStatus;
	limit?: number;
	offset?: number;
}) {
	// Strict isolation: if no organizationId, only show personal conversations (null org)
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentConversationWhereInput = {
		userId,
		...orgFilter,
		...(agentId && { agentId }),
		...(status && { status }),
	};

	return await db.agentConversation.findMany({
		where,
		orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
		take: limit,
		skip: offset,
	});
}

/**
 * Get a single conversation by ID
 * Enforces organization isolation when organizationId is provided
 */
export async function getAgentConversationById({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	return await db.agentConversation.findFirst({
		where: {
			id,
			userId, // Ensure user owns this conversation
			...orgFilter,
		},
	});
}

// Create a new conversation
export async function createAgentConversation({
	userId,
	organizationId,
	agentId,
	title,
	messages,
	metadata,
}: {
	userId: string;
	organizationId?: string | null;
	agentId: string;
	title?: string;
	messages?: ConversationMessage[];
	metadata?: Record<string, unknown>;
}) {
	return await db.agentConversation.create({
		data: {
			userId,
			organizationId,
			agentId,
			title,
			messages: (messages as unknown as Prisma.InputJsonValue) ?? [],
			metadata: metadata as unknown as Prisma.InputJsonValue,
		},
	});
}

/**
 * Continue a token-budget-exhausted conversation in a fresh chat thread.
 *
 * Verifies the caller owns the parent (and that it lives in the same tenant
 * scope), then creates a sibling conversation with `parentConversationId` set
 * and the orchestrator's exhaustion summary stored in `carriedOverSummary`.
 * The launch procedure prepends that summary to the new conversation's
 * orchestrator history on its first user turn.
 *
 * Returns the newly created conversation. Throws when the parent isn't found
 * for this user/tenant — callers should treat the throw as a 404, not 500.
 */
export async function continueConversationInNewChat({
	userId,
	organizationId,
	parentConversationId,
	carriedOverSummary,
	title,
}: {
	userId: string;
	organizationId?: string | null;
	parentConversationId: string;
	carriedOverSummary: string;
	title?: string;
}) {
	// Strict XOR filter: undefined collapses to personal (null), never "any tenant".
	// resolveOrganizationId() returns undefined for personal context, so the
	// generic buildOrgFilter would otherwise drop tenant scoping here.
	const tenantOrgId = organizationId ?? null;
	const parent = await db.agentConversation.findFirst({
		where: {
			id: parentConversationId,
			userId,
			organizationId: tenantOrgId,
		},
		select: { id: true, agentId: true, title: true },
	});

	if (!parent) {
		throw new ParentConversationNotFoundError(parentConversationId, userId);
	}

	const continuationTitle =
		title ?? (parent.title ? `${parent.title} (continued)` : undefined);

	return await db.agentConversation.create({
		data: {
			userId,
			organizationId: tenantOrgId,
			agentId: parent.agentId,
			title: continuationTitle,
			messages: [],
			parentConversationId: parent.id,
			carriedOverSummary,
			carriedOverAt: new Date(),
		},
	});
}

/**
 * Update a conversation
 * Enforces organization isolation when organizationId is provided
 */
export async function updateAgentConversation({
	id,
	userId,
	organizationId,
	title,
	messages,
	trajectory,
	metadata,
	pinned,
	status,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	title?: string | null;
	messages?: ConversationMessage[];
	trajectory?: AgentTrajectory | null;
	metadata?: Record<string, unknown>;
	pinned?: boolean;
	status?: AgentConversationStatus;
}) {
	const orgFilter = buildOrgFilter(organizationId);
	const data: Prisma.AgentConversationUpdateInput = {};

	if (title !== undefined) {
		data.title = title;
	}
	if (messages !== undefined) {
		data.messages = messages as unknown as Prisma.InputJsonValue;
	}
	if (trajectory !== undefined) {
		data.trajectory = trajectory as unknown as Prisma.InputJsonValue;
	}
	if (metadata !== undefined) {
		data.metadata = metadata as unknown as Prisma.InputJsonValue;
	}
	if (pinned !== undefined) {
		data.pinned = pinned;
	}
	if (status !== undefined) {
		data.status = status;
	}

	// First verify the conversation exists and user has access
	const existing = await db.agentConversation.findFirst({
		where: {
			id,
			userId,
			...orgFilter,
		},
	});

	if (!existing) {
		throw new Error("Conversation not found or access denied");
	}

	return await db.agentConversation.update({
		where: { id },
		data,
	});
}

/**
 * Add a message to a conversation
 * Enforces organization isolation when organizationId is provided
 */
export async function addMessageToConversation({
	id,
	userId,
	organizationId,
	message,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	message: ConversationMessage;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	const conversation = await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
		select: { messages: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	const currentMessages =
		(conversation.messages as unknown as ConversationMessage[]) || [];
	const updatedMessages = [...currentMessages, message];

	return await db.agentConversation.update({
		where: { id },
		data: {
			messages: updatedMessages as unknown as Prisma.InputJsonValue,
		},
	});
}

/**
 * Atomic, idempotent message append for the operation-result chat message
 * primitive.
 *
 * Behaviour contract:
 *
 *   1. Runs inside `db.$transaction({ isolationLevel: 'Serializable' })`.
 *   2. Acquires a row lock on the target conversation via
 *      `SELECT ... FOR UPDATE` BEFORE inspecting any state. A pre-lock
 *      scan would race with concurrent appends carrying the same
 *      `operationKey` (TOCTOU). The order is LOCK → SCAN → APPEND, never
 *      SCAN → LOCK.
 *   3. After the row lock is acquired, scans the locked `messages` array
 *      for any element whose `metadata.operationKey` equals the input
 *      key. If found, returns `{ persisted: existingMessage,
 *      deduplicated: true }` and DOES NOT write — the dedup is the entire
 *      point: a retried Temporal activity for the same operation must
 *      not produce duplicate chat messages (AC-5).
 *   4. Otherwise, appends the message and returns `{ persisted: input,
 *      deduplicated: false }`.
 *   5. Wrong-tenant access (the `SELECT FOR UPDATE` returns zero rows
 *      because `userId` / `organizationId` don't match) throws a generic
 *      "Conversation not found" error. We never reveal whether the row
 *      exists in a different tenant — mirrors
 *      `record-diff-outcome.ts:80-95`.
 *
 * Why a separate function and not an evolution of
 * `addMessageToConversation`?
 *
 *   - The existing helper is used elsewhere (orchestrator persistence,
 *     direct-chat persistence, document-assistant) and changing its
 *     signature risks regressions in PR1's "dark" rollout window.
 *   - The existing helper does a read-modify-write WITHOUT a row lock,
 *     which is a latent race-condition bug; #1412 explicitly defers
 *     fixing that bug to a separate ticket (see plan §10 risks).
 *   - The operation-result use-case has a stricter contract
 *     (`metadata.operationKey` is REQUIRED) that doesn't fit the
 *     general-purpose signature.
 */
export class ConversationNotFoundError extends Error {
	constructor() {
		super("Conversation not found");
		this.name = "ConversationNotFoundError";
	}
}

/**
 * A turn save whose messages repeat an id. Nothing is written: with two
 * messages under one id, a retry could not tell them apart.
 */
export class DuplicateTurnMessageIdError extends Error {
	readonly messageId: string;
	constructor(messageId: string) {
		super(`Turn messages repeat the id ${messageId}`);
		this.name = "DuplicateTurnMessageIdError";
		this.messageId = messageId;
	}
}

/**
 * A turn save whose message id is already used by a stored message the turn
 * does not own (another turn's message, or an unstamped message of a
 * different role). Nothing is written.
 */
export class TurnMessageIdConflictError extends Error {
	readonly messageId: string;
	constructor(messageId: string) {
		super(
			`Message id ${messageId} already belongs to another message in this conversation`,
		);
		this.name = "TurnMessageIdConflictError";
		this.messageId = messageId;
	}
}

interface SelectForUpdateRow {
	messages: ConversationMessage[];
}

type RawQueryClient = {
	$queryRaw: (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => Promise<SelectForUpdateRow[]>;
};

/**
 * Reads a conversation's messages with a row lock, inside the caller's
 * transaction, scoped to the caller's tenant.
 *
 * Row lock — Postgres `FOR UPDATE` blocks other transactions from reading
 * this row with intent to modify until the caller's transaction commits.
 * `$queryRaw` is the only way to opt into row locking from Prisma; the
 * parameterised template tag prevents SQL injection. The table name is the
 * DB-level identifier `agent_conversation` (set via `@@map` on the
 * `AgentConversation` model) — using the Prisma model name in raw SQL
 * produces a `relation does not exist` (Postgres 42P01) at runtime. The
 * column names `"userId"` and `"organizationId"` ARE camelCase and must
 * stay quoted; the SQL is hand-rolled because Prisma's fluent builder does
 * not support `FOR UPDATE`.
 *
 * The tenant filter is a tri-state mirroring the strict tenant XOR rules
 * used throughout the codebase: when `organizationId` is undefined the
 * column filter is omitted (legacy "match by userId only"); when it's null
 * the row must have "organizationId IS NULL"; when it's a string the row
 * must match it exactly. Zero rows means a tenant mismatch or a missing
 * conversation, and the caller cannot tell which.
 */
async function selectConversationMessagesForUpdate(
	tx: typeof db,
	{
		id,
		userId,
		organizationId,
	}: { id: string; userId: string; organizationId?: string | null },
): Promise<SelectForUpdateRow[]> {
	const raw = tx as unknown as RawQueryClient;
	if (organizationId === undefined) {
		return await raw.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
	}
	if (organizationId === null) {
		return await raw.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} AND "organizationId" IS NULL FOR UPDATE`;
	}
	return await raw.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} AND "organizationId" = ${organizationId} FOR UPDATE`;
}

type SerializableTransactionClient = {
	$transaction: <T>(
		fn: (tx: typeof db) => Promise<T>,
		opts?: { isolationLevel?: "Serializable" },
	) => Promise<T>;
};

export async function appendConversationMessage({
	id,
	userId,
	organizationId,
	message,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	message: ConversationMessage & {
		metadata: { operationKey: string } & Record<string, unknown>;
	};
}): Promise<{ persisted: ConversationMessage; deduplicated: boolean }> {
	// Input contract: `operationKey` is the entire deduplication key. We
	// reject malformed input synchronously (no DB round-trip) so callers
	// see the contract violation at the boundary, not inside the
	// transaction.
	const operationKey = message?.metadata?.operationKey;
	if (typeof operationKey !== "string" || operationKey.length === 0) {
		throw new Error(
			"appendConversationMessage: message.metadata.operationKey is required",
		);
	}

	return await (db as unknown as SerializableTransactionClient).$transaction(
		async (tx) => {
			const rows = await selectConversationMessagesForUpdate(tx, {
				id,
				userId,
				organizationId,
			});

			if (rows.length === 0) {
				// Tenant mismatch OR conversation doesn't exist. We
				// can't tell the two apart without leaking information
				// across tenants — and we deliberately don't try. The
				// caller maps this to a NOT_FOUND HTTP response.
				throw new ConversationNotFoundError();
			}

			const firstRow = rows[0];
			const currentMessages =
				firstRow && Array.isArray(firstRow.messages)
					? (firstRow.messages as ConversationMessage[])
					: [];

			// Scan AFTER the lock is held. A previous transaction holding
			// the lock may have already written the dedup target —
			// scanning here, post-lock, guarantees we observe its
			// committed write before deciding whether to append.
			const existing = currentMessages.find((m) => {
				const meta = m?.metadata as
					| { operationKey?: unknown }
					| undefined
					| null;
				return (
					meta !== null &&
					meta !== undefined &&
					typeof meta === "object" &&
					meta.operationKey === operationKey
				);
			});

			if (existing) {
				return { persisted: existing, deduplicated: true };
			}

			const updatedMessages = [...currentMessages, message];
			await tx.agentConversation.update({
				where: { id },
				data: {
					messages:
						updatedMessages as unknown as Prisma.InputJsonValue,
				},
			});

			return { persisted: message, deduplicated: false };
		},
		{ isolationLevel: "Serializable" },
	);
}

/**
 * Removes one user message from a conversation, leaving every other message
 * in place.
 *
 * Exists for the Advisor's first message (Fizzy #2958): a new chat is
 * created already holding the user's question, before the server decides
 * whether that question may run. When the server refuses it because another
 * message in the conversation is being answered, the question was never
 * answered and must not stay in the saved history. Messages written to the
 * conversation in the meantime (the other turn's own save) are kept: the
 * read and write happen under the same row lock, so nothing written between
 * them is lost.
 *
 * Only a `user` message with exactly this id is removed. When none matches
 * — already removed, or replaced by a completed turn's save — nothing is
 * written and `removed` is false, so a retried call is harmless.
 *
 * Throws `ConversationNotFoundError` when the conversation does not exist
 * for this user and tenant. `organizationId` is required: there is no
 * personal or unfiltered variant of this removal.
 */
export async function removeConversationMessage({
	id,
	userId,
	organizationId,
	messageId,
}: {
	id: string;
	userId: string;
	organizationId: string;
	messageId: string;
}): Promise<{ removed: boolean }> {
	// Fail closed even for a caller that slipped past the type: an empty or
	// missing organization would select the helper's unfiltered arm.
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new ConversationNotFoundError();
	}

	return await (db as unknown as SerializableTransactionClient).$transaction(
		async (tx) => {
			const rows = await selectConversationMessagesForUpdate(tx, {
				id,
				userId,
				organizationId,
			});

			if (rows.length === 0) {
				throw new ConversationNotFoundError();
			}

			const firstRow = rows[0];
			const currentMessages =
				firstRow && Array.isArray(firstRow.messages)
					? (firstRow.messages as ConversationMessage[])
					: [];

			const remainingMessages = currentMessages.filter(
				(m) => !(m?.id === messageId && m?.role === "user"),
			);
			if (remainingMessages.length === currentMessages.length) {
				return { removed: false };
			}

			await tx.agentConversation.update({
				where: { id },
				data: {
					messages:
						remainingMessages as unknown as Prisma.InputJsonValue,
				},
			});

			return { removed: true };
		},
		{ isolationLevel: "Serializable" },
	);
}

/**
 * The Advisor's conversation settings that a turn save or a settings change
 * may write, merged onto the row's current metadata under the row lock.
 *
 * `selectedMcpConfigIds`: absent keeps the stored selection, `null` removes
 * it ("no selection"), an array replaces it. The other keys are written only
 * when given and non-empty. `mode` is never taken from the caller: a missing
 * one is filled with `orchestrator`, an existing one is kept (Fizzy #2040).
 */
export interface AdvisorConversationSettings {
	executionMode?: string;
	instanceId?: string;
	selectedMcpConfigIds?: string[] | null;
	documentChatId?: string;
}

/** One saved Advisor execution record (`metadata.executions[]`). */
export type AdvisorExecutionRecord = { id: string } & Record<string, unknown>;

interface ConversationStateRow {
	messages: unknown;
	metadata: unknown;
}

type ConversationStateQueryClient = {
	$queryRaw: (
		strings: TemplateStringsArray,
		...values: unknown[]
	) => Promise<ConversationStateRow[]>;
};

/**
 * Reads a conversation's messages and metadata with a row lock, inside the
 * caller's transaction, in exactly one organization. There is no personal or
 * unfiltered arm: the caller has already refused a missing organization.
 */
async function selectConversationStateForUpdate(
	tx: typeof db,
	{
		id,
		userId,
		organizationId,
	}: { id: string; userId: string; organizationId: string },
): Promise<ConversationStateRow[]> {
	const raw = tx as unknown as ConversationStateQueryClient;
	return await raw.$queryRaw`SELECT messages, metadata FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} AND "organizationId" = ${organizationId} FOR UPDATE`;
}

type ReadCommittedTransactionClient = {
	$transaction: <T>(
		fn: (tx: typeof db) => Promise<T>,
		opts?: { isolationLevel?: "ReadCommitted" },
	) => Promise<T>;
};

/**
 * Runs `fn` in a Read Committed transaction. The turn save and the settings
 * change take the row lock as their first statement, so a writer that waits
 * on it reads the row as the previous writer committed it and applies its
 * change on top. Under Serializable the waiter instead fails with
 * "could not serialize access due to concurrent update" (40001), which the
 * real-database test showed for concurrent saves: one tab's turn was lost to
 * an error rather than to an overwrite.
 */
async function inRowLockTransaction<T>(
	fn: (tx: typeof db) => Promise<T>,
): Promise<T> {
	return await (db as unknown as ReadCommittedTransactionClient).$transaction(
		fn,
		{ isolationLevel: "ReadCommitted" },
	);
}

function assertOrganization(organizationId: unknown): void {
	// Fail closed even for a caller that slipped past the type.
	if (typeof organizationId !== "string" || organizationId.length === 0) {
		throw new ConversationNotFoundError();
	}
}

function asMetadataObject(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? { ...(value as Record<string, unknown>) }
		: {};
}

/**
 * Applies the settings onto `current` (the locked row's metadata), mirroring
 * the web client's `mergeOrchestratorConversationMetadata`, except that an
 * absent `selectedMcpConfigIds` keeps the stored one instead of removing it.
 * `executions` is never touched here.
 */
function mergeAdvisorSettings(
	current: Record<string, unknown>,
	settings: AdvisorConversationSettings,
	options: { executionModeOnlyIfUnset: boolean },
): Record<string, unknown> {
	const next: Record<string, unknown> = { ...current };
	if (typeof next.mode !== "string" || next.mode.length === 0) {
		next.mode = "orchestrator";
	}
	if (settings.executionMode) {
		const stored = next.executionMode;
		const keepStored =
			options.executionModeOnlyIfUnset &&
			typeof stored === "string" &&
			stored.length > 0;
		if (!keepStored) {
			next.executionMode = settings.executionMode;
		}
	}
	if (settings.instanceId) {
		next.instanceId = settings.instanceId;
	}
	if (settings.documentChatId) {
		next.documentChatId = settings.documentChatId;
	}
	if (settings.selectedMcpConfigIds === null) {
		delete next.selectedMcpConfigIds;
	} else if (settings.selectedMcpConfigIds !== undefined) {
		next.selectedMcpConfigIds = settings.selectedMcpConfigIds;
	}
	next.lastUpdated = new Date().toISOString();
	return next;
}

/** The execution a message was saved with, if a turn save stamped it. */
function messageExecutionId(message: unknown): string | undefined {
	const meta = (message as { metadata?: unknown } | null)?.metadata;
	if (meta === null || typeof meta !== "object") {
		return undefined;
	}
	const value = (meta as { executionId?: unknown }).executionId;
	return typeof value === "string" ? value : undefined;
}

/**
 * Inserts `block` before the first element `isLater` matches, or at the end
 * when none does.
 */
function insertBefore<T>(
	list: T[],
	block: T[],
	isLater: (item: T) => boolean,
): T[] {
	const index = list.findIndex(isLater);
	if (index === -1) {
		return [...list, ...block];
	}
	return [...list.slice(0, index), ...block, ...list.slice(index)];
}

/**
 * Resolves the `ConversationTurn` an execution id names, inside the caller's
 * transaction and after the conversation row is locked, and decides what the
 * save may do with it.
 *
 * - No turn (the client's `exec-<time>` fallback id): save without ordering.
 * - The caller's turn in this conversation (`conversationId` or the kept
 *   `scopeConversationId`): save, ordered by its `generation`.
 * - The caller's turn admitted with no conversation at all (the chat could
 *   not create one before the turn ran, so it creates one when the turn
 *   ends): claim the turn for this conversation with a conditional UPDATE
 *   that matches only while both conversation fields are still null. The
 *   claim lasts while the claiming conversation exists: deleting it nulls
 *   `conversationId` through the foreign key, and a later save of the turn
 *   into another of the caller's conversations can claim it again. That is
 *   within one user and organization, and the first conversation is gone. Two saves racing to claim it for different conversations
 *   hold different conversation locks, so they meet on the turn row: the
 *   second UPDATE waits, matches nothing once the first commits, and the
 *   re-read below refuses it. Only `conversationId` is set;
 *   `scopeConversationId` stays the conversation the turn was ADMITTED for
 *   (none), which is what admission's key-retry check and the stream and
 *   cancel routes compare against. Such a turn has no generation and is not
 *   ordered.
 * - Anything else (another user's or organization's turn, or a turn of
 *   another conversation): `ConversationNotFoundError`.
 */
async function resolveTurnForSave(
	tx: typeof db,
	args: {
		executionId: string;
		conversationId: string;
		userId: string;
		organizationId: string;
	},
): Promise<{ generation: number | null }> {
	const turnSelect = {
		userId: true,
		organizationId: true,
		conversationId: true,
		scopeConversationId: true,
		generation: true,
	} as const;
	const turn = await tx.conversationTurn.findUnique({
		where: { executionId: args.executionId },
		select: turnSelect,
	});
	if (!turn) {
		return { generation: null };
	}
	if (
		turn.userId !== args.userId ||
		turn.organizationId !== args.organizationId
	) {
		throw new ConversationNotFoundError();
	}
	if (
		turn.conversationId === args.conversationId ||
		turn.scopeConversationId === args.conversationId
	) {
		return { generation: turn.generation };
	}
	if (turn.conversationId !== null || turn.scopeConversationId !== null) {
		throw new ConversationNotFoundError();
	}

	const claimed = await tx.conversationTurn.updateMany({
		where: {
			executionId: args.executionId,
			userId: args.userId,
			organizationId: args.organizationId,
			conversationId: null,
			scopeConversationId: null,
		},
		data: { conversationId: args.conversationId },
	});
	if (claimed.count === 1) {
		return { generation: null };
	}
	// Lost a race to claim it: accept only if the winner claimed it for
	// this same conversation.
	const after = await tx.conversationTurn.findUnique({
		where: { executionId: args.executionId },
		select: turnSelect,
	});
	if (after?.conversationId === args.conversationId) {
		return { generation: null };
	}
	throw new ConversationNotFoundError();
}

/**
 * Saves one finished Advisor turn into its conversation without rewriting
 * anything another writer saved (Fizzy #2949).
 *
 * The client used to read the whole conversation, add its turn, and write the
 * whole `messages` array and `metadata` back. Two tabs on one conversation,
 * or a late save from a stream that outlived its tab, then replaced the other
 * writer's newer turn — and could put back a refused first message that
 * `removeConversationMessage` had just taken out. Here every read the save
 * depends on, including the turn lookups, happens in one transaction after a
 * `SELECT ... FOR UPDATE` lock on the conversation row (see
 * `inRowLockTransaction`), so every change is made to the row as it is now:
 *
 *   1. `removeMessageIds`: removed only when the message is a `user`
 *      message that no turn save has stamped (the question a new chat was
 *      created with, and a refused first message a failed removal left
 *      behind — neither is ever stamped). A saved turn's question is
 *      stamped, so it is never removed this way, and an id that is one of
 *      this turn's own messages is not removed either.
 *   2. `messages`: each is stamped with `metadata.executionId` (the
 *      execution record's id). Their ids must be distinct
 *      (`DuplicateTurnMessageIdError`), and an id may match only a stored
 *      message the turn owns: one stamped with this execution, or an
 *      unstamped message of the same role, which the turn adopts (the
 *      question a conversation was created with at save time). Any other
 *      match is `TurnMessageIdConflictError`. Both are raised before any
 *      write. The messages then fill, in order, the positions of the
 *      messages the turn owns; extras go right after the last of them,
 *      unfilled positions are dropped, and a turn that owns nothing yet is
 *      added as one block (see Order). Ids play no part in placement, and
 *      messages the turn does not own never move, so a retry of the same
 *      turn — same ids or regenerated — leaves the array unchanged.
 *   3. `execution`: replaces the stored record with the same id, or is added.
 *   4. `settings`: merged onto the locked metadata (see
 *      `AdvisorConversationSettings`); `executionMode` is used only when the
 *      conversation has none, as the client's save did.
 *
 * Order. When the turn belongs to this conversation and has a `generation`,
 * a turn saved for the first time is placed before the messages and
 * execution of any turn of this conversation with a higher generation, so a
 * late save of an earlier turn does not land after a later one. Later turns
 * are recognised by the `metadata.executionId` this function stamps;
 * messages without it (saved before this function existed, or appended
 * mid-turn by the workflow) are never moved. The lookup of later turns runs
 * under the lock, so a later turn saved while this save waited for the lock
 * is seen. Without a generation (no turn, or a turn associated here — see
 * `resolveTurnForSave`) the turn is appended at the end.
 *
 * Throws `ConversationNotFoundError` when the conversation is not this
 * user's in this organization, or when the execution id names a turn this
 * save may not use (see `resolveTurnForSave`), and the two message-id errors
 * above. Nothing is written then.
 * `organizationId` is required: there is no personal or unfiltered variant.
 */
export async function saveConversationTurn({
	id,
	userId,
	organizationId,
	messages,
	execution,
	removeMessageIds = [],
	settings = {},
}: {
	id: string;
	userId: string;
	organizationId: string;
	messages: ConversationMessage[];
	execution: AdvisorExecutionRecord;
	removeMessageIds?: string[];
	settings?: AdvisorConversationSettings;
}): Promise<{ addedMessages: number; removedMessages: number }> {
	assertOrganization(organizationId);
	const executionId = execution?.id;
	if (typeof executionId !== "string" || executionId.length === 0) {
		throw new Error("saveConversationTurn: execution.id is required");
	}

	const seenIds = new Set<string>();
	for (const message of messages) {
		if (seenIds.has(message.id)) {
			throw new DuplicateTurnMessageIdError(message.id);
		}
		seenIds.add(message.id);
	}

	const stamped: ConversationMessage[] = messages.map((message) => ({
		...message,
		metadata: { ...(message.metadata ?? {}), executionId },
	}));
	const turnMessageIds = new Set(stamped.map((m) => m.id));
	const toRemove = new Set(
		removeMessageIds.filter((messageId) => !turnMessageIds.has(messageId)),
	);

	return await inRowLockTransaction(async (tx) => {
		const rows = await selectConversationStateForUpdate(tx, {
			id,
			userId,
			organizationId,
		});
		const row = rows[0];
		if (!row) {
			throw new ConversationNotFoundError();
		}

		const { generation } = await resolveTurnForSave(tx, {
			executionId,
			conversationId: id,
			userId,
			organizationId,
		});
		const laterExecutionIds = new Set<string>();
		if (generation !== null) {
			const later = await tx.conversationTurn.findMany({
				where: {
					userId,
					organizationId,
					OR: [{ conversationId: id }, { scopeConversationId: id }],
					generation: { gt: generation },
					executionId: { not: null },
				},
				select: { executionId: true },
			});
			for (const turn of later) {
				if (turn.executionId) {
					laterExecutionIds.add(turn.executionId);
				}
			}
		}

		const stored = Array.isArray(row.messages)
			? (row.messages as ConversationMessage[])
			: [];
		const kept = stored.filter(
			(m) =>
				!(
					m?.role === "user" &&
					messageExecutionId(m) === undefined &&
					toRemove.has(m?.id)
				),
		);

		// Rule 1: a turn message may reuse only the id of a stored message
		// the turn owns — one stamped with this execution, or an unstamped
		// message of the same role (the question a conversation was created
		// with at save time), which the turn adopts. Anything else is
		// refused before any write.
		const turnRoleById = new Map(stamped.map((m) => [m.id, m.role]));
		for (const m of stored) {
			const role = turnRoleById.get(m?.id);
			if (role === undefined) {
				continue;
			}
			const owner = messageExecutionId(m);
			if (owner === executionId) {
				continue;
			}
			if (owner === undefined && m?.role === role) {
				continue;
			}
			throw new TurnMessageIdConflictError(m.id);
		}

		// Rules 2–3: the turn's slots are the positions, in stored order, of
		// the messages it owns (stamped with this execution, or adopted).
		// The turn's messages fill them in payload order; any left over go
		// right after the last slot; unfilled slots are dropped. With no
		// slot, the turn goes as one block before the first message of a
		// later turn, else at the end. Messages the turn does not own never
		// move, so a retry of the same turn — same ids or regenerated —
		// leaves the array unchanged.
		const owned = (m: ConversationMessage) => {
			const owner = messageExecutionId(m);
			return (
				owner === executionId ||
				(owner === undefined && turnRoleById.has(m?.id))
			);
		};
		const slots: number[] = [];
		kept.forEach((m, index) => {
			if (owned(m)) {
				slots.push(index);
			}
		});
		const next: Array<ConversationMessage | null> = [...kept];
		slots.forEach((slot, i) => {
			next[slot] = stamped[i] ?? null;
		});
		const extras = stamped.slice(slots.length);
		let insertAt = kept.length;
		const lastSlot = slots[slots.length - 1];
		if (lastSlot !== undefined) {
			insertAt = lastSlot + 1;
		} else {
			const laterIndex = kept.findIndex((m) => {
				const owner = messageExecutionId(m);
				return owner !== undefined && laterExecutionIds.has(owner);
			});
			if (laterIndex !== -1) {
				insertAt = laterIndex;
			}
		}
		const nextMessages = [
			...next.slice(0, insertAt),
			...extras,
			...next.slice(insertAt),
		].filter((m): m is ConversationMessage => m !== null);

		const metadata = mergeAdvisorSettings(
			asMetadataObject(row.metadata),
			settings,
			{ executionModeOnlyIfUnset: true },
		);
		const executions = Array.isArray(metadata.executions)
			? (metadata.executions as AdvisorExecutionRecord[])
			: [];
		const existingIndex = executions.findIndex(
			(e) => e?.id === executionId,
		);
		metadata.executions =
			existingIndex === -1
				? insertBefore(executions, [execution], (e) =>
						laterExecutionIds.has(e?.id),
					)
				: executions.map((e, index) =>
						index === existingIndex ? execution : e,
					);

		await tx.agentConversation.update({
			where: { id },
			data: {
				messages: nextMessages as unknown as Prisma.InputJsonValue,
				metadata: metadata as unknown as Prisma.InputJsonValue,
			},
		});

		const storedIds = new Set(stored.map((m) => m?.id));
		const nextIds = new Set(nextMessages.map((m) => m?.id));
		return {
			addedMessages: [...nextIds].filter((m) => !storedIds.has(m)).length,
			removedMessages: [...storedIds].filter((m) => !nextIds.has(m))
				.length,
		};
	});
}

/**
 * Changes an Advisor conversation's settings (chat tools, reasoning mode,
 * agent instance) without touching its messages or `metadata.executions`
 * (Fizzy #2949). The keys are merged onto the metadata read under the row
 * lock, never onto a snapshot the client loaded earlier, so an execution
 * another tab saved in the meantime is kept. `executionMode`, when given,
 * replaces the stored one.
 *
 * Throws `ConversationNotFoundError` when the conversation is not this
 * user's in this organization. `organizationId` is required.
 */
export async function updateConversationSettings({
	id,
	userId,
	organizationId,
	settings,
}: {
	id: string;
	userId: string;
	organizationId: string;
	settings: AdvisorConversationSettings;
}): Promise<{ updated: true }> {
	assertOrganization(organizationId);

	return await inRowLockTransaction(async (tx) => {
		const rows = await selectConversationStateForUpdate(tx, {
			id,
			userId,
			organizationId,
		});
		const row = rows[0];
		if (!row) {
			throw new ConversationNotFoundError();
		}

		const metadata = mergeAdvisorSettings(
			asMetadataObject(row.metadata),
			settings,
			{ executionModeOnlyIfUnset: false },
		);
		await tx.agentConversation.update({
			where: { id },
			data: {
				metadata: metadata as unknown as Prisma.InputJsonValue,
			},
		});
		return { updated: true as const };
	});
}

/**
 * Update trajectory for a conversation
 * Enforces organization isolation when organizationId is provided
 */
export async function updateConversationTrajectory({
	id,
	userId,
	organizationId,
	trajectory,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	trajectory: AgentTrajectory;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	// Verify access first
	const existing = await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
	});

	if (!existing) {
		throw new Error("Conversation not found or access denied");
	}

	return await db.agentConversation.update({
		where: { id },
		data: {
			trajectory: trajectory as unknown as Prisma.InputJsonValue,
		},
	});
}

/**
 * Delete a conversation
 * Enforces organization isolation when organizationId is provided
 */
export async function deleteAgentConversation({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	// Verify access first
	const existing = await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
	});

	if (!existing) {
		throw new Error("Conversation not found or access denied");
	}

	return await db.agentConversation.delete({
		where: { id },
	});
}

/**
 * Archive a conversation
 * Enforces organization isolation when organizationId is provided
 */
export async function archiveAgentConversation({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	// Verify access first
	const existing = await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
	});

	if (!existing) {
		throw new Error("Conversation not found or access denied");
	}

	return await db.agentConversation.update({
		where: { id },
		data: {
			status: "ARCHIVED",
		},
	});
}

/**
 * Toggle pin status
 * Enforces organization isolation when organizationId is provided
 */
export async function toggleConversationPin({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	const conversation = await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
		select: { pinned: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	return await db.agentConversation.update({
		where: { id },
		data: {
			pinned: !conversation.pinned,
		},
	});
}

/**
 * Count conversations for a user
 * Enforces strict isolation between personal and organizational conversations
 */
export async function countAgentConversations({
	userId,
	organizationId,
	agentId,
	status,
}: {
	userId: string;
	organizationId?: string | null;
	agentId?: string;
	status?: AgentConversationStatus;
}) {
	// Strict isolation: if no organizationId, only count personal conversations
	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const where: Prisma.AgentConversationWhereInput = {
		userId,
		...orgFilter,
		...(agentId && { agentId }),
		...(status && { status }),
	};

	return await db.agentConversation.count({ where });
}

// Generate title from first message (utility function)
export function generateConversationTitle(
	messages: ConversationMessage[],
): string {
	const firstUserMessage = messages.find((m) => m.role === "user");
	if (!firstUserMessage) {
		return "New Conversation";
	}

	// Truncate to first 50 characters
	const content = firstUserMessage.content;
	if (content.length <= 50) {
		return content;
	}
	return `${content.slice(0, 47)}...`;
}

/**
 * Get conversation with full details for episodic memory
 * Returns the conversation with messages for summarization
 */
export async function getConversationForSummary({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const orgFilter = buildOrgFilter(organizationId);

	return await db.agentConversation.findFirst({
		where: { id, userId, ...orgFilter },
		select: {
			id: true,
			agentId: true,
			title: true,
			messages: true,
			createdAt: true,
			updatedAt: true,
			metadata: true,
		},
	});
}

/**
 * Get agent instance ID from conversation metadata
 * Used for linking conversations to agent memory
 */
export function getAgentInstanceIdFromConversation(
	conversation: {
		agentId: string;
		metadata?: unknown;
	} | null,
): string | null {
	if (!conversation) {
		return null;
	}

	// Check metadata for explicit instanceId
	if (
		conversation.metadata &&
		typeof conversation.metadata === "object" &&
		"instanceId" in conversation.metadata
	) {
		return (conversation.metadata as { instanceId: string }).instanceId;
	}

	// For agent template chats, agentId might be the instance ID
	// Format: "template-instance:{instanceId}"
	if (conversation.agentId.startsWith("template-instance:")) {
		return conversation.agentId.replace("template-instance:", "");
	}

	return null;
}
