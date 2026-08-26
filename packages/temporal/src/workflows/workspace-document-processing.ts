/**
 * WorkspaceDocumentProcessingWorkflow
 *
 * Durable workflow for processing uploaded workspace documents with RAG pipeline:
 * Download → Extract → Chunk → Embed → Store
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Long-running operation support (10-minute timeout for extraction)
 * - Complete execution history for debugging
 * - Multi-tenancy support with user/organization isolation
 * - Workspace-level RAG settings
 */

import {
	ActivityFailure,
	ApplicationFailure,
	log,
	proxyActivities,
} from "@temporalio/workflow";
import type * as activities from "../activities";

// Configure activity retry policies
const { updateWorkspaceDocumentStatus } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { processWorkspaceDocument, reprocessWorkspaceDocument } =
	proxyActivities<typeof activities>({
		startToCloseTimeout: "15m", // Long timeout for entire pipeline
		heartbeatTimeout: "30 seconds",
		retry: {
			initialInterval: "2s",
			maximumInterval: "60s",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	});

const { deleteWorkspaceDocumentFromQdrant } = proxyActivities<
	typeof activities
>({
	startToCloseTimeout: "2m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "1s",
		maximumInterval: "30s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

// ============================================================================
// Types
// ============================================================================

export interface WorkspaceDocumentProcessingInput {
	documentId: string;
	workspaceId: string;
	userId: string;
	organizationId?: string;
	extractionStrategy?: string;
	isRetry?: boolean;
}

export interface WorkspaceDocumentProcessingOutput {
	success: boolean;
	documentId: string;
	chunkCount?: number;
	extractorUsed?: string;
	qdrantPointIds?: string[];
	error?: string;
}

type WorkspaceDocumentActivityResult = Awaited<
	ReturnType<typeof processWorkspaceDocument>
>;

// ============================================================================
// Workflow
// ============================================================================

/**
 * WorkspaceDocumentProcessingWorkflow
 *
 * Processes an uploaded workspace document through the RAG pipeline:
 * 1. Download from S3
 * 2. Extract text using pluggable extractors
 * 3. Chunk text based on workspace RAG settings
 * 4. Generate embeddings (in batches)
 * 5. Store chunks in PostgreSQL and Qdrant
 *
 * @param input - Workflow input containing document and workspace details
 * @returns Workflow output with success status and metadata
 */
export async function workspaceDocumentProcessingWorkflow(
	input: WorkspaceDocumentProcessingInput,
): Promise<WorkspaceDocumentProcessingOutput> {
	const {
		documentId,
		workspaceId,
		userId,
		organizationId,
		extractionStrategy = "local-only",
		isRetry = false,
	} = input;

	log.info("Starting workspace document processing workflow", {
		documentId,
		workspaceId,
		userId,
		organizationId,
		extractionStrategy,
		isRetry,
	});

	try {
		// Step 1: Update status to EXTRACTING
		log.info("Updating document status to EXTRACTING");
		await updateWorkspaceDocumentStatus(documentId, "EXTRACTING");

		// Step 2-6: Download, extract, chunk, embed, and store
		log.info(
			"Processing document (download, extract, chunk, embed, store)",
		);

		const result: WorkspaceDocumentActivityResult = isRetry
			? await reprocessWorkspaceDocument(
					documentId,
					workspaceId,
					userId,
					organizationId,
					extractionStrategy,
				)
			: await processWorkspaceDocument(
					documentId,
					workspaceId,
					userId,
					organizationId,
					extractionStrategy,
				);

		log.info("Document processed and chunks stored successfully", {
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantPointCount: result.qdrantPointIds.length,
		});

		// Step 7: Update status to READY
		log.info("Updating document status to READY");
		await updateWorkspaceDocumentStatus(documentId, "READY", undefined, {
			extractorUsed: result.extractorUsed,
			pageCount: result.pageCount,
			wordCount: result.wordCount,
			chunkCount: result.chunkCount,
			qdrantPointIds: result.qdrantPointIds,
		});

		log.info(
			"Workspace document processing workflow completed successfully",
		);

		return {
			success: true,
			documentId,
			chunkCount: result.chunkCount,
			extractorUsed: result.extractorUsed,
			qdrantPointIds: result.qdrantPointIds,
		};
	} catch (error) {
		const errorMessage = extractActivityError(error);

		log.error("Workspace document processing workflow failed", {
			error: errorMessage,
		});

		// Update status to FAILED (best effort)
		try {
			await updateWorkspaceDocumentStatus(
				documentId,
				"FAILED",
				errorMessage,
			);
		} catch {
			log.warn("Failed to update document status to FAILED", {
				documentId,
			});
		}

		// Propagate the error so Temporal marks the workflow as FAILED
		// This gives visibility in Temporal UI and enables alerting
		if (
			error instanceof ActivityFailure ||
			error instanceof ApplicationFailure
		) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_PROCESSING_FAILED",
		);
	}
}

/**
 * WorkspaceDocumentDeletionWorkflow
 *
 * Cleans up document data from Qdrant when a document is deleted.
 * PostgreSQL cleanup happens via cascade delete.
 *
 * @param input - Document and workspace IDs
 */
export async function workspaceDocumentDeletionWorkflow(input: {
	documentId: string;
	workspaceId: string;
}): Promise<{ success: boolean; error?: string }> {
	const { documentId, workspaceId } = input;

	log.info("Starting workspace document deletion workflow", {
		documentId,
		workspaceId,
	});

	try {
		await deleteWorkspaceDocumentFromQdrant(documentId, workspaceId);

		log.info("Workspace document deletion workflow completed");

		return { success: true };
	} catch (error) {
		const errorMessage = extractActivityError(error);

		log.error("Workspace document deletion workflow failed", {
			error: errorMessage,
		});

		if (
			error instanceof ActivityFailure ||
			error instanceof ApplicationFailure
		) {
			throw error;
		}
		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_DELETION_FAILED",
		);
	}
}

/**
 * Extract the actual error message from Temporal's wrapped errors.
 * Temporal wraps activity failures in ActivityFailure -> ApplicationFailure -> actual error.
 */
function extractActivityError(error: unknown): string {
	if (!error) {
		return "Unknown error";
	}
	if (error instanceof ActivityFailure && error.cause) {
		return extractActivityError(error.cause);
	}
	if (error instanceof ApplicationFailure) {
		if (error.cause) {
			const causeMsg = extractActivityError(error.cause);
			if (causeMsg && causeMsg !== "Unknown error") {
				return causeMsg;
			}
		}
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
