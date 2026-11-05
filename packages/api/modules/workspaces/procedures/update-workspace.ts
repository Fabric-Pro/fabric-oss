import { workspaceBoundaryMiddleware } from "../lib/workspace-boundary";
import { ORPCError } from "@orpc/server";
import {
	archiveWorkspace,
	canManageWorkspace,
	deleteWorkspace,
	reactivateWorkspace,
	updateWorkspace,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Update a workspace
 */
export const updateWorkspaceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			workspaceId: z.string(),
			name: z.string().min(1).max(100).optional(),
			description: z.string().max(500).optional(),
			documentLimit: z.number().min(1).max(100).optional(),
		}),
	)
	.use(workspaceBoundaryMiddleware)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const canManage = await canManageWorkspace(input.workspaceId, user.id);
		if (!canManage) {
			throw new ORPCError("FORBIDDEN", {
				message: "Only administrators can update workspace settings",
			});
		}

		const workspace = await updateWorkspace(input.workspaceId, user.id, {
			name: input.name,
			description: input.description,
			documentLimit: input.documentLimit,
		});

		return {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			documentLimit: workspace.documentLimit,
			updatedAt: workspace.updatedAt.toISOString(),
		};
	});

/**
 * Archive a workspace
 */
export const archiveWorkspaceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			workspaceId: z.string(),
		}),
	)
	.use(workspaceBoundaryMiddleware)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const workspace = await archiveWorkspace(input.workspaceId, user.id);

		return {
			id: workspace.id,
			status: workspace.status,
			updatedAt: workspace.updatedAt.toISOString(),
		};
	});

/**
 * Reactivate an archived workspace
 */
export const reactivateWorkspaceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			workspaceId: z.string(),
		}),
	)
	.use(workspaceBoundaryMiddleware)
	.handler(async ({ input, context }) => {
		const { user } = context;

		const workspace = await reactivateWorkspace(input.workspaceId, user.id);

		return {
			id: workspace.id,
			status: workspace.status,
			updatedAt: workspace.updatedAt.toISOString(),
		};
	});

/**
 * Delete a workspace
 */
export const deleteWorkspaceProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.WORKSPACE_UPDATE, {
			requireOrganization: true,
		}),
	)
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			workspaceId: z.string(),
		}),
	)
	.use(workspaceBoundaryMiddleware)
	.handler(async ({ input, context }) => {
		const { user } = context;

		await deleteWorkspace(input.workspaceId, user.id);

		return { success: true };
	});
