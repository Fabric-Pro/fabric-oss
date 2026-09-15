/**
 * Discovery Run Workflow (plan Slice 4)
 *
 * Runs on the `project-documents` task queue with a deterministic id
 * (`discovery-run-${discoveryRunId}`) so a retried start never launches a
 * second execution for the same run row.
 *
 *   1. setDiscoveryRunStatus(RUNNING)
 *   2. gatherDiscoveryEvidence   — repo / OpenAPI / MCP evidence
 *   3. draftIntegrationContract  — structured output (untrusted block)
 *   4. persistIntegrationContract— INTEGRATION_CONTRACT doc, CONTRACT_READY
 *   5. postDiscoveryQuestions    — one comment per unknown, stage advance
 *
 * Any failure marks the run FAILED with the error, except after step 4: the
 * contract already exists, so the run stays CONTRACT_READY and only records
 * the error. A cancel signal marks the run CANCELLED between steps.
 */

import {
	ApplicationFailure,
	defineQuery,
	defineSignal,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type {
	DiscoverySources,
	draftIntegrationContract as DraftIntegrationContractFn,
	gatherDiscoveryEvidence as GatherDiscoveryEvidenceFn,
	persistIntegrationContract as PersistIntegrationContractFn,
	postDiscoveryQuestions as PostDiscoveryQuestionsFn,
	setDiscoveryRunStatus as SetDiscoveryRunStatusFn,
} from "../activities/discovery";

// =============================================================================
// Types
// =============================================================================

export interface DiscoveryRunWorkflowInput {
	discoveryRunId: string;
	projectId: string;
	storyId: string;
	userId: string;
	organizationId?: string;
	sources: DiscoverySources;
	/** Display context for the drafting prompt. */
	story: { identifier: string; title: string };
	project: {
		name: string;
		description?: string | null;
		techStack?: string[];
	};
}

export type DiscoveryRunStatusValue =
	| "gathering"
	| "drafting"
	| "persisting"
	| "posting_questions"
	| "contract_ready"
	| "cancelled"
	| "failed";

export interface DiscoveryRunProgress {
	status: DiscoveryRunStatusValue;
	message: string;
	discoveryRunId: string;
	documentId?: string;
	questionCount?: number;
	warnings?: string[];
	error?: string;
}

export interface DiscoveryRunWorkflowOutput {
	documentId: string;
	questionCount: number;
	stageAdvanced: boolean;
	pendingStageRequestId?: string;
}

// =============================================================================
// Signals & Queries
// =============================================================================

export const cancelDiscoverySignal = defineSignal("cancelDiscovery");
export const discoveryProgressQuery =
	defineQuery<DiscoveryRunProgress>("discoveryProgress");

// =============================================================================
// Activity proxies
// =============================================================================

const { gatherDiscoveryEvidence } = proxyActivities<{
	gatherDiscoveryEvidence: typeof GatherDiscoveryEvidenceFn;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { draftIntegrationContract } = proxyActivities<{
	draftIntegrationContract: typeof DraftIntegrationContractFn;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "90 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

const { persistIntegrationContract, postDiscoveryQuestions } = proxyActivities<{
	persistIntegrationContract: typeof PersistIntegrationContractFn;
	postDiscoveryQuestions: typeof PostDiscoveryQuestionsFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { setDiscoveryRunStatus } = proxyActivities<{
	setDiscoveryRunStatus: typeof SetDiscoveryRunStatusFn;
}>({
	startToCloseTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

// =============================================================================
// Workflow
// =============================================================================

export async function discoveryRunWorkflow(
	input: DiscoveryRunWorkflowInput,
): Promise<DiscoveryRunWorkflowOutput> {
	const { discoveryRunId, projectId, storyId, userId, organizationId } =
		input;

	let cancelled = false;
	let contractReady = false;
	const progress: DiscoveryRunProgress = {
		status: "gathering",
		message: "Collecting evidence...",
		discoveryRunId,
	};

	setHandler(cancelDiscoverySignal, () => {
		log.info("Discovery cancel signal received", { discoveryRunId });
		cancelled = true;
	});
	setHandler(discoveryProgressQuery, () => progress);

	const assertNotCancelled = () => {
		if (cancelled) {
			progress.status = "cancelled";
			progress.message = "Discovery run cancelled by user";
			throw ApplicationFailure.nonRetryable(
				"Discovery run cancelled by user",
				"DISCOVERY_CANCELLED",
			);
		}
	};

	try {
		log.info("Starting discovery run", {
			discoveryRunId,
			projectId,
			storyId,
		});
		await setDiscoveryRunStatus({ discoveryRunId, status: "RUNNING" });
		assertNotCancelled();

		const evidence = await gatherDiscoveryEvidence({
			discoveryRunId,
			projectId,
			storyId,
			userId,
			organizationId,
			sources: input.sources,
		});
		progress.warnings = evidence.warnings;
		assertNotCancelled();

		progress.status = "drafting";
		progress.message = "Drafting the integration contract...";
		const draft = await draftIntegrationContract({
			evidence,
			story: { id: storyId, ...input.story },
			project: input.project,
			userId,
			organizationId,
		});
		assertNotCancelled();

		progress.status = "persisting";
		progress.message = "Saving the contract for review...";
		const persisted = await persistIntegrationContract({
			discoveryRunId,
			projectId,
			storyId,
			userId,
			organizationId,
			markdown: draft.markdown,
			contract: draft.contract,
		});
		contractReady = true;
		progress.documentId = persisted.documentId;
		// A cancel signal that arrived during persistence must stop here: the
		// activity itself also refuses to post for a non-CONTRACT_READY run.
		assertNotCancelled();

		progress.status = "posting_questions";
		progress.message = "Posting open questions...";
		const questions = await postDiscoveryQuestions({
			discoveryRunId,
			storyId,
			projectId,
			userId,
			organizationId,
			unknowns: draft.contract.unknowns,
		});

		progress.status = "contract_ready";
		progress.questionCount = draft.contract.unknowns.length;
		progress.message = `Contract ready for review with ${draft.contract.unknowns.length} open question(s).`;

		log.info("Discovery run produced a contract", {
			discoveryRunId,
			documentId: persisted.documentId,
			questionCount: draft.contract.unknowns.length,
			stageAdvanced: questions.stageAdvanced,
		});

		return {
			documentId: persisted.documentId,
			questionCount: draft.contract.unknowns.length,
			stageAdvanced: questions.stageAdvanced,
			pendingStageRequestId: questions.pendingStageRequestId,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		progress.error = message;

		if (progress.status === "cancelled") {
			await setDiscoveryRunStatus({
				discoveryRunId,
				status: "CANCELLED",
				error: message,
			});
		} else if (contractReady) {
			// The document exists; keep the run usable and record the error.
			progress.status = "contract_ready";
			progress.message = `Contract saved, but a later step failed: ${message}`;
			await setDiscoveryRunStatus({
				discoveryRunId,
				status: "CONTRACT_READY",
				error: message,
			});
		} else {
			progress.status = "failed";
			progress.message = message;
			await setDiscoveryRunStatus({
				discoveryRunId,
				status: "FAILED",
				error: message,
			});
		}

		log.error("Discovery run failed", { discoveryRunId, error: message });
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(message, "DISCOVERY_RUN_FAILED");
	}
}
