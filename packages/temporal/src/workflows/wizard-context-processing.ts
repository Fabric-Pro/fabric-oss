/**
 * WizardContextProcessingWorkflow
 *
 * Durable workflow for processing uploaded wizard temp contexts:
 * Download → Extract → Chunk → Embed → Store
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Long-running operation support (10-minute timeout)
 * - Complete execution history for debugging
 * - Multi-tenancy support with user/organization isolation
 *
 * Similar pattern to workspaceDocumentProcessingWorkflow for consistency.
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

// Configure activity retry policies
const { updateWizardContextStatus } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { processWizardTempContext, retryWizardTempContext } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "10m", // Long timeout for entire pipeline
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// ============================================================================
// Types
// ============================================================================

export interface WizardContextProcessingInput {
	contextId: string;
	sessionId: string;
	userId: string;
	organizationId?: string;
	extractionStrategy?: string;
	isRetry?: boolean;
}

export interface WizardContextProcessingOutput {
	success: boolean;
	contextId: string;
	chunkCount?: number;
	extractorUsed?: string;
	qdrantIds?: string[];
	error?: string;
}

type WizardContextProcessingResult = Awaited<
	ReturnType<typeof processWizardTempContext>
>;

// ============================================================================
// Workflow
// ============================================================================

/**
 * WizardContextProcessingWorkflow
 *
 * Processes an uploaded wizard temp context through the RAG pipeline:
 * 1. Download from S3
 * 2. Extract text using pluggable extractors
 * 3. Chunk text (2048 char chunks, 200 overlap)
 * 4. Generate embeddings
 * 5. Store in Qdrant with session-based isolation
 *
 * @param input - Workflow input containing context and session details
 * @returns Workflow output with success status and metadata
 */
export async function wizardContextProcessingWorkflow(
	input: WizardContextProcessingInput,
): Promise<WizardContextProcessingOutput> {
	const {
		contextId,
		sessionId,
		userId,
		organizationId,
		extractionStrategy = "local-only",
		isRetry = false,
	} = input;

	log.info("Starting wizard context processing workflow", {
		contextId,
		sessionId,
		userId,
		organizationId,
		extractionStrategy,
		isRetry,
	});

	try {
		// Run the combined processing activity
		const result: WizardContextProcessingResult = isRetry
			? await retryWizardTempContext(
					contextId,
					sessionId,
					userId,
					organizationId,
					extractionStrategy,
				)
			: await processWizardTempContext(
					contextId,
					sessionId,
					userId,
					organizationId,
					extractionStrategy,
				);

		if (!result.success) {
			log.error("Wizard context processing failed", {
				error: result.error,
			});

			// Update status to FAILED so UI reflects the failure
			try {
				await updateWizardContextStatus(
					contextId,
					"FAILED",
					result.error,
				);
			} catch {
				// Ignore errors when updating status
			}

			throw ApplicationFailure.nonRetryable(
				result.error || "Wizard context processing failed",
				"WIZARD_CONTEXT_PROCESSING_FAILED",
			);
		}

		log.info("Wizard context processing workflow completed successfully", {
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantPointCount: result.qdrantIds.length,
		});

		return {
			success: true,
			contextId,
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantIds: result.qdrantIds,
		};
	} catch (error) {
		// Rethrow ApplicationFailure as-is to preserve original type/details
		if (error instanceof ApplicationFailure) {
			throw error;
		}

		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Wizard context processing workflow failed", {
			error: errorMessage,
		});

		// Try to update status to FAILED (best effort)
		try {
			await updateWizardContextStatus(contextId, "FAILED", errorMessage);
		} catch {
			// Ignore errors when updating status
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"WIZARD_CONTEXT_PROCESSING_FAILED",
		);
	}
}
