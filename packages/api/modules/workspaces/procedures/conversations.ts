import { ORPCError } from "@orpc/server";
import {
	attachWorkspaceToConversation,
	db,
	detachWorkspaceFromConversation,
	getConversationAvailableDocuments,
	getConversationQdrantPointIds,
	getConversationWorkspaces,
	hasWorkspaceAccess,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Attach a workspace to a conversation
 */
export const attachWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			conversationId: z.string(),
			workspaceId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		// Check workspace access
		const hasAccess = await hasWorkspaceAccess(input.workspaceId, user.id);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this workspace",
			});
		}

		await attachWorkspaceToConversation({
			workspaceId: input.workspaceId,
			conversationId: input.conversationId,
			attachedBy: user.id,
		});

		return { success: true };
	});

/**
 * Detach a workspace from a conversation
 */
export const detachWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.input(
		z.object({
			conversationId: z.string(),
			workspaceId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;

		await detachWorkspaceFromConversation(
			input.workspaceId,
			input.conversationId,
			user.id,
		);

		return { success: true };
	});

/**
 * Get workspaces attached to a conversation
 */
export const getConversationWorkspacesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			conversationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const conversation = await db.agentConversation.findFirst({
			where: { id: input.conversationId, userId: context.user.id },
			select: { id: true },
		});
		if (!conversation) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}

		const workspaces = await getConversationWorkspaces(
			input.conversationId,
		);

		return workspaces.map((wc) => ({
			id: wc.workspace.id,
			name: wc.workspace.name,
			type: wc.workspace.type,
			status: wc.workspace.status,
			documentCount: wc.workspace._count.documents,
			attachedAt: wc.attachedAt.toISOString(),
		}));
	});

/**
 * Get available documents from attached workspaces
 */
export const getAvailableDocumentsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			conversationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const conversation = await db.agentConversation.findFirst({
			where: { id: input.conversationId, userId: context.user.id },
			select: { id: true },
		});
		if (!conversation) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}

		const workspaceDocuments = await getConversationAvailableDocuments(
			input.conversationId,
		);

		// Flatten the documents with workspace info
		const documents: Array<{
			id: string;
			filename: string;
			workspaceName: string;
			mimeType: string;
			chunkCount: number;
		}> = [];

		for (const wd of workspaceDocuments) {
			for (const doc of wd.documents) {
				documents.push({
					id: doc.id,
					filename: doc.originalFilename,
					workspaceName: wd.workspace.name,
					mimeType: doc.mimeType,
					chunkCount: doc.chunkCount,
				});
			}
		}

		return documents;
	});

/**
 * Get Qdrant point IDs for RAG retrieval
 */
export const getQdrantPointIdsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.input(
		z.object({
			conversationId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const conversation = await db.agentConversation.findFirst({
			where: { id: input.conversationId, userId: context.user.id },
			select: { id: true },
		});
		if (!conversation) {
			throw new ORPCError("NOT_FOUND", {
				message: "Conversation not found",
			});
		}

		return getConversationQdrantPointIds(input.conversationId);
	});
