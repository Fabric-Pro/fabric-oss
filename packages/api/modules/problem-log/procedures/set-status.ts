import { ORPCError } from "@orpc/server";
import { setProblemLogEntryStatus } from "@repo/database";
import { ProblemLogStatusSchema } from "@repo/database/prisma/zod";
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
 * Moves an entry between OPEN and RESOLVED. The entry and its immutable
 * `project.problem_log.status_changed` audit row commit together.
 */
export const setStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROBLEM_LOG_MANAGE))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			entryId: z.string(),
			status: ProblemLogStatusSchema,
			note: z.string().trim().max(1000).optional(),
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
		if (current.reviewState !== "CONFIRMED") {
			throw new ORPCError("BAD_REQUEST", {
				message: "Review the drafted entry before changing its status.",
			});
		}
		const entry = await setProblemLogEntryStatus({
			organizationId,
			entryId: current.id,
			status: input.status,
			note: input.note,
			actor: auditActor(context),
		});
		if (!entry) {
			throw new ORPCError("NOT_FOUND", { message: "Entry not found" });
		}
		return { entry };
	});
