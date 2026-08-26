/**
 * Temporal workflow for embedding wizard temp contexts
 *
 * This workflow orchestrates the chunking, embedding, and storage of
 * wizard temp contexts in Qdrant for RAG retrieval during the
 * project creation wizard flow.
 *
 * The workflow:
 * 1. Fetches wizard temp contexts that need embedding
 * 2. Chunks large content into smaller pieces
 * 3. Generates embeddings using the user's AI provider
 * 4. Stores embeddings in Qdrant with session-based isolation
 * 5. Updates database with embedding status
 */

import { ApplicationFailure, log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	getWizardTempContextsForEmbedding,
	chunkWizardContextContent,
	generateWizardContextEmbeddings,
	storeWizardContextsInQdrant,
	updateWizardContextEmbeddingStatus,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "5m",
	heartbeatTimeout: "30 seconds",
	retry: {
		initialInterval: "5s",
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
});

export interface WizardContextEmbeddingInput {
	/** Wizard session ID */
	sessionId: string;
	/** IDs of WizardTempContext records to embed */
	contextIds: string[];
	/** User ID for API key lookup */
	userId: string;
	/** Organization ID (null for personal) */
	organizationId?: string;
	/** Optional: chunk size in characters (default: 2048) */
	chunkSize?: number;
	/** Optional: chunk overlap in characters (default: 200) */
	chunkOverlap?: number;
}

export interface WizardContextEmbeddingOutput {
	success: boolean;
	/** Number of contexts that were embedded */
	embeddedCount: number;
	/** Total number of chunks created */
	chunkedCount: number;
	/** Any errors that occurred */
	errors: string[];
}

/**
 * Workflow for embedding wizard temp contexts
 *
 * This workflow is triggered after document extraction completes
 * to make the content available for semantic search during the wizard.
 */
export async function wizardContextEmbeddingWorkflow(
	input: WizardContextEmbeddingInput,
): Promise<WizardContextEmbeddingOutput> {
	const errors: string[] = [];

	log.info("Starting wizard context embedding workflow", {
		sessionId: input.sessionId,
		contextCount: input.contextIds.length,
	});

	try {
		// Step 1: Fetch contexts that need embedding
		const contexts = await getWizardTempContextsForEmbedding({
			contextIds: input.contextIds,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		if (contexts.length === 0) {
			log.info("No contexts found for embedding");
			return {
				success: true,
				embeddedCount: 0,
				chunkedCount: 0,
				errors: [],
			};
		}

		log.info(`Found ${contexts.length} contexts to embed`);

		// Step 2: Chunk the content
		const chunkedContexts = await chunkWizardContextContent({
			contexts,
			chunkSize: input.chunkSize,
			chunkOverlap: input.chunkOverlap,
		});

		const totalChunks = chunkedContexts.reduce(
			(sum, c) => sum + c.chunks.length,
			0,
		);
		log.info(`Chunked into ${totalChunks} chunks`);

		// Step 3: Generate embeddings
		const embeddings = await generateWizardContextEmbeddings({
			chunks: chunkedContexts,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		log.info(`Generated embeddings for ${embeddings.size} contexts`);

		// Step 4: Store in Qdrant
		const qdrantIds = await storeWizardContextsInQdrant({
			sessionId: input.sessionId,
			userId: input.userId,
			organizationId: input.organizationId,
			chunks: chunkedContexts,
			embeddings,
		});

		log.info("Stored embeddings in Qdrant");

		// Step 5: Update database
		await updateWizardContextEmbeddingStatus({
			contextIds: input.contextIds,
			qdrantIds,
		});

		log.info("Wizard context embedding workflow completed successfully", {
			embeddedCount: qdrantIds.size,
			chunkedCount: totalChunks,
		});

		return {
			success: true,
			embeddedCount: qdrantIds.size,
			chunkedCount: totalChunks,
			errors,
		};
	} catch (error) {
		if (error instanceof ApplicationFailure) {
			throw error;
		}
		const errorMsg = `Workflow failed: ${error instanceof Error ? error.message : "Unknown error"}`;
		log.error(errorMsg);
		errors.push(errorMsg);

		throw ApplicationFailure.nonRetryable(
			errorMsg,
			"WIZARD_CONTEXT_EMBEDDING_FAILED",
		);
	}
}
