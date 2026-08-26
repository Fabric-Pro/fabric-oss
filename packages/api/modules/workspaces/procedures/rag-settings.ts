/**
 * Workspace RAG Settings Procedures
 *
 * API procedures for managing workspace RAG settings.
 */

import { ORPCError } from "@orpc/server";
import {
	getOrCreateRagSettings,
	getWorkspaceById,
	updateWorkspaceRagSettings,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get RAG settings for a workspace
 */
export const getWorkspaceRagSettingsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/{workspaceId}/rag-settings",
		tags: ["Document Workspaces"],
		summary: "Get workspace RAG settings",
		description: "Get RAG settings for a workspace",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { workspaceId } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		// Verify user has access to the workspace
		const workspace = await getWorkspaceById(
			workspaceId,
			user.id,
			organizationId,
		);
		if (!workspace) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workspace not found or you don't have access",
			});
		}

		const settings = await getOrCreateRagSettings(workspaceId);

		return {
			settings: {
				chunkSize: settings.chunkSize,
				chunkOverlap: settings.chunkOverlap,
				splitMethod: settings.splitMethod,
				embeddingModel: settings.embeddingModel,
				topK: settings.topK,
				similarityThreshold: settings.similarityThreshold,
				enableReranking: settings.enableReranking,
			},
		};
	});

/**
 * Update RAG settings for a workspace
 */
export const updateWorkspaceRagSettingsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "PUT",
		path: "/document-workspaces/{workspaceId}/rag-settings",
		tags: ["Document Workspaces"],
		summary: "Update workspace RAG settings",
		description: "Update RAG settings for a workspace",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			organizationId: z.string().nullable().optional(),
			chunkSize: z.number().min(100).max(10000).optional(),
			chunkOverlap: z.number().min(0).max(2000).optional(),
			splitMethod: z
				.enum([
					"PARAGRAPH",
					"SENTENCE",
					"FIXED",
					"RECURSIVE",
					"DOCUMENT",
					"SEMANTIC",
				])
				.optional(),
			embeddingModel: z
				.enum(["TEXT_EMBEDDING_3_SMALL", "TEXT_EMBEDDING_3_LARGE"])
				.optional(),
			topK: z.number().min(1).max(50).optional(),
			similarityThreshold: z.number().min(0).max(1).optional(),
			enableReranking: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { workspaceId, organizationId: inputOrgId, ...data } = input;
		const { user, session } = context;
		const organizationId = resolveOrganizationId(inputOrgId, session);

		// Verify user has access to the workspace
		const workspace = await getWorkspaceById(
			workspaceId,
			user.id,
			organizationId,
		);
		if (!workspace) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workspace not found or you don't have access",
			});
		}

		const settings = await updateWorkspaceRagSettings(
			workspaceId,
			context.user.id,
			data,
		);

		return {
			success: true,
			settings: {
				chunkSize: settings.chunkSize,
				chunkOverlap: settings.chunkOverlap,
				splitMethod: settings.splitMethod,
				embeddingModel: settings.embeddingModel,
				topK: settings.topK,
				similarityThreshold: settings.similarityThreshold,
				enableReranking: settings.enableReranking,
			},
		};
	});
