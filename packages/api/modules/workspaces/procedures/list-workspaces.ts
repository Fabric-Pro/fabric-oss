import { getWorkspaceStats, listWorkspaces } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * List workspaces accessible to the current user
 */
export const listWorkspacesProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces",
		tags: ["Document Workspaces"],
		summary: "List workspaces",
		description: "List all workspaces accessible to the current user",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(50).optional(),
			offset: z.number().min(0).optional(),
			status: z.enum(["ACTIVE", "ARCHIVED"]).optional(),
			type: z.enum(["PERSONAL", "CUSTOM"]).optional(),
			search: z.string().optional(),
			includeShared: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		const result = await listWorkspaces({
			userId: user.id,
			organizationId,
			limit: input.limit,
			offset: input.offset,
			status: input.status,
			type: input.type,
			search: input.search,
			includeShared: input.includeShared,
		});

		return {
			workspaces: result.workspaces.map((w) => ({
				id: w.id,
				name: w.name,
				description: w.description,
				type: w.type,
				status: w.status,
				documentLimit: w.documentLimit,
				documentCount: w._count.documents,
				conversationCount: w._count.conversations,
				isOwner: w.userId === user.id,
				owner: w.user,
				createdAt: w.createdAt.toISOString(),
				updatedAt: w.updatedAt.toISOString(),
			})),
			total: result.total,
			hasMore: result.hasMore,
			nextOffset: result.nextOffset,
		};
	});

/**
 * Get workspace statistics for the current user
 */
export const getWorkspaceStatsProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_READ))
	.route({
		method: "GET",
		path: "/document-workspaces/stats",
		tags: ["Document Workspaces"],
		summary: "Get workspace stats",
		description: "Get workspace statistics for the current user",
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

		return await getWorkspaceStats(user.id, organizationId);
	});
