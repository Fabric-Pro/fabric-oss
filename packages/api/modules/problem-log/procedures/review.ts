import { ORPCError } from "@orpc/server";
import { reviewProblemLogEntry } from "@repo/database";
import {
	ProblemLogCategorySchema,
	ProblemLogSeveritySchema,
} from "@repo/database/prisma/zod";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";
import {
	auditActor,
	loadProblemLogProject,
	loadProjectEntry,
} from "../lib/access";

/**
 * Confirms (optionally with edits) or dismisses an entry Fabric drafted from
 * project context. The entry and its `project.problem_log.reviewed` audit row
 * commit together; a confirmed entry carries the reviewer's edits.
 */
export const reviewProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROBLEM_LOG_MANAGE))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			entryId: z.string(),
			decision: z.enum(["CONFIRM", "DISMISS"]),
			edits: z
				.object({
					title: z.string().trim().min(1).max(300).optional(),
					description: z
						.string()
						.trim()
						.max(4000)
						.nullable()
						.optional(),
					category: ProblemLogCategorySchema.extract([
						"PROJECT_ISSUE",
						"PROJECT_BLOCKER",
						"PROJECT_RISK",
					]).optional(),
					severity: ProblemLogSeveritySchema.exclude([
						"INFO",
					]).optional(),
				})
				.optional(),
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
		const current = await loadProjectEntry(
			organizationId,
			input.projectId,
			input.entryId,
		);
		if (current.reviewState !== "PENDING") {
			throw new ORPCError("CONFLICT", {
				message: "This entry has already been reviewed.",
			});
		}
		const entry = await reviewProblemLogEntry({
			organizationId,
			entryId: current.id,
			decision: input.decision,
			edits: input.edits,
			actor: auditActor(context),
		});
		if (!entry) {
			throw new ORPCError("CONFLICT", {
				message: "This entry has already been reviewed.",
			});
		}
		return { entry };
	});
