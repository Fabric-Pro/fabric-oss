/**
 * Chunking analysis (spec 2026-10-28 §8b "Measure", §8c): started once the
 * person confirmed the bounded cost of a prepared run. Builds a question set
 * from a sample of each content type, scores the candidate settings, and
 * keeps the scores and the proposal on the run. Never changes the project:
 * applying a TUNE proposal is a separate, approved step.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_EMBEDDING_TASK_QUEUE } from "../task-queues";

export interface ProjectChunkingAnalysisWorkflowInput {
	runId: string;
	projectId: string;
	organizationId: string;
	userId: string;
}

const {
	buildChunkingQuestionsActivity,
	evaluateChunkingTypeActivity,
	finishChunkingAnalysisActivity,
	listMeasurableChunkingTypesActivity,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_EMBEDDING_TASK_QUEUE,
	startToCloseTimeout: "20 minutes",
	heartbeatTimeout: "3 minutes",
	retry: {
		initialInterval: "5s",
		maximumInterval: "1 minute",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export async function projectChunkingAnalysisWorkflow(
	input: ProjectChunkingAnalysisWorkflowInput,
): Promise<{ status: "COMPLETED" | "FAILED"; types: number }> {
	const evaluations: Array<
		Awaited<ReturnType<typeof evaluateChunkingTypeActivity>>
	> = [];
	try {
		const { questions } = await buildChunkingQuestionsActivity(input);
		if (questions > 0) {
			const { types } = await listMeasurableChunkingTypesActivity(input);
			for (const contentType of types) {
				evaluations.push(
					await evaluateChunkingTypeActivity({
						...input,
						contentType,
					}),
				);
			}
		}
		await finishChunkingAnalysisActivity({ ...input, evaluations });
		return { status: "COMPLETED", types: evaluations.length };
	} catch (error) {
		await finishChunkingAnalysisActivity({
			...input,
			evaluations,
			error: error instanceof Error ? error.message : String(error),
		});
		return { status: "FAILED", types: evaluations.length };
	}
}
