import { perUserTenantWhere } from "../../src/tenant-filter";
import { db } from "../client";

/**
 * Get AI chats for a user's personal account (not organization)
 * Enforces strict isolation - only returns chats where organizationId is null
 */
export async function getAiChatsByUserId({
	limit,
	offset,
	userId,
}: {
	limit: number;
	offset: number;
	userId: string;
}) {
	return await db.aiChat.findMany({
		where: {
			userId,
			organizationId: null, // Strict isolation: only personal chats
			projectId: null, // Exclude project-scoped chats
		},
		orderBy: {
			updatedAt: "desc",
		},
		take: limit,
		skip: offset,
	});
}

/**
 * Get AI chats for a user within an organization.
 *
 * AI chats are per-user even in org context — each org member has their
 * own conversation history, not a shared org feed. This filter requires
 * BOTH userId and organizationId; passing only the org would leak every
 * member's chats to every other member.
 */
export async function getAiChatsByOrganizationId({
	limit,
	offset,
	organizationId,
	userId,
}: {
	limit: number;
	offset: number;
	organizationId: string;
	userId: string;
}) {
	return await db.aiChat.findMany({
		where: {
			organizationId,
			userId,
			projectId: null, // Exclude project-scoped chats
		},
		orderBy: {
			updatedAt: "desc",
		},
		take: limit,
		skip: offset,
	});
}

/**
 * Get AI chat by ID - INTERNAL USE ONLY (no tenant filtering)
 * Use getAiChatByIdForTenant for user-facing queries that know the tenant
 * up front, or getAiChatByIdForOwner when the tenant is discovered from
 * the row itself.
 */
export async function getAiChatById(id: string) {
	return await db.aiChat.findUnique({
		where: {
			id,
		},
	});
}

/**
 * Return the chat only if `userId` owns it, regardless of whether it
 * is personal or scoped to an organization. Use from user-facing paths
 * that learn the chat's tenant from the row itself (streaming, title
 * generation, retry/cancel, document upload) — the old pattern of
 * loading by id then authorizing by org membership leaked chats between
 * members of the same org.
 */
export async function getAiChatByIdForOwner(id: string, userId: string) {
	return await db.aiChat.findFirst({
		where: { id, userId },
	});
}

/**
 * Get AI chat by ID with tenant filtering (XOR pattern)
 * SECURITY: Use this for all user-facing queries
 *
 * @param id - Chat ID
 * @param userId - User ID (required for ownership check)
 * @param organizationId - Organization ID (null for personal context)
 */
