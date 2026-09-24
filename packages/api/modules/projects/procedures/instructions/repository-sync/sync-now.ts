import { getInstructionRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";
import { startInstructionRepositorySync } from "./start-sync-workflow";

/**
 * AUTHORIZATION: tenantProtectedProcedure + requireProjectPermission(INSTRUCTION_CREATE).
 *
 * "Sync now" (design 2026-09-23 §5.1): a MANUAL run that acts as the caller.
 * The workflow re-resolves everything else from the row when it begins.
 */
export const syncRepositoryNowProcedure = tenantProtectedProcedure
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
