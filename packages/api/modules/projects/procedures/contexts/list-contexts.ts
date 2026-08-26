import { ORPCError } from "@orpc/client";
import { hasProjectAccess, listContexts } from "@repo/database";
import { ProjectContextTypeSchema } from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const listContextsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.CONTEXT_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/contexts",
		tags: ["Projects", "Contexts"],
		summary: "List contexts",
		description: "List contexts for a project",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			type: ProjectContextTypeSchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// List contexts - returns { contexts, total, hasMore }
		// Exclude contexts that have been imported as documents (linked via sourceContextId).
		// Use limit: "none" so the Context tab shows every source type — the UI
		// renders a single scroll area with no pagination, and the default batching
		// limit (50) would silently drop older GitHub/Notion/codebase rows when a
		// project accumulates many recent meeting transcripts.
		const result = await listContexts({
			projectId: input.projectId,
			type: input.type,
			excludeLinkedDocuments: true,
			limit: "none",
		});

		// Return flattened response (not double-nested)
		return result;
	});
