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
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";

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
	// Bounded: the page is merged from two queries that each read
	// `offset + limit` rows, so an unbounded offset would load that many.
	limit: z.number().int().min(1).max(100).default(20),
	offset: z.number().int().min(0).max(10_000).default(0),
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
		// The project's own organization (a string — never `undefined`, which
		// Prisma would read as "no filter"). A different input organization is
		// refused.
		const organizationId = await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
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

		// Two exclusive filters inside the authorized project, never one OR of
		// a user arm and an organization arm (AGENTS.md):
		//  - plans stamped with the project's organization, which is what
		//    `create-plan` stamps since the authorized-project binding;
		//  - the caller's OWN legacy plans stamped `null` — a guest's plans
		//    from before the binding — which the plan procedures accept too
		//    (`lib/plan-organization.ts`).
		const statusFilter = input.status ? { status: input.status } : {};
		const organizationWhere = {
			projectId: input.projectId,
			organizationId,
			...statusFilter,
		};
		const legacyWhere = {
			projectId: input.projectId,
			userId,
			organizationId: null,
			...statusFilter,
		};
		const include = {
			executions: {
				orderBy: { createdAt: "desc" as const },
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
		};
		// Each side returns at most the first `offset + limit` rows of the
		// merged order, so the page is exact without loading either in full.
		const window = input.offset + input.limit;
		const [organizationPlans, legacyPlans, organizationTotal, legacyTotal] =
			await Promise.all([
				db.weavePlan.findMany({
					where: organizationWhere,
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: window,
					include,
				}),
				db.weavePlan.findMany({
					where: legacyWhere,
					orderBy: [{ createdAt: "desc" }, { id: "desc" }],
					take: window,
					include,
				}),
				db.weavePlan.count({ where: organizationWhere }),
				db.weavePlan.count({ where: legacyWhere }),
			]);
		const plans = [...organizationPlans, ...legacyPlans]
			.sort(
				(a, b) =>
					b.createdAt.getTime() - a.createdAt.getTime() ||
					(a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
			)
			.slice(input.offset, window);
		const total = organizationTotal + legacyTotal;

		return {
			plans,
			total,
			hasMore: input.offset + input.limit < total,
		};
	});
