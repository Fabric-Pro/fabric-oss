/**
 * Daily Brief — List Procedure
 *
 * Paginated brief history for a project.
 */
import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import { assertInputOrgMatchesProject } from "../../../lib/authorized-project-tenant";
import {
	Permissions,
	requireProjectPermission,
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
	.handler(async ({ input }) => {
		// `requireProjectPermission` above has already authorized this caller for
		// THIS project — as owner, active ProjectMember, or via an org role. Load
		// the project by id and take the tenant from the loaded row;
		// `input.organizationId` is a guard, never a scoping key.
		const project = await db.project.findUnique({
			where: { id: input.projectId },
			select: { id: true, organizationId: true },
		});
		if (!project) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		assertInputOrgMatchesProject(input.organizationId, project);

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
