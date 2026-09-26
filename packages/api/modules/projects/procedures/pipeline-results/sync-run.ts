import { z } from "zod";
import {
	CLOSED_WORKFLOW_STATUSES,
	withTimeout,
} from "../../../../lib/temporal-describe";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertPipelineResultsEnabled } from "../../lib/pipeline-results-feature";
import { pipelineResultsSyncWorkflowId } from "./sync";

/** Bounds one `describe()` call so a stuck Temporal connection cannot hang a poll. */
const DESCRIBE_TIMEOUT_MS = 5_000;

/**
 * Whether the exact Temporal run `sync` started or joined has closed — the
 * run-anchored replacement for judging completion from a sync-state row's
 * `updatedAt` (Fizzy #2722): a row another writer touched looks identical to
 * one this sync wrote, and a row the previous sync never wrote (a first sync,
 * a newly connected source) never existed to compare against. The run itself
 * cannot be confused with another writer's, because "sync" and the scheduled
 * 15-minute sweep both start the SAME workflow id and a click during an
 * in-flight run joins it (`USE_EXISTING`).
 *
 * `running` while Temporal reports RUNNING; `closed` once it reaches a
 * terminal status OR Temporal no longer has the run at all — a run Temporal
 * has forgotten is long over, never still in flight; `unknown` for anything
 * else (a timeout, an unrecognized status, any other describe failure) so a
 * transient failure is never mistaken for completion.
 */
export const syncRunStateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/pipeline-results/sync-runs/{runId}",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Check whether a pipeline-results sync run has closed",
		description:
			"Describe the exact Temporal run a sync started or joined, so the caller can tell this run's completion apart from another writer touching the same sync-state rows.",
	})
	.input(
		z.object({
			projectId: z.string(),
			runId: z.string().min(1).max(128),
		}),
	)
	.output(
		z.object({
			state: z.enum(["running", "closed", "unknown"]),
		}),
	)
	.handler(async ({ input }) => {
		assertPipelineResultsEnabled();
		// AUTHORIZATION: requireProjectPermission(TEST_CASE_READ) is the tenant
		// boundary. The workflow id is derived from the authorized projectId, not
		// taken from the caller, so a runId for another project's sync simply
		// describes a run that never existed under THIS id and comes back
		// "closed" (not-found) — it cannot be used to probe a foreign run.
		const workflowId = pipelineResultsSyncWorkflowId(input.projectId);
		try {
			const { getTemporalClient } = await import("@repo/temporal");
			const client = await withTimeout(
				getTemporalClient(),
				DESCRIBE_TIMEOUT_MS,
			);
			const description = await withTimeout(
				client.workflow.getHandle(workflowId, input.runId).describe(),
				DESCRIBE_TIMEOUT_MS,
			);
			const status = description.status.name;
			return {
				state:
					status === "RUNNING"
						? ("running" as const)
						: CLOSED_WORKFLOW_STATUSES.has(status)
							? ("closed" as const)
							: ("unknown" as const),
			};
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "WorkflowNotFoundError"
			) {
				return { state: "closed" as const };
			}
			return { state: "unknown" as const };
		}
	});
