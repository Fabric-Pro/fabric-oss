import { createWorkspace } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * Create a new workspace
 */
export const createWorkspaceProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_CREATE))
	.route({
		method: "POST",
		path: "/document-workspaces",
		tags: ["Document Workspaces"],
		summary: "Create a workspace",
		description: "Create a new document workspace",
	})
	.input(
		z.object({
			name: z.string().min(1).max(100),
			description: z.string().max(500).optional(),
			organizationId: z.string().nullable().optional(),
			documentLimit: z.number().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const workspace = await createWorkspace({
			name: input.name,
			description: input.description,
			userId: user.id,
			organizationId,
			type: "CUSTOM",
			documentLimit: input.documentLimit,
		});

		return {
			id: workspace.id,
			name: workspace.name,
			description: workspace.description,
			type: workspace.type,
			status: workspace.status,
			documentLimit: workspace.documentLimit,
			createdAt: workspace.createdAt.toISOString(),
		};
	});
