import { listProblemLogEntries } from "@repo/database";
import {
	ProblemLogCategorySchema,
	ProblemLogReviewStateSchema,
	ProblemLogStatusSchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";
import { loadProblemLogProject } from "../lib/access";

/**
 * Problem Log entries of one project, most recently seen first. Confirmed
 * entries unless `reviewState` asks for drafts awaiting review.
 */
export const listProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROBLEM_LOG_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			status: ProblemLogStatusSchema.optional(),
			reviewState: ProblemLogReviewStateSchema.exclude([
				"DISMISSED",
			]).optional(),
			category: ProblemLogCategorySchema.optional(),
			cursor: z.string().optional(),
			limit: z.number().int().min(1).max(100).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		const { organizationId } = await loadProblemLogProject({
			projectId: input.projectId,
			userId: context.user.id,
		});
		return listProblemLogEntries({
			organizationId,
			projectIds: [input.projectId],
			status: input.status,
			reviewState: input.reviewState,
			category: input.category,
			cursor: input.cursor,
			limit: input.limit,
		});
	});
