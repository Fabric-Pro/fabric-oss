/**
 * List Weave Plan Templates Procedure
 *
 * Returns templates available to the user, sorted by most-used first.
 * Includes both project-scoped and global templates.
 */

import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requirePermission,
	resolveOrganizationId,
} from "../../../orpc/procedures";

const ListTemplatesInputSchema = z.object({
	projectId: z.string().optional(),
	organizationId: z.string().nullable().optional(),
	category: z.string().optional(),
	limit: z.number().min(1).max(100).default(50),
});

export const listTemplatesProcedure = protectedProcedure
	.use(requirePermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/weave/templates",
		tags: ["Weave"],
		summary: "List available plan templates",
	})
	.input(ListTemplatesInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const templates = await db.weavePlanTemplate.findMany({
			where: {
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
				...(input.projectId
					? {
							OR: [
								{ projectId: input.projectId },
								{ projectId: null },
							],
						}
					: {}),
				...(input.category ? { category: input.category } : {}),
			},
			orderBy: [{ useCount: "desc" }, { updatedAt: "desc" }],
			take: input.limit,
		});

		return { templates };
	});