export async function getAiChatByIdForTenant({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	return await db.aiChat.findFirst({
		where: {
			id,
			...perUserTenantWhere(userId, organizationId),
		},
	});
}

export async function createAiChat({
	organizationId,
	userId,
	title,
	projectId,
}: {
	organizationId?: string;
	userId: string;
	title?: string;
	projectId?: string;
}) {
	return await db.aiChat.create({
		data: {
			organizationId,
			userId,
			title,
			projectId,
		},
	});
}

/**
 * Get AI chats scoped to a specific project
 * SECURITY: Caller must verify project access before calling
 */
export async function getAiChatsByProjectId({
	projectId,
	organizationId,
	userId,
	limit,
	offset,
}: {
	projectId: string;
	organizationId?: string | null;
	userId: string;
	limit: number;
	offset: number;
}) {
	// Project scoping does not share a chat across users — each
	// collaborator still has their own conversation history.
	return await db.aiChat.findMany({
		where: {
			projectId,
			...perUserTenantWhere(userId, organizationId),
		},
		orderBy: {
			updatedAt: "desc",
		},
		take: limit,
		skip: offset,
	});
}

export async function listAiChatMcpConfigIdsForTenant({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const chat = await getAiChatByIdForTenant({ id, userId, organizationId });
	if (!chat) {
		return null;
	}

	const rows = await db.aiChatMcpConfig.findMany({
		where: {
			chatId: id,
			enabled: true,
			...perUserTenantWhere(userId, organizationId),
		},
		orderBy: {
			createdAt: "asc",
		},
		select: {
			mcpConfigId: true,
		},
	});

	return rows.map((row) => row.mcpConfigId);
}

export async function getAiChatToolSelectionForTenant({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}) {
	const chat = await getAiChatByIdForTenant({ id, userId, organizationId });
	if (!chat) {
		return null;
	}

	return {
		toolSelectionMode: chat.toolSelectionMode,
		selectedMcpConfigIds:
			(await listAiChatMcpConfigIdsForTenant({
				id,
				userId,
				organizationId,
			})) ?? [],
	};
}

export async function replaceAiChatMcpConfigsForTenant({
	id,
	userId,
	organizationId,
	mcpConfigIds,
	toolSelectionMode,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	mcpConfigIds: string[];
	toolSelectionMode: "DEFAULT" | "ONLY_SELECTED" | "DISABLED";
}) {
	const chat = await getAiChatByIdForTenant({ id, userId, organizationId });
	if (!chat) {
		return null;
	}

	await db.$transaction(async (tx) => {
		await tx.aiChatMcpConfig.deleteMany({
			where: {
				chatId: id,
				...perUserTenantWhere(userId, organizationId),
			},
		});

		if (mcpConfigIds.length === 0) {
			await tx.aiChat.update({
				where: { id },
				data: { toolSelectionMode },
			});
			return;
		}

		await tx.aiChatMcpConfig.createMany({
			data: mcpConfigIds.map((mcpConfigId) => ({
				chatId: id,
				mcpConfigId,
				userId,
				organizationId: organizationId ?? null,
				enabled: true,
				source: "conversation",
			})),
		});
		await tx.aiChat.update({
			where: { id },
			data: { toolSelectionMode },
		});
	});

	return {
		selectedMcpConfigIds: await listAiChatMcpConfigIdsForTenant({
			id,
			userId,
			organizationId,
		}),
		toolSelectionMode,
	};
}

/**
 * Update AI chat - INTERNAL USE ONLY (no tenant filtering)
 * Use updateAiChatForTenant for user-facing updates
 */
export async function updateAiChat({
	id,
	title,
	messages,
	pinned,
	workflowId,
	workflowRunId,
	workflowStatus,
	lastError,
	retryCount,
	lastRetryAt,
}: {
	id: string;
	title?: string | null;
	messages?: Array<object>;
	pinned?: boolean;
	workflowId?: string | null;
	workflowRunId?: string | null;
	workflowStatus?:
		| "NONE"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "RETRYING"
		| "CANCELLED";
	lastError?: string | null;
	retryCount?: number;
	lastRetryAt?: Date;
}) {
	const data: {
		title?: string | null;
		messages?: Array<object>;
		pinned?: boolean;
		workflowId?: string | null;
		workflowRunId?: string | null;
		workflowStatus?:
			| "NONE"
			| "RUNNING"
			| "COMPLETED"
			| "FAILED"
			| "RETRYING"
			| "CANCELLED";
		lastError?: string | null;
		retryCount?: number;
		lastRetryAt?: Date;
	} = {};

	if (title !== undefined) {
		data.title = title;
	}
	if (messages !== undefined) {
		data.messages = messages;
	}
	if (pinned !== undefined) {
		data.pinned = pinned;
	}
	if (workflowId !== undefined) {
		data.workflowId = workflowId;
	}
	if (workflowRunId !== undefined) {
		data.workflowRunId = workflowRunId;
	}
	if (workflowStatus !== undefined) {
		data.workflowStatus = workflowStatus;
	}
	if (lastError !== undefined) {
		data.lastError = lastError;
	}
	if (retryCount !== undefined) {
		data.retryCount = retryCount;
	}
	if (lastRetryAt !== undefined) {
		data.lastRetryAt = lastRetryAt;
	}

	return await db.aiChat.update({
		where: {
			id,
		},
		data,
	});
}

/**
 * Update AI chat with tenant filtering (XOR pattern)
 * SECURITY: Use this for all user-facing updates
 *
 * @param id - Chat ID
 * @param userId - User ID (required for ownership check)
 * @param organizationId - Organization ID (null for personal context)
 */
export async function updateAiChatForTenant({
	id,
	userId,
	organizationId,
	...updateData
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
	title?: string | null;
	messages?: Array<object>;
	pinned?: boolean;
	workflowId?: string | null;
	workflowRunId?: string | null;
	workflowStatus?:
		| "NONE"
		| "RUNNING"
		| "COMPLETED"
		| "FAILED"
		| "RETRYING"
		| "CANCELLED";
	lastError?: string | null;
	retryCount?: number;
	lastRetryAt?: Date;
}) {
	// XOR PATTERN: Verify ownership before update
	const chat = await getAiChatByIdForTenant({ id, userId, organizationId });
	if (!chat) {
		return null;
	}

	return await updateAiChat({ id, ...updateData });
}

/**
 * Delete AI chat - INTERNAL USE ONLY (no tenant filtering)
 * Use deleteAiChatForTenant for user-facing deletes
 */
export async function deleteAiChat(id: string) {
	return await db.aiChat.delete({
		where: {
			id,
		},
	});
}

/**
 * Delete AI chat with tenant filtering (XOR pattern)
 * SECURITY: Use this for all user-facing deletes
 *
 * @param id - Chat ID
 * @param userId - User ID (required for ownership check)
 * @param organizationId - Organization ID (null for personal context)
 * @returns true if deleted, false if not found or no access
 */
export async function deleteAiChatForTenant({
	id,
	userId,
	organizationId,
}: {
	id: string;
	userId: string;
	organizationId?: string | null;
}): Promise<boolean> {
	// XOR PATTERN: Verify ownership before delete
	const chat = await getAiChatByIdForTenant({ id, userId, organizationId });
	if (!chat) {
		return false;
	}

	await deleteAiChat(id);
	return true;
}
