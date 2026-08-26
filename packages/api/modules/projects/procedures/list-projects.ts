import { listProjects } from "@repo/database";
import { ProjectStatusSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requirePermissionAllowGuest,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

/**
 * List projects the caller can access.
 *
 * Gated by `requirePermissionAllowGuest(PROJECT_READ)`: the caller must
 * either have the PROJECT_READ org permission OR be a project-scoped
 * guest in the target organization. The `listProjects` DB helper then
 * scopes the returned rows to projects the caller actually has access
 * to (owner OR accepted ProjectMember).
 */
export const listProjectsProcedure = tenantProtectedProcedure
	.use(requirePermissionAllowGuest(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects",
		tags: ["Projects"],
		summary: "List projects",
		description: "List projects for the authenticated user",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			limit: z.number().min(1).max(100).optional().default(10),
			offset: z.number().min(0).optional().default(0),
			status: ProjectStatusSchema.optional(),
			search: z.string().optional(),
			deletedOnly: z.boolean().optional().default(false),
			includeDeleted: z.boolean().optional().default(false),
			includeDraft: z.boolean().optional().default(false),
			includeStatusCounts: z.boolean().optional().default(false),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		return await listProjects({
			userId: user.id,
			organizationId,
			limit: input.limit,
			offset: input.offset,
			status: input.status,
			search: input.search,
			deletedOnly: input.deletedOnly,
			includeDeleted: input.includeDeleted,
			includeDraft: input.includeDraft,
			includeStatusCounts: input.includeStatusCounts,
		});
	});
