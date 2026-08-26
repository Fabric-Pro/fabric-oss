/**
 * Dispatcher for the context-summarization workflow. Shared by the manual
 * API trigger and the auto-trigger cron.
 *
 * Overlap-safe by construction. Two guards, cheapest first:
 *  1. a friendly DB early-out — if a PENDING/GENERATING summary already exists
 *     for the project, don't dispatch (`started: false`);
 *  2. a deterministic `workflowId` + `workflowIdConflictPolicy: "FAIL"` — if a
 *     run is already live under that id, Temporal rejects the duplicate start
 *     (`WorkflowExecutionAlreadyStartedError`), which we map to
 *     `started: false`.
 *
 * Genuine infrastructure errors (Temporal unreachable, unexpected start
 * failure) THROW so the API can surface them; the cron wraps each dispatch in
 * its own try/catch, so one project's failure never blocks the sweep.
 */

import {
	cancelContextSummary,
	getInProgressContextSummary,
} from "@repo/database";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../client";
import type { ContextSummarizationInput } from "../workflows/context-summarization-workflow";

export type { ContextSummarizationInput } from "../workflows/context-summarization-workflow";

const TASK_QUEUE = "fabric-worker";

export async function startContextSummarizationWorkflow(
	input: ContextSummarizationInput,
): Promise<{ workflowId: string; started: boolean }> {
	const workflowId = `context-summarization-${input.projectId}`;

	// Friendly early-out: an active run already owns this project's summary.
	const inProgress = await getInProgressContextSummary({
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (inProgress) {
		return { workflowId, started: false };
	}

	const client = await getTemporalClient();
	try {
		await client.workflow.start("contextSummarizationWorkflow", {
			taskQueue: TASK_QUEUE,
			workflowId,
			// Deterministic id + FAIL conflict policy ⇒ at most one LIVE run per
			// project. A prior CLOSED run with the same id is allowed (default
			// reuse policy), so a later summarization reuses the id cleanly.
			workflowIdConflictPolicy: "FAIL",
			args: [input],
		});
		return { workflowId, started: true };
	} catch (error) {
		if (error instanceof WorkflowExecutionAlreadyStartedError) {
			return { workflowId, started: false };
		}
		throw error;
	}
}

/**
 * Cancel a project's in-flight summarization run. Requests Temporal cancellation of
 * the deterministic workflow handle (the workflow's cancellation scope flips the row
 * CANCELLED and leaves the prior COMPLETED summary intact), and — belt-and-suspenders
 * — directly flips a still-running row CANCELLED so a run whose worker already died
 * never stays stuck PENDING/GENERATING. Both are best-effort and idempotent. Returns
 * whether there was a run to cancel.
 */
export async function cancelContextSummarizationWorkflow(input: {
	projectId: string;
	userId: string | null;
	organizationId: string | null;
}): Promise<{ cancelled: boolean }> {
	const inProgress = await getInProgressContextSummary({
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!inProgress) {
		return { cancelled: false };
	}

	const workflowId = `context-summarization-${input.projectId}`;
	const client = await getTemporalClient();
	try {
		await client.workflow.getHandle(workflowId).cancel();
	} catch {
		// Handle already closed / not found — fall through to the DB flip so the row
		// never lingers in a running state.
	}
	await cancelContextSummary(inProgress.id);
	return { cancelled: true };
}
