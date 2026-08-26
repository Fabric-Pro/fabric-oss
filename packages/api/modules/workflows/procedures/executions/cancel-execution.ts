import { ORPCError } from "@orpc/client";
import {
	getWorkflowExecutionById,
	updateWorkflowExecution,
} from "@repo/database";
import { getTemporalClient, isTemporalAvailable } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../../organizations/lib/membership";

/** Executions that have already finished; cancelling one is a no-op. */
const TERMINAL_STATUSES = new Set([
	"COMPLETED",
	"FAILED",
	"CANCELLED",
	"TIMED_OUT",
]);

/**
 * Cancel a running workflow execution.
 *
 * Requests cancellation in Temporal and lets the workflow record its own
 * terminal state — it catches the cancellation and writes CANCELLED along with
 * whatever its completed nodes produced. The DB write here is a fallback for
 * the case where Temporal is unreachable, or where the execution never got a
 * Temporal workflow at all (Temporal was down when it was started), so a user
 * is never left with a row stuck in RUNNING.
 */
export const cancelWorkflowExecutionProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.WORKSPACE_UPDATE))
	.route({
		method: "POST",
		path: "/workflows/executions/{executionId}/cancel",
		tags: ["Workflows"],
		summary: "Cancel workflow execution",
		description: "Request cancellation of a running workflow execution",
	})
	.input(
		z.object({
			executionId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			cancelled: z.boolean(),
			status: z.string(),
			message: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		if (organizationId) {
			const membership = await verifyOrganizationMembership(
				organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN", {
					message: "You are not a member of this organization",
				});
			}
		}

		// Tenant-scoped lookup: a caller who cannot see the execution gets the
		// same NOT_FOUND as one asking for an id that does not exist.
		const execution = await getWorkflowExecutionById(
			input.executionId,
			user.id,
			organizationId ?? undefined,
		);

		if (!execution) {
			throw new ORPCError("NOT_FOUND", {
				message: "Execution not found",
			});
		}

		// Idempotent: cancelling a finished execution reports its state rather
		// than erroring, so a double-click or a stale UI is harmless.
		if (TERMINAL_STATUSES.has(execution.status)) {
			return {
				cancelled: false,
				status: execution.status,
				message: `Execution already ${execution.status.toLowerCase()}`,
			};
		}

		const temporalWorkflowId = execution.temporalRunId;

		if (temporalWorkflowId && (await isTemporalAvailable())) {
			try {
				const client = await getTemporalClient();
				await client.workflow.getHandle(temporalWorkflowId).cancel();

				// The workflow writes its own terminal state on the way out,
				// including the outputs of nodes that already completed.
				return {
					cancelled: true,
					status: "CANCELLING",
					message: "Cancellation requested",
				};
			} catch (error) {
				// Fall through to the direct write below: the handle may be
				// gone because the run already finished or was evicted, and
				// leaving the row RUNNING forever is worse than recording a
				// best-effort CANCELLED.
				console.warn(
					"[Workflows] Temporal cancellation failed; marking execution cancelled directly",
					{
						executionId: input.executionId,
						error:
							error instanceof Error
								? error.message
								: String(error),
					},
				);
			}
		}

		await updateWorkflowExecution(input.executionId, {
			status: "CANCELLED",
			completedAt: new Date(),
			error: "Cancelled by user",
		});

		return {
			cancelled: true,
			status: "CANCELLED",
			message: temporalWorkflowId
				? "Cancelled (Temporal unavailable)"
				: "Cancelled (execution had no Temporal run)",
		};
	});
