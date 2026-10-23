import { ORPCError } from "@orpc/client";
import type { BacklogContextAnalysisProgress } from "@repo/temporal";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isBacklogAnalysisWorkflowIdFor } from "./workflow-id";
import { workflowProgressFailure } from "./workflow-progress-failure";

/**
 * Get backlog analysis workflow progress and result.
 *
 * Queries the running backlogContextAnalysisWorkflow for:
 * - Current status (fetching_teams, analyzing, complete, etc.)
 * - The analysis result (ChangeProposal) when complete
 *
 * AUTHORIZATION: `requireProjectPermission(PROJECT_UPDATE)` on `projectId`,
 * plus a binding check: the caller-supplied `workflowId` must name THAT
 * project. Both are needed — project access alone would let a user read any
 * other project's proposal by guessing its workflow id, which embeds only the
 * project and a timestamp or hashed operation key (security review of Fizzy #1234).
 */
export const analysisProgressProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/backlog/analyze/{workflowId}/progress",
		tags: ["Projects", "Backlog"],
		summary: "Get analysis progress",
		description:
			"Get the progress and result of a running backlog analysis workflow",
	})
	.input(
		z.object({
			projectId: z.string(),
			workflowId: z.string(),
		}),
	)
	.handler(async ({ input }) => {
		// Bind the workflow to the authorized project BEFORE any Temporal call:
		// the id is the only thing that selects whose analysis this is, and
		// rejecting here (with a 404 that never touches Temporal) leaves no
		// oracle for probing other projects' workflow ids.
		if (
			!isBacklogAnalysisWorkflowIdFor(input.workflowId, input.projectId)
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "Analysis workflow not found",
			});
		}

		const {
			getTemporalClient,
			analysisProgressQuery,
			analysisResultQuery,
		} = await import("@repo/temporal");
		const client = await getTemporalClient();

		try {
			const handle = client.workflow.getHandle(input.workflowId);

			// Query progress
			const progress = await handle.query(analysisProgressQuery);

			if (
				progress.status !== "complete" &&
				progress.status !== "failed" &&
				progress.status !== "cancelled" &&
				[
					"COMPLETED",
					"FAILED",
					"TERMINATED",
					"CANCELLED",
					"TIMED_OUT",
					"CONTINUED_AS_NEW",
				].includes((await handle.describe()).status.name)
			) {
				throw new Error("Analysis workflow closed; read its result");
			}
			// A throwing result query must reach the fallback, not imply an empty proposal.
			const proposal =
				progress.status === "complete"
					? await handle.query(analysisResultQuery)
					: null;

			return { progress, proposal };
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
					progress: {
						status: result.success ? "complete" : "failed",
						message:
							result.error ??
							result.skippedReason ??
							"Analysis complete",
						// This path rebuilds `progress` by hand rather than
						// returning the query's own object, so anything the
						// workflow puts on it has to be carried across
						// explicitly. The log-context note (Fizzy #1234 FR3)
						// is the reason a user is told logs were unavailable,
						// and a run that finished before the first poll lands
						// here — dropping it would silently lose the note for
						// exactly the fast runs most likely to have no logs.
						logContextNote: result.logContextNote,
						pmContextNote: result.pmContextNote,
					},
					proposal: result.proposal ?? null,
				};
			} catch (resultError) {
				const err = resultError as Error & { cause?: Error };

				if (err.message === "Result timeout") {
					// Workflow is alive but not responding to queries — leave it
					// to the caller to keep polling; surface as 404 so the
					// client treats this run as not-yet-available.
					throw new ORPCError("NOT_FOUND", {
						message:
							"Analysis workflow not found or already completed",
					});
				}

				const failure: BacklogContextAnalysisProgress =
					await workflowProgressFailure(
						client.workflow.getHandle(input.workflowId),
						resultError,
						"Analysis",
					);
				return { progress: failure, proposal: null };
			}
		}
	});
