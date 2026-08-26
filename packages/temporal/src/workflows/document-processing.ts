/**
 * DocumentProcessingWorkflow
 *
 * Durable workflow for processing uploaded documents with RAG pipeline:
 * Download → Extract → Chunk → Embed → Store
 *
 * Features:
 * - Automatic retry on transient failures
 * - Exponential backoff
 * - Long-running operation support (5-minute timeout for extraction)
 * - Complete execution history for debugging
 * - Multi-tenancy support
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";
import type {
	DocumentProcessingInput,
	DocumentProcessingOutput,
} from "../types";

// Configure activity retry policies
const { updateDocumentStatus } = proxyActivities<typeof activities>({
	startToCloseTimeout: "30s", // Short timeout for quick operations
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 5,
	},
});

const { processAndStoreChunks } = proxyActivities<typeof activities>({
	startToCloseTimeout: "10m", // Long timeout for entire pipeline (download, extract, chunk, embed, store)
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "2s",
		maximumInterval: "60s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

/**
 * DocumentProcessingWorkflow
 *
 * Processes an uploaded document through the RAG pipeline.
 * All steps are combined into a single activity to avoid transferring
 * large buffers/arrays through Temporal's gRPC (4MB message limit):
 * 1. Download from S3
 * 2. Extract text using pluggable extractors
 * 3. Chunk text
 * 4. Generate embeddings (in batches)
 * 5. Store chunks in PostgreSQL and Qdrant
 *
 * @param input - Workflow input containing documentId, chatId, userId, organizationId
 * @returns Workflow output with success status and metadata
 */
export async function documentProcessingWorkflow(
	input: DocumentProcessingInput,
): Promise<DocumentProcessingOutput> {
	const { documentId, chatId, userId, organizationId, extractionStrategy } =
		input;

	console.log(
		"[Workflow] ========== DOCUMENT PROCESSING WORKFLOW STARTED ==========",
	);
	console.log("[Workflow] Input received:", JSON.stringify(input, null, 2));
	console.log("[Workflow] documentId:", documentId);
	console.log("[Workflow] chatId:", chatId);
	console.log("[Workflow] userId:", userId);
	console.log("[Workflow] organizationId:", organizationId);
	console.log("[Workflow] extractionStrategy:", extractionStrategy);

	log.info("Starting document processing workflow", {
		documentId,
		chatId,
		userId,
		organizationId,
		extractionStrategy,
	});

	try {
		// Step 1: Update status to PROCESSING
		log.info("Updating document status to PROCESSING");
		await updateDocumentStatus(documentId, "PROCESSING", "RUNNING");

		// Step 2-6: Download, extract, chunk, embed, and store
		// All combined in a single activity to avoid transferring large buffers/arrays through Temporal's gRPC
		log.info(
			"Processing document (download, extract, chunk, embed, store)",
		);
		console.log("[Workflow] About to process document end-to-end");
		console.log("[Workflow] Storing with chatId:", chatId);
		console.log("[Workflow] Storing with userId:", userId);
		console.log("[Workflow] Storing with organizationId:", organizationId);

		const { chunkCount, extractorUsed, extractionTime, cost } =
			await processAndStoreChunks(
				documentId,
				chatId,
				userId,
				organizationId,
				extractionStrategy || "local-only",
			);
		log.info("Document processed and chunks stored successfully", {
			chunkCount,
			extractorUsed,
			extractionTime,
			cost,
		});

		// Step 7: Update status to READY
		log.info("Updating document status to READY");
		await updateDocumentStatus(documentId, "READY", "COMPLETED", {
			extractorUsed,
			extractionTime,
			cost,
		});

		log.info("Document processing workflow completed successfully");

		return {
			success: true,
			documentId,
			chunkCount,
			extractorUsed,
		};
	} catch (error) {
		// Workflow failed after all retries
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";

		log.error("Document processing workflow failed", {
			error: errorMessage,
		});

		// Try to update workflow status to FAILED (best effort)
		try {
			await updateDocumentStatus(
				documentId,
				"FAILED",
				"FAILED",
				undefined,
				errorMessage,
			);
		} catch {
			// Ignore errors when updating status
		}

		throw ApplicationFailure.nonRetryable(
			errorMessage,
			"DOCUMENT_PROCESSING_FAILED",
		);
	}
}
