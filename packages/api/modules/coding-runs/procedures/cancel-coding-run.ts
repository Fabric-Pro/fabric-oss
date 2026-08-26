/**
 * Cancel Coding Run Procedure
 *
 * AUTHORIZATION: Org-level AGENT_DELETE via middleware, PLUS a project-level
 * STORY_UPDATE check inside the handler (the input has only the run id, so
 * the project-scoped middleware can't gate this — resolve the projectId
 * after loading the run and check manually).
 */

import { ORPCError } from "@orpc/client";
import {
	getCodingRun,
	getProjectMemberRole,
	updateCodingRunStatus,
} from "@repo/database";
import {
	hasPermission,
	Permissions as ProjectPerms,
	resolveProjectPermissions,
} from "@repo/permissions";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const cancelCodingRunProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_DELETE))
	.route({
		method: "POST",
		path: "/coding-runs/{id}/cancel",
		tags: ["CodingRuns"],
		summary: "Cancel an active coding run",
	})
	.input(
		z.object({
			id: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			status: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const run = await getCodingRun(input.id, user.id, organizationId);
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Coding run not found",
			});
		}

		// Project-level authorization: only project members with STORY_UPDATE
		// on this specific project can cancel runs on it. Middleware above
		// already confirmed AGENT_DELETE at the org level.
		const projectRole = await getProjectMemberRole(run.projectId, user.id);
		const projectGranted = resolveProjectPermissions(projectRole);
		if (!hasPermission(projectGranted, ProjectPerms.STORY_UPDATE)) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have permission to manage this coding run",
			});
		}

		// Only cancel if in an active state
		if (
			![
				"QUEUED",
				"STARTING",
				"RUNNING",
				"AWAITING_REVIEW",
				"PR_OPENED",
			].includes(run.status)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot cancel a coding run with status: ${run.status}`,
			});
		}

		// Signal the Temporal workflow to cancel
		if (run.workflowId) {
			try {
				const temporal = await getTemporalClient();
				const handle = temporal.workflow.getHandle(run.workflowId);
				await handle.signal("cancelCodingRun");
			} catch (error) {
				// WorkflowNotFoundError means it's already done — safe to mark cancelled.
				// Any other error (e.g. Temporal unavailable) means the agent may still
				// be running, so surface it rather than silently marking cancelled.
				const isNotFound =
					error instanceof Error &&
					error.name === "WorkflowNotFoundError";
				if (!isNotFound) {
					throw new ORPCError("INTERNAL_SERVER_ERROR", {
						message: `Failed to cancel workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
					});
				}
			}
		}

		await updateCodingRunStatus(run.id, "CANCELLED");

		return { status: "cancelled" };
	});
