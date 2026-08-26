import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isBacklogApplyWorkflowIdFor } from "./workflow-id";

/**
 * Get backlog apply changes workflow progress.
 *
 * Queries the running backlogApplyChangesWorkflow for:
 * - Current status (applying, syncing_pm, completed, etc.)
 * - Completed/total counts
 * - Errors
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` on `projectId`,
 * plus the same workflow→project binding check as analysis-progress: the
 * apply result carries the created/updated items and PM-sync outcomes, so an
 * unbound caller-supplied id would read another project's apply run.
 */
export const applyProgressProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/apply/{workflowId}/progress",
		tags: ["Projects", "Backlog"],
		summary: "Get apply progress",
		description:
			"Get the progress of a running backlog apply changes workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			workflowId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		// Bind the workflow to the authorized project before any Temporal call
		// — same guard as analysis-progress (security review of Fizzy #1234).
		if (!isBacklogApplyWorkflowIdFor(input.workflowId, input.projectId)) {
			throw new ORPCError("NOT_FOUND", {
				message: "Apply workflow not found",
			});
		}

		const { getTemporalClient, applyProgressQuery } = await import(
			"@repo/temporal"
		);
		const client = await getTemporalClient();

		try {
			const handle = client.workflow.getHandle(input.workflowId);
			const progress = await handle.query(applyProgressQuery);
			return progress;
		} catch (_queryError) {
			// Query may fail when workflow completed — try getting final result
			try {
				const handle = client.workflow.getHandle(input.workflowId);
				const result = await Promise.race([
					handle.result(),
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Result timeout")),
							3000,
						),
					),
				]);

				return {
					status: result.success ? "completed" : "failed",
					completedCount: result.appliedCount,
					totalCount: result.appliedCount,
					message: result.success
						? `Applied ${result.appliedCount} change(s). ${result.syncedToPMCount} synced to PM tool.`
						: "Apply failed",
					createdItems: result.createdItems ?? [],
					updatedItems: result.updatedItems ?? [],
					skippedItems: result.skippedItems ?? [],
					failedItems: result.failedItems ?? [],
					errors: result.errors,
					pmSyncResults: result.pmSyncResults,
					pmSyncOutage: result.pmSyncOutage,
				};
			} catch (resultError) {
				const err = resultError as Error & { cause?: Error };
				const isWorkflowFailed =
					err.name === "WorkflowFailedError" ||
					err.message?.includes("WorkflowFailed");
				const errorMessage =
					err.cause?.message ?? err.message ?? "Apply failed";

				if (isWorkflowFailed || errorMessage !== "Result timeout") {
					return {
						status: "failed",
						completedCount: 0,
						totalCount: 0,
						message: errorMessage,
						errors: [errorMessage],
					};
				}

				throw new ORPCError("NOT_FOUND", {
					message: "Apply workflow not found or already completed",
				});
			}
		}
	});
