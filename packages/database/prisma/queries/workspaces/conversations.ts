/**
 * Database queries for Workspace-Conversation Attachments
 *
 * Handles attaching workspaces to orchestrator conversations
 * with optional document filtering.
 */

import { db, type Prisma, type WorkspaceAccessLevel } from "../../client";
import { hasWorkspaceAccess } from "./workspaces";

// ============================================================================
// Types
// ============================================================================

export interface AttachWorkspaceInput {
	workspaceId: string;
	conversationId: string;
	attachedBy: string;
	allowedDocumentIds?: string[];
	accessLevel?: WorkspaceAccessLevel;
}

export interface UpdateAttachmentInput {
	allowedDocumentIds?: string[];
	accessLevel?: WorkspaceAccessLevel;
}

// ============================================================================
// Attach / Detach
// ============================================================================

/**
 * Attach a workspace to a conversation
 */
export async function attachWorkspaceToConversation(
	input: AttachWorkspaceInput,
) {
	const {
		workspaceId,
		conversationId,
		attachedBy,
		allowedDocumentIds = [],
		accessLevel = "READ",
	} = input;

	// Verify user has access to the workspace
	const hasAccess = await hasWorkspaceAccess(workspaceId, attachedBy);
	if (!hasAccess) {
		throw new Error("You do not have access to this workspace");
	}

	// Verify user owns the conversation
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId },
		select: { userId: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	if (conversation.userId !== attachedBy) {
		throw new Error(
			"You can only attach workspaces to your own conversations",
		);
	}

	// Check if already attached
	const existing = await db.workspaceConversation.findFirst({
		where: { workspaceId, conversationId },
	});

	if (existing) {
		// Update existing attachment
		return await db.workspaceConversation.update({
			where: { id: existing.id },
			data: {
				allowedDocumentIds,
				accessLevel,
			},
		});
	}

	// Create new attachment
	return await db.workspaceConversation.create({
		data: {
			workspaceId,
			conversationId,
			attachedBy,
			allowedDocumentIds,
			accessLevel,
		},
	});
}

/**
 * Detach a workspace from a conversation
 */
export async function detachWorkspaceFromConversation(
	workspaceId: string,
	conversationId: string,
	userId: string,
) {
	// Verify user owns the conversation
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId },
		select: { userId: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	if (conversation.userId !== userId) {
		throw new Error(
			"You can only detach workspaces from your own conversations",
		);
	}

	return await db.workspaceConversation.delete({
		where: {
			workspaceId_conversationId: {
				workspaceId,
				conversationId,
			},
		},
	});
}

/**
 * Update workspace attachment settings
 */
export async function updateWorkspaceAttachment(
	workspaceId: string,
	conversationId: string,
	userId: string,
	data: UpdateAttachmentInput,
) {
	// Verify user owns the conversation
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId },
		select: { userId: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	if (conversation.userId !== userId) {
		throw new Error(
			"You can only update your own conversation attachments",
		);
	}

	return await db.workspaceConversation.update({
		where: {
			workspaceId_conversationId: {
				workspaceId,
				conversationId,
			},
		},
		data: {
			...(data.allowedDocumentIds !== undefined && {
				allowedDocumentIds: data.allowedDocumentIds,
			}),
			...(data.accessLevel !== undefined && {
				accessLevel: data.accessLevel,
			}),
		},
	});
}

// ============================================================================
// Query
// ============================================================================

/**
 * Get all workspaces attached to a conversation
 */
export async function getConversationWorkspaces(conversationId: string) {
	return await db.workspaceConversation.findMany({
		where: { conversationId },
		include: {
			workspace: {
				select: {
					id: true,
					name: true,
					description: true,
					type: true,
					status: true,
					_count: {
						select: { documents: true },
					},
				},
			},
		},
		orderBy: { attachedAt: "desc" },
	});
}

/**
 * Get workspace attachment details
 */
export async function getWorkspaceAttachment(
	workspaceId: string,
	conversationId: string,
) {
	return await db.workspaceConversation.findUnique({
		where: {
			workspaceId_conversationId: {
				workspaceId,
				conversationId,
			},
		},
		include: {
			workspace: {
				select: {
					id: true,
					name: true,
					description: true,
				},
			},
		},
	});
}

