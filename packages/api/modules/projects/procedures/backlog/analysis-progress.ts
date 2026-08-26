import { ORPCError } from "@orpc/client";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { isBacklogAnalysisWorkflowIdFor } from "./workflow-id";

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
 * project and a timestamp (security review of Fizzy #1234).
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

			// If complete, also query the result
			let proposal = null;
			if (progress.status === "complete") {
				try {
					proposal = await handle.query(analysisResultQuery);
				} catch {
					// Result query may fail if workflow already cleaned up
				}
			}

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
						message: result.error ?? "Analysis complete",
						// This path rebuilds `progress` by hand rather than
						// returning the query's own object, so anything the
						// workflow puts on it has to be carried across
						// explicitly. The log-context note (Fizzy #1234 FR3)
						// is the reason a user is told logs were unavailable,
						// and a run that finished before the first poll lands
						// here — dropping it would silently lose the note for
						// exactly the fast runs most likely to have no logs.
						logContextNote: result.logContextNote,
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

				// Workflow ended in a terminal state we couldn't query (Failed,
				// Terminated, Canceled, TimedOut, ContinuedAsNew).
				// `handle.result()` rejects with a SDK error whose `cause`
				// carries the underlying failure. Fall back to `describe()`
				// to get the canonical execution status + termination reason
				// when the error itself doesn't carry a useful message — this
				// covers the BadScheduleActivityAttributes case, where the
				// workflow is Terminated by history-service with a reason
				// like "Input exceeds size limit" but no thrown error
				// includes that text.
				let message = err.cause?.message ?? err.message;
				try {
					const handle = client.workflow.getHandle(input.workflowId);
					const desc = await handle.describe();
					// `desc.status.name` is one of FAILED, TERMINATED,
					// CANCELED, TIMED_OUT, CONTINUED_AS_NEW (for terminal
					// states). For TERMINATED, the only place the reason
					// lives is on the WorkflowExecutionTerminated event in
					// history. The SDK surfaces it inconsistently across
					// versions, so we fetch the most recent history event
					// directly when needed.
					if (desc.status.name === "TERMINATED") {
						const history = await handle.fetchHistory();
						// `eventType` is a numeric enum from
						// @temporalio/proto; identify the termination event
						// by its attributes payload (which is only populated
						// for the matching type) so we don't need to import
						// the enum just to compare.
						const terminated = history.events?.find(
							(e) =>
								e.workflowExecutionTerminatedEventAttributes !=
								null,
						);
						const reason =
							terminated
								?.workflowExecutionTerminatedEventAttributes
								?.reason;
						if (reason) {
							message = `Analysis terminated: ${reason}`;
						}
					}
				} catch {
					// describe() / fetchHistory() failure is non-fatal —
					// fall through with whatever `message` we already have.
				}

				// No `logContextNote` here, and it is not an oversight: this
				// branch is reached only when the workflow ended in a hard
				// terminal state (FAILED / TERMINATED), which means it THREW
				// rather than returning. The note lived in workflow state that
				// no longer exists, so there is nothing to carry across.
				// Fizzy #1234 FR3's guarantee therefore covers a completed
				// analysis, not one that died — a user in this branch has a
				// failure message to act on instead.
				return {
					progress: {
						status: "failed",
						message: message ?? "Analysis failed",
					},
					proposal: null,
				};
			}
		}
	});
