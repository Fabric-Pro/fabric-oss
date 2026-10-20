/**
 * Export a client-document Proposal to PDF or Word (Fizzy #2946).
 *
 * The procedure starts this on the export queue with ids only; the one
 * activity loads, renders, prints or writes, and uploads inside the worker,
 * so neither the document nor the file ever passes through workflow
 * history. The result is the upload's key; the status read signs a download
 * URL from it on each call.
 *
 * One activity rather than a chain: the stages hand each other the
 * document, rendered diagrams, the print page with its embedded fonts and
 * the finished file, any of which can exceed what a history event carries.
 *
 * Budget and access failures are final; anything else gets one more attempt.
 * The body does no I/O and reads no clock, so replay stays deterministic.
 */

import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities/proposal-export";
import {
	PROPOSAL_EXPORT_NON_RETRYABLE_CODES,
	type ProposalExportResult,
	type ProposalExportWorkflowInput,
} from "../lib/proposal-export/types";
import { PROPOSAL_EXPORT_TASK_QUEUE } from "../task-queues";

const { exportProposalDocumentActivity } = proxyActivities<typeof activities>({
	taskQueue: PROPOSAL_EXPORT_TASK_QUEUE,
	// The activity's own budget is 150 seconds; the rest is room for the
	// browser to close and the upload to finish.
	startToCloseTimeout: "4 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "5 seconds",
		maximumInterval: "30 seconds",
		backoffCoefficient: 2,
		maximumAttempts: 2,
		nonRetryableErrorTypes: [...PROPOSAL_EXPORT_NON_RETRYABLE_CODES],
	},
});

export async function proposalExportWorkflow(
	input: ProposalExportWorkflowInput,
): Promise<ProposalExportResult> {
	return await exportProposalDocumentActivity(input);
}
