/**
 * Daily Brief — List Procedure
 *
 * Paginated brief history for a project.
 */
import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const listProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(50).default(20),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const project = await db.project.findFirst({
			where: organizationId
				? { id: input.projectId, organizationId }
				: {
						id: input.projectId,
						organizationId: null,
						userId: context.user.id,
					},
			select: { id: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}

		const briefs = await db.dailyBrief.findMany({
			where: { projectId: input.projectId },
			orderBy: { generatedAt: "desc" },
			take: input.limit + 1,
			...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
			select: {
				id: true,
				generatedAt: true,
				timeWindowStart: true,
				timeWindowEnd: true,
				timeWindowKind: true,
				status: true,
				errorMessage: true,
				generatedByUserId: true,
			},
		});

		const hasMore = briefs.length > input.limit;
		const page = hasMore ? briefs.slice(0, input.limit) : briefs;
		const nextCursor = hasMore ? page[page.length - 1]?.id : null;

		return {
			items: page,
			nextCursor,
		};
	});
