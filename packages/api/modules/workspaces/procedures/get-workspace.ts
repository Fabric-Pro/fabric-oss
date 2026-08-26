import { ORPCError } from "@orpc/server";
import {
	getOrCreatePersonalWorkspace,
	getWorkspaceById,
	getWorkspaceRole,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Get a workspace by ID
 */
export const getWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/{workspaceId}",
		tags: ["Document Workspaces"],
		summary: "Get a workspace",
		description: "Get a workspace by ID with its documents",
	})
	.input(
		z.object({
			workspaceId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const workspace = await getWorkspaceById(
			input.workspaceId,
			user.id,
			organizationId,
		);

		if (!workspace) {
			throw new ORPCError("NOT_FOUND", {
				message: "Workspace not found or you don't have access",
			});
		}

		const role = await getWorkspaceRole(input.workspaceId, user.id);

		return {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			type: workspace.type,
			status: workspace.status,
			documentLimit: workspace.documentLimit,
			userId: workspace.userId,
			organizationId: workspace.organizationId,
			isOwner: workspace.userId === user.id,
			role,
			documents: workspace.documents.map((d) => ({
				id: d.id,
				filename: d.filename,
				originalFilename: d.originalFilename,
				mimeType: d.mimeType,
				size: d.size,
				status: d.status,
				processingError: d.processingError,
				pageCount: d.pageCount,
				wordCount: d.wordCount,
				chunkCount: d.chunkCount,
				createdAt: d.createdAt.toISOString(),
				updatedAt: d.updatedAt.toISOString(),
			})),
			ragSettings: workspace.ragSettings,
			counts: workspace._count,
			createdAt: workspace.createdAt.toISOString(),
			updatedAt: workspace.updatedAt.toISOString(),
		};
	});

/**
 * Get or create the user's personal workspace
 * AUTHORIZATION: Uses tenantProtectedProcedure - resolves organizationId for proper context isolation
 */
export const getPersonalWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/personal",
		tags: ["Document Workspaces"],
		summary: "Get personal workspace",
		description: "Get or create the user's personal workspace",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const workspace = await getOrCreatePersonalWorkspace(
			user.id,
			organizationId,
		);

		return {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			type: workspace.type,
			status: workspace.status,
			documentLimit: workspace.documentLimit,
			createdAt: workspace.createdAt.toISOString(),
			updatedAt: workspace.updatedAt.toISOString(),
		};
	});
