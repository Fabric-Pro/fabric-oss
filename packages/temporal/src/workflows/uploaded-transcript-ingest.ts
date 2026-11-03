/**
 * Fire-and-forget workflow that turns one uploaded transcript file into a
 * transcript (Fizzy #1877). Started by `projects.meetingTranscriptSync
 * .startUploadIngest` once the browser has put the file in storage.
 *
 * A file the user has to fix is handled inside the activity and returns
 * normally, so a throw here means our own side failed and the attempts ran out.
 * The row is then marked failed, or it would stay "processing" with nothing to
 * say it had stopped.
 *
 * Starting the pipelines is outside that `try`, as a step of its own. The
 * transcript is stored by then, so a failure there must not mark it failed, and
 * a crash just before it retries the step rather than skipping it.
 *
 * IMPORTANT: This file runs in Temporal's sandboxed V8 isolate. It may only
 * import from `@temporalio/workflow` and TYPE-ONLY from activity modules.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import { PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

const {
	ingestUploadedTranscript,
	markUploadedTranscriptFailed,
	startUploadedTranscriptPipelines,
} = proxyActivities<typeof activities>({
	taskQueue: PROJECT_OPERATIONS_ACTIVITY_TASK_QUEUE,
	// The same headroom as a Teams transcript: a long one is summarized here.
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "2 minutes",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumInterval: "1m",
		maximumAttempts: 3,
		nonRetryableErrorTypes: [
			"ValidationError",
			"TenantViolation",
			...AI_NON_RETRYABLE_ERROR_TYPES,
		],
	},
});

export interface UploadedTranscriptIngestWorkflowInput {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
}

export async function uploadedTranscriptIngestWorkflow(
	input: UploadedTranscriptIngestWorkflowInput,
): Promise<void> {
	let transcriptRecordId: string | undefined;
	try {
		const result = await ingestUploadedTranscript(input);
		if (result.outcome === "ingested") {
			transcriptRecordId = result.transcriptRecordId;
		}
	} catch (error) {
		await markUploadedTranscriptFailed({ contextId: input.contextId });
		throw error;
	}

	if (transcriptRecordId) {
		await startUploadedTranscriptPipelines({
			...input,
			transcriptRecordId,
		});
	}
}