/**
 * Get all conversations a workspace is attached to
 */
export async function getWorkspaceConversations(workspaceId: string) {
	return await db.workspaceConversation.findMany({
		where: { workspaceId },
		include: {
			conversation: {
				select: {
					id: true,
					title: true,
					agentId: true,
					createdAt: true,
				},
			},
		},
		orderBy: { attachedAt: "desc" },
	});
}

/**
 * Get available documents for a conversation (from attached workspaces)
 * Respects document filtering per attachment
 */
export async function getConversationAvailableDocuments(
	conversationId: string,
) {
	// Get all workspace attachments
	const attachments = await db.workspaceConversation.findMany({
		where: { conversationId },
		select: {
			workspaceId: true,
			allowedDocumentIds: true,
			accessLevel: true,
			workspace: {
				select: {
					id: true,
					name: true,
				},
			},
		},
	});

	// Collect all documents from attached workspaces
	const result = [];

	for (const attachment of attachments) {
		const documentFilter: Prisma.WorkspaceDocumentWhereInput = {
			workspaceId: attachment.workspaceId,
			status: "READY",
		};

		// If specific documents are allowed, filter by them
		if (attachment.allowedDocumentIds.length > 0) {
			documentFilter.id = { in: attachment.allowedDocumentIds };
		}

		const documents = await db.workspaceDocument.findMany({
			where: documentFilter,
			select: {
				id: true,
				filename: true,
				originalFilename: true,
				mimeType: true,
				pageCount: true,
				wordCount: true,
				chunkCount: true,
				qdrantPointIds: true,
			},
			orderBy: { createdAt: "desc" },
		});

		result.push({
			workspace: attachment.workspace,
			accessLevel: attachment.accessLevel,
			documents,
		});
	}

	return result;
}

/**
 * Get all Qdrant point IDs available for a conversation
 * Used for RAG queries during orchestrator execution
 */
export async function getConversationQdrantPointIds(
	conversationId: string,
): Promise<string[]> {
	const availableDocuments =
		await getConversationAvailableDocuments(conversationId);

	const allPointIds: string[] = [];
	for (const workspace of availableDocuments) {
		for (const doc of workspace.documents) {
			allPointIds.push(...doc.qdrantPointIds);
		}
	}

	return allPointIds;
}

/**
 * Check if a document is available in a conversation
 */
export async function isDocumentAvailableInConversation(
	documentId: string,
	conversationId: string,
): Promise<boolean> {
	// Get the document's workspace
	const document = await db.workspaceDocument.findFirst({
		where: { id: documentId, status: "READY" },
		select: { workspaceId: true },
	});

	if (!document) {
		return false;
	}

	// Check if workspace is attached to conversation
	const attachment = await db.workspaceConversation.findFirst({
		where: {
			workspaceId: document.workspaceId,
			conversationId,
		},
	});

	if (!attachment) {
		return false;
	}

	// Check if document is in allowed list (or all allowed)
	if (attachment.allowedDocumentIds.length === 0) {
		return true; // All documents allowed
	}

	return attachment.allowedDocumentIds.includes(documentId);
}

// ============================================================================
// Bulk Operations
// ============================================================================

/**
 * Attach multiple workspaces to a conversation
 */
export async function attachWorkspacesToConversation(
	conversationId: string,
	workspaceIds: string[],
	attachedBy: string,
) {
	const results = [];

	for (const workspaceId of workspaceIds) {
		try {
			const result = await attachWorkspaceToConversation({
				workspaceId,
				conversationId,
				attachedBy,
			});
			results.push({ workspaceId, success: true, attachment: result });
		} catch (error) {
			results.push({
				workspaceId,
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
			});
		}
	}

	return results;
}

/**
 * Detach all workspaces from a conversation
 */
export async function detachAllWorkspacesFromConversation(
	conversationId: string,
	userId: string,
) {
	// Verify user owns the conversation
	const conversation = await db.agentConversation.findFirst({
		where: { id: conversationId },
		select: { userId: true },
	});

	if (!conversation) {
		throw new Error("Conversation not found");
	}

	if (conversation.userId !== userId) {
		throw new Error(
			"You can only detach workspaces from your own conversations",
		);
	}

	return await db.workspaceConversation.deleteMany({
		where: { conversationId },
	});
}
