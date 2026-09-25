import {
	getInstructionRepositorySync,
	listInstructionRepositorySyncRuns,
} from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { toSyncRunView } from "./views";

const MAX_RUNS = 50;

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_READ).
 *
 * History's "Sync runs" list, newest first (design 2026-09-23 §7.3),
 * including the runs of a sync that was switched off, each marked by
 * whether it came from the current configuration (Fizzy #2672).
 */
export const listRepositorySyncRunsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/repository-sync/runs",
		tags: ["Projects", "Instructions"],
		summary: "List coding-instructions repository sync runs",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			limit: z.number().int().min(1).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const [runs, sync] = await Promise.all([
			listInstructionRepositorySyncRuns(
				input.projectId,
				organizationId,
				Math.min(input.limit ?? 20, MAX_RUNS),
			),
			getInstructionRepositorySync(input.projectId, organizationId),
		]);
		const currentSyncId = sync?.id ?? null;
		return { runs: runs.map((run) => toSyncRunView(run, currentSyncId)) };
	});
