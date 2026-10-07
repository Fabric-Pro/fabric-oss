import {
	getInstructionRepositorySync,
	getProjectInstructionSettings,
	instructionRepositoryImportAllowed,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { assertNoOpenMigration } from "../migration-freeze";
import { startInstructionRepositorySync } from "./start-sync-workflow";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 *
 * "Sync now" (design 2026-09-23 §5.1): a MANUAL run that acts as the caller.
 * The workflow re-resolves everything else from the row when it begins.
 */
export const syncRepositoryNowProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository-sync/run",
		tags: ["Projects", "Instructions"],
		summary: "Sync coding instructions from the repository now",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		// While a move from uploads is proposing, the row is paused and the
		// folder holds nothing yet: a run would only be skipped. Once it is
		// switching a manual run is the way to hurry it along (Fizzy #2878 §9).
		await assertNoOpenMigration(
			{ projectId: input.projectId, organizationId },
			{ onlyWhile: "PROPOSING" },
		);
		const sync = await getInstructionRepositorySync(
			input.projectId,
			organizationId,
		);
		if (!sync) {
			return {
				started: false as const,
				reason: "not_configured" as const,
			};
		}
		const settings = await getProjectInstructionSettings(
			input.projectId,
			organizationId,
		);
		if (!instructionRepositoryImportAllowed(settings, sync.id)) {
			return {
				started: false as const,
				reason: "direct_repository" as const,
			};
		}
		if (sync.repositoryIntegration.status !== "ACTIVE") {
			return {
				started: false as const,
				reason: "integration_unavailable" as const,
			};
		}
		const started = await startInstructionRepositorySync({
			projectId: input.projectId,
			organizationId,
			trigger: "MANUAL",
			requesterUserId: context.user.id,
		});
		if (!started) {
			return {
				started: false as const,
				reason: "already_running" as const,
			};
		}
		recordAuditFromRequest(context, {
			action: "project.instructions.repository_sync_started",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "project_instruction_repository_sync",
				id: sync.id,
				name: null,
			},
			metadata: { trigger: "MANUAL" },
		});
		return { started: true as const };
	});
