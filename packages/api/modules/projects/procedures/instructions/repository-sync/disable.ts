import { ORPCError } from "@orpc/client";
import { deleteInstructionRepositorySync } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { requireHostingOrganizationId } from "../hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible +
 * requireProjectPermission(INSTRUCTION_CREATE).
 *
 * "Switch to upload mode" (design 2026-09-23 §5.1, §7.4): delete the
 * configuration and flip the project to UPLOAD in one transaction. NOT
 * refused while a run is in flight: that run is fenced on the configuration
 * it captured and can neither publish nor overwrite anything. Also the
 * recovery for a project left in REPOSITORY with no row.
 */
export const disableRepositorySyncProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_CREATE))
	.route({
		method: "DELETE",
		path: "/projects/:projectId/instructions/repository-sync",
		tags: ["Projects", "Instructions"],
		summary: "Switch coding instructions back to upload mode",
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
		const result = await deleteInstructionRepositorySync({
			projectId: input.projectId,
			organizationId,
		});
		if (!result) {
			throw new ORPCError("NOT_FOUND", { message: "Project not found" });
		}
		recordAuditFromRequest(context, {
			action: "project.instructions.repository_sync_disabled",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: { reason: "user", hadConfiguration: result.deleted },
		});
		return { disabled: true as const, hadConfiguration: result.deleted };
	});
