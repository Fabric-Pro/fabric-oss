/**
 * List Weave Plans Procedure
 */

import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	protectedProcedure,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

const ListPlansInputSchema = z.object({
	projectId: z.string(),
	organizationId: z.string().nullable().optional(),
	status: z
		.enum([
			"DRAFT",
			"PENDING_APPROVAL",
			"APPROVED",
			"RUNNING",
			"PAUSED",
			"COMPLETED",
			"FAILED",
			"CANCELLED",
		])
		.optional(),
	limit: z.number().default(20),
	offset: z.number().default(0),
});

export const listPlansProcedure = protectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_READ))
	.route({
		method: "GET",
		path: "/weave/plans",
		tags: ["Weave"],
		summary: "List weave plans for project",
	})
	.input(ListPlansInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		// Verify project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			userId,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const where = {
			projectId: input.projectId,
			...(organizationId
				? { organizationId }
				: { userId, organizationId: null }),
			...(input.status ? { status: input.status } : {}),
		};

		const [plans, total] = await Promise.all([
			db.weavePlan.findMany({
				where,
				orderBy: { createdAt: "desc" },
				take: input.limit,
				skip: input.offset,
				include: {
					executions: {
						orderBy: { createdAt: "desc" },
						take: 1,
						select: {
							id: true,
							status: true,
							createdAt: true,
							completedAt: true,
						},
					},
					userStory: {
						select: {
							id: true,
							title: true,
							identifier: true,
						},
					},
					storyTask: {
						select: {
							id: true,
							title: true,
						},
					},
				},
			}),
			db.weavePlan.count({ where }),
		]);

		return {
			plans,
			total,
			hasMore: input.offset + input.limit < total,
		};
	});
