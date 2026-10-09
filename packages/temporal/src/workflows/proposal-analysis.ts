/**
 * Internal Analysis of a coordinated Proposal (Fizzy #2801).
 *
 * Started by the document generation child workflow once Main is saved, with
 * `ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON` and the run row's key as
 * its id, so it outlives the generation and a retried start finds the same
 * run. Its input is ids only: the analyzed content and the bounded source
 * material are on the run row.
 *
 * One bounded activity does the review. When it gives up — retries
 * exhausted, a non-retryable verdict, or out of time — this workflow records
 * the run FAILED with an error code itself, so a run never stays PENDING or
 * RUNNING behind a workflow that ended. The Main document is never touched.
 */

import {
	ApplicationFailure,
	log,
	proxyActivities,
	TimeoutFailure,
} from "@temporalio/workflow";
import type * as activities from "../activities";
import {
	PROPOSAL_ANALYSIS_ERROR_CODES,
	type ProposalAnalysisErrorCode,
	type ProposalAnalysisWorkflowInput,
} from "../lib/proposal-artifact/types";
import { PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE } from "../task-queues";
import { AI_NON_RETRYABLE_ERROR_TYPES } from "./ai-non-retryable-errors";

const { runProposalAnalysis } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "10 minutes",
	heartbeatTimeout: "1 minute",
	retry: {
		initialInterval: "5s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
		nonRetryableErrorTypes: [
			...AI_NON_RETRYABLE_ERROR_TYPES,
			"AI_PROVIDER_NOT_CONFIGURED",
			"PROMPT_RENDER_FAILED",
			"MODEL_ERROR",
		],
	},
});

// The FAILED write is the only thing that moves a given-up run off PENDING or
// RUNNING, so it gets its own, longer retry window (about four minutes)
// instead of failing with the review.
const { failProposalAnalysisRun } = proxyActivities<typeof activities>({
	taskQueue: PROJECT_DOCUMENT_GENERATION_ACTIVITY_TASK_QUEUE,
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 8,
	},
});

export interface ProposalAnalysisWorkflowResult {
	status: "COMPLETE" | "SUPERSEDED" | "FAILED";
	findingCount: number;
	errorCode?: ProposalAnalysisErrorCode;
}

export async function proposalAnalysisWorkflow(
	input: ProposalAnalysisWorkflowInput,
): Promise<ProposalAnalysisWorkflowResult> {
	try {
		const result = await runProposalAnalysis(input);
		return {
			status: result.outcome === "completed" ? "COMPLETE" : "SUPERSEDED",
			findingCount: result.findingCount,
		};
	} catch (error) {
		const errorCode = proposalAnalysisErrorCode(error);
		log.warn("Proposal analysis gave up; recording the run as failed", {
			runId: input.runId,
			documentId: input.documentId,
			errorCode,
		});
		try {
			await failProposalAnalysisRun({
				runId: input.runId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				documentId: input.documentId,
				userId: input.userId,
				errorCode,
			});
		} catch {
			// Out of retries too. The page reads a run with no update for
			// twenty minutes as timed out, so it does not wait forever.
			log.error("Could not record the proposal analysis failure", {
				runId: input.runId,
				documentId: input.documentId,
				errorCode,
			});
		}
		return { status: "FAILED", findingCount: 0, errorCode };
	}
}

const KNOWN_CODES = new Set<string>(PROPOSAL_ANALYSIS_ERROR_CODES);

/**
 * The stored code for a failed review, read down the failure's cause chain:
 * a failure typed with one of the analysis codes keeps it, a missing provider
 * is `AI_PROVIDER_NOT_CONFIGURED`, a timeout `TIMED_OUT`, anything else
 * `MODEL_ERROR`.
 */
function proposalAnalysisErrorCode(error: unknown): ProposalAnalysisErrorCode {
	let current: unknown = error;
	for (let depth = 0; current != null && depth < 8; depth += 1) {
		if (current instanceof TimeoutFailure) {
			return "TIMED_OUT";
		}
		if (current instanceof ApplicationFailure && current.type) {
			if (KNOWN_CODES.has(current.type)) {
				return current.type as ProposalAnalysisErrorCode;
			}
			if (current.type === "AIProviderNotConfiguredError") {
				return "AI_PROVIDER_NOT_CONFIGURED";
			}
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "MODEL_ERROR";
}
