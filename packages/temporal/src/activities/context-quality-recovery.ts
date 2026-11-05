import { db } from "@repo/database";
import {
	findContextQualityRunsForRecovery,
	getContextQualityRunForWorker,
	purgeContextQualityRunSnapshot,
} from "@repo/database/prisma/queries/projects/context-quality-runs";
import { getTemporalClient } from "../client";
import { CONTEXT_QUALITY_TASK_QUEUE } from "../task-queues";

/** Worker-policy scan only; never returns payloads or creates a new admission identity. */
export async function recoverContextQualityEvaluations(): Promise<{
	visited: number;
	started: number;
	purged: number;
}> {
	const rows = await findContextQualityRunsForRecovery({
		before: new Date(Date.now() - 60_000),
		limit: 50,
	});
	const result = { visited: rows.length, started: 0, purged: 0 };
	const client = await getTemporalClient();
	for (const row of rows) {
		const scope = {
			organizationId: row.organizationId,
			projectId: row.projectId,
			runId: row.id,
		};
		// Advance scan fairness even when this exact remote receipt remains blocked.
		await db.projectContextQualityRun.updateMany({
			where: {
				id: row.id,
				organizationId: row.organizationId,
				projectId: row.projectId,
			},
			data: { updatedAt: new Date() },
		});
		result.purged += await purgeContextQualityRunSnapshot(scope);
		const run = await getContextQualityRunForWorker(scope);
		if (!run) continue;
		if (
			["SUCCEEDED", "FAILED", "CANCELLED"].includes(run.status) &&
			["NOT_REQUIRED", "CONFIRMED"].includes(run.cleanupStatus)
		)
			continue;
		try {
			await client.workflow.start("contextQualityEvaluationWorkflow", {
				workflowId: run.workflowId,
				taskQueue: CONTEXT_QUALITY_TASK_QUEUE,
				workflowExecutionTimeout: "1 hour",
				args: [
					{
						evaluationRunId: run.id,
						organizationId: run.organizationId,
						projectId: run.projectId,
						requesterUserId: run.requestedBy,
					},
				],
			});
			result.started++;
		} catch (error) {
			if (
				!(
					error instanceof Error &&
					error.name === "WorkflowExecutionAlreadyStartedError"
				)
			)
				throw new Error(
					"Evaluation recovery could not start its existing workflow.",
				);
		}
	}
	return result;
}
