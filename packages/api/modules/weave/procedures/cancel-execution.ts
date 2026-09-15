/**
 * Cancel Weave Execution Procedure
 *
 * Cancels an in-progress execution by signaling the Fabric Loom workflow.
 */

import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { getTemporalClient } from "@repo/temporal";
import { orchestratorCancelSignal } from "@repo/temporal/workflows";
import { z } from "zod";
import {
	assertProjectPermission,
	Permissions,
	protectedProcedure,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";
import { resolveWeaveHandle } from "../lib/temporal-handle";

const CancelExecutionInputSchema = z.object({
	executionId: z.string(),
	organizationId: z.string().nullable().optional(),
});

export const cancelExecutionProcedure = protectedProcedure
	.route({
		method: "POST",
		path: "/weave/executions/:executionId/cancel",
		tags: ["Weave"],
		summary: "Cancel execution",
	})
	.input(CancelExecutionInputSchema)
	.handler(async ({ input, context }) => {
		const userId = context.user.id;
		const organizationId = await resolveOrganizationIdForCaller(
			input.organizationId,
			context.session,
			userId,
		);

		const execution = await db.weaveExecution.findFirst({
			where: {
				id: input.executionId,
				userId,
				...(organizationId
					? { organizationId }
					: { organizationId: null }),
			},
		});

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found or access denied",
			});
		}

		// Object-level, and the same decision the middleware makes for a
		// procedure whose input names the project. This one names an execution, so
		// the project is only known here.
		await assertProjectPermission(
			execution.projectId,
			userId,
			Permissions.AGENT_UPDATE,
		);

		// PENDING is cancellable so a row left behind by an ambiguous start
		// (start-execution could not confirm whether Temporal accepted the
		// start) has a recovery path; the cancel signal still goes to the
		// deterministic workflow id in case an execution is live behind it.
		if (
			execution.status !== "PENDING" &&
			execution.status !== "RUNNING" &&
			execution.status !== "PAUSED" &&
			execution.status !== "CHECKPOINT"
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Cannot cancel execution in status: ${execution.status}`,
			});
		}

		try {
			const temporal = await getTemporalClient();
			const handle = resolveWeaveHandle(temporal, execution);
			await handle.signal(orchestratorCancelSignal);
		} catch (error) {
			// Only a definite "workflow does not exist" lets us mark the row
			// CANCELLED without a delivered signal. Any other failure
			// (Temporal unavailable, transport error) leaves the row in its
			// current status: marking it CANCELLED would release the
			// one-active-execution partial unique index while the workflow may
			// still be running, permitting a duplicate execution.
			const name = error instanceof Error ? error.name : "";
			if (name !== "WorkflowNotFoundError") {
				logger.warn(
					"[weave] Cancel signal failed; execution left active",
					{
						workflowId: execution.workflowId,
						error:
							error instanceof Error ? error.message : "unknown",
					},
				);
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"Could not deliver the cancel signal; the execution remains active. Retry once Temporal is reachable.",
				});
			}
		}

		await db.weaveExecution.update({
			where: { id: input.executionId },
			data: { status: "CANCELLED", completedAt: new Date() },
		});

		// Restore the parent plan to APPROVED immediately so its Execute
		// buttons come back the moment the user cancels — rather than waiting
		// for the workflow to wind down and the cleanup activity to reconcile.
		// Guarded on RUNNING so a plan already moved on (e.g. another run) is
		// untouched; the cleanup reconcile is the idempotent safety net.
		await db.weavePlan.updateMany({
			where: { id: execution.planId, status: "RUNNING" },
			data: { status: "APPROVED" },
		});

		return {
			success: true,
			message: "Execution cancelled",
		};
	});
