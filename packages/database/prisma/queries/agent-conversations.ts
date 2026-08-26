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
 * - When organizationId is null (personal context): only show personal conversations
 * - When organizationId is undefined: legacy behavior (match by userId only)
 */
function buildOrgFilter(
	organizationId: string | null | undefined,
): Prisma.AgentConversationWhereInput {
	if (organizationId === undefined) {
		// Legacy behavior - no org filter
		return {};
	}
	if (organizationId === null) {
		// Personal context - only personal conversations
		return { organizationId: null };
	}
	// Organization context
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

interface SelectForUpdateRow {
	messages: ConversationMessage[];
}

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

	// The tenant filter is a tri-state: `undefined` falls back to legacy
	// "match by userId only", `null` means strict personal context, a
	// string means strict org context. The SELECT below uses these flags
	// to build the WHERE clause without injecting unscoped values.
	const orgIsExplicit = organizationId !== undefined;
	const orgIsPersonal = organizationId === null;

	return await (
		db as unknown as {
			$transaction: <T>(
				fn: (tx: typeof db) => Promise<T>,
				opts?: { isolationLevel?: "Serializable" },
			) => Promise<T>;
		}
	).$transaction(
		async (tx) => {
			// Row lock — Postgres `FOR UPDATE` blocks other transactions
			// from reading this row with intent to modify until we commit.
			// `$queryRaw` is the only way to opt into row locking from
			// Prisma; the parameterised template tag prevents SQL
			// injection. The table name is the DB-level identifier
			// `agent_conversation` (set via `@@map` on the
			// `AgentConversation` model) — using the Prisma model name
			// in raw SQL produces a `relation does not exist` (Postgres
			// 42P01) at runtime. The column names `"userId"` and
			// `"organizationId"` ARE camelCase and must stay quoted; we
			// hand-roll the SQL because Prisma's fluent builder does not
			// support `FOR UPDATE`.
			//
			// The WHERE clause mirrors the strict tenant XOR rules used
			// throughout the codebase: when `organizationId` is undefined
			// we omit the column filter; when it's null we require
			// "organizationId IS NULL"; when it's a string we require
			// equality.
			let rows: SelectForUpdateRow[];
			if (!orgIsExplicit) {
				rows = await (
					tx as unknown as {
						$queryRaw: (
							strings: TemplateStringsArray,
							...values: unknown[]
						) => Promise<SelectForUpdateRow[]>;
					}
				)
					.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} FOR UPDATE`;
			} else if (orgIsPersonal) {
				rows = await (
					tx as unknown as {
						$queryRaw: (
							strings: TemplateStringsArray,
							...values: unknown[]
						) => Promise<SelectForUpdateRow[]>;
					}
				)
					.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} AND "organizationId" IS NULL FOR UPDATE`;
			} else {
				rows = await (
					tx as unknown as {
						$queryRaw: (
							strings: TemplateStringsArray,
							...values: unknown[]
						) => Promise<SelectForUpdateRow[]>;
					}
				)
					.$queryRaw`SELECT messages FROM "agent_conversation" WHERE id = ${id} AND "userId" = ${userId} AND "organizationId" = ${organizationId} FOR UPDATE`;
			}

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
