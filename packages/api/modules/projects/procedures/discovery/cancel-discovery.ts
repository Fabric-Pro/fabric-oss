/**
 * Cancel Discovery Run (plan Slice 4)
 *
 * AUTHORIZATION: requireProjectPermission(AGENT_EXECUTE) — the same right
 * that starts a run can stop it.
 *
 * Signals the deterministic workflow id. Only a typed WorkflowNotFoundError
 * counts as "already gone"; any other failure (Temporal unreachable) is
 * surfaced so the row is not marked CANCELLED while an execution may still
 * be running (mirrors coding-run cancel).
 */

import { ORPCError } from "@orpc/client";
import { db } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationIdForCaller,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import {
	ACTIVE_DISCOVERY_RUN_STATUSES,
	discoveryRunWorkflowId,
	isWorkflowNotFoundError,
} from "./lib";

export const cancelDiscoveryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.AGENT_EXECUTE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/discovery/runs/{runId}/cancel",
		tags: ["Projects", "Features", "Discovery"],
		summary: "Cancel an active discovery run",
	})
	.input(
		z.object({
			projectId: z.string(),
			runId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(z.object({ status: z.string() }))
	.handler(async ({ input, context }) => {
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			context.user.id,
		);
		const run = await db.discoveryRun.findFirst({
			where: {
				id: input.runId,
				projectId: input.projectId,
				organizationId: organizationId ?? null,
			},
			select: { id: true, status: true, workflowId: true },
		});
		if (!run) {
			throw new ORPCError("NOT_FOUND", {
				message: "Discovery run not found",
			});
		}
		if (
			!(ACTIVE_DISCOVERY_RUN_STATUSES as readonly string[]).includes(
				run.status,
			)
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot cancel a discovery run with status: ${run.status}`,
			});
		}

		const workflowId = run.workflowId ?? discoveryRunWorkflowId(run.id);
		try {
			const temporal = await getTemporalClient();
			await temporal.workflow
				.getHandle(workflowId)
				.signal("cancelDiscovery");
		} catch (error) {
			if (!isWorkflowNotFoundError(error)) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Failed to cancel workflow: ${error instanceof Error ? error.message : "Unknown error"}`,
				});
			}
		}

		// Compare-and-swap from an active status so a concurrent persistence
		// (RUNNING → CONTRACT_READY) and this cancel cannot both win.
		const cancelled = await db.discoveryRun.updateMany({
			where: {
				id: run.id,
				status: { in: [...ACTIVE_DISCOVERY_RUN_STATUSES] as never },
			},
			data: { status: "CANCELLED" },
		});
		if (cancelled.count !== 1) {
			throw new ORPCError("CONFLICT", {
				message:
					"The discovery run changed state while cancelling; refresh and retry",
			});
		}

		return { status: "cancelled" };
	});
