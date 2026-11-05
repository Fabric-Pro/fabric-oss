import {
	ActivityCancellationType,
	CancellationScope,
	isCancellation,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	ContextQualityEvaluationWorkflowInput,
	ContextQualityEvaluationWorkflowOutput,
} from "../lib/context-quality-types";
import { CONTEXT_QUALITY_TASK_QUEUE } from "../task-queues";

const { executeSavedContextQualityEvaluation } = proxyActivities<
	typeof activities
>({
	taskQueue: CONTEXT_QUALITY_TASK_QUEUE,
	startToCloseTimeout: "20 minutes",
	scheduleToCloseTimeout: "45 minutes",
	heartbeatTimeout: "60 seconds",
	cancellationType: ActivityCancellationType.WAIT_CANCELLATION_COMPLETED,
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		maximumInterval: "30s",
	},
});
const { settleCancelledContextQualityEvaluation } = proxyActivities<
	typeof activities
>({
	taskQueue: CONTEXT_QUALITY_TASK_QUEUE,
	startToCloseTimeout: "2 minutes",
	scheduleToCloseTimeout: "5 minutes",
	retry: {
		maximumAttempts: 3,
		initialInterval: "2s",
		maximumInterval: "30s",
	},
});

export async function contextQualityEvaluationWorkflow(
	input: ContextQualityEvaluationWorkflowInput,
): Promise<ContextQualityEvaluationWorkflowOutput> {
	try {
		return await executeSavedContextQualityEvaluation(input);
	} catch (error) {
		if (!isCancellation(error)) {
			throw error;
		}
		await CancellationScope.nonCancellable(() =>
			settleCancelledContextQualityEvaluation(input),
		);
		throw error;
	}
}

export type {
	ContextQualityEvaluationWorkflowInput,
	ContextQualityEvaluationWorkflowOutput,
};
