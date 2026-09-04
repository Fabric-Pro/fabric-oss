/**
 * Temporal activities for embedding wizard temp contexts
 *
 * These activities handle the chunking, embedding, and storage of
 * wizard temp contexts in Qdrant for RAG retrieval during the
 * project creation wizard flow.
 */

import { getSystemRAGProviderConfig } from "@repo/ai";
import { db, updateWizardTempContextEmbedding } from "@repo/database";
import { logger } from "@repo/logs";
import {
	chunkProjectContent,
	generateEmbeddings,
	storeWizardContext,
	type TextChunk,
} from "@repo/rag";

// Chunking thresholds
const CHUNKING_THRESHOLD = 2048; // Characters - chunk if content is larger
const DEFAULT_CHUNK_SIZE = 2048;
const DEFAULT_CHUNK_OVERLAP = 200;

export interface WizardContextForEmbedding {
	id: string;
	sessionId: string;
	type: string;
	content: string;
	originalFilename: string;
	mimeType: string;
}

export interface ChunkedWizardContext {
	contextId: string;
	sessionId: string;
	type: string;
	filename: string;
	mimeType: string;
	chunks: TextChunk[];
}

/**
 * Get wizard temp contexts that need embedding
 */
export async function getWizardTempContextsForEmbedding(params: {
	contextIds: string[];
	userId: string;
	organizationId?: string;
}): Promise<WizardContextForEmbedding[]> {
	const { contextIds, userId, organizationId } = params;

	logger.info(
		`[WizardEmbedding] Fetching ${contextIds.length} contexts for embedding`,
	);

	const orgFilter = organizationId
		? { organizationId }
		: { organizationId: null };

	const contexts = await db.wizardTempContext.findMany({
		where: {
			id: { in: contextIds },
			userId,
			...orgFilter,
			extractionStatus: "COMPLETED",
			embeddedAt: null, // Only get un-embedded contexts
		},
		select: {
			id: true,
			sessionId: true,
			type: true,
			content: true,
			originalFilename: true,
			mimeType: true,
		},
	});

	logger.info(`[WizardEmbedding] Found ${contexts.length} contexts to embed`);

	return contexts;
}

/**
 * Chunk wizard context content if needed
 *
 * Small content (<2048 chars) is kept as a single chunk for efficiency.
 * Larger content is chunked using paragraph-based splitting.
 */
export async function chunkWizardContextContent(params: {
	contexts: WizardContextForEmbedding[];
	chunkSize?: number;
	chunkOverlap?: number;
}): Promise<ChunkedWizardContext[]> {
	const {
		contexts,
		chunkSize = DEFAULT_CHUNK_SIZE,
		chunkOverlap = DEFAULT_CHUNK_OVERLAP,
	} = params;

	logger.info(`[WizardEmbedding] Chunking ${contexts.length} contexts`);

	const chunkedContexts: ChunkedWizardContext[] = [];

	for (const context of contexts) {
		let chunks: TextChunk[];

		// The fourth ingestion path, and it had a fourth copy of the MIME strategy.
		// Found by the discovery guard rather than by hand, which is the point of
		// that guard: a spec re-embedded through the wizard would otherwise have
		// been shredded into character windows while every other path indexed it
		// by endpoint, with no error anywhere.
		const chunkResult = await chunkProjectContent({
			content: context.content,
			mimeType: context.mimeType,
			filename: context.originalFilename,
			chunkingThreshold: CHUNKING_THRESHOLD,
			chunkSize,
			chunkOverlap,
		});

		if (chunkResult.route.kind === "malformed-openapi") {
			logger.warn(
				`[WizardEmbedding] Context ${context.id} looks like an OpenAPI document but could not be read: ${chunkResult.route.reason}`,
			);
			continue;
		}

		chunks = chunkResult.chunks;
		logger.info(
			`[WizardEmbedding] Context ${context.id} split into ${chunks.length} chunks (route=${chunkResult.route.kind})`,
		);

		chunkedContexts.push({
			contextId: context.id,
			sessionId: context.sessionId,
			type: context.type,
			filename: context.originalFilename,
			mimeType: context.mimeType,
			chunks,
		});
	}

	const totalChunks = chunkedContexts.reduce(
		(sum, c) => sum + c.chunks.length,
		0,
	);
	logger.info(
		`[WizardEmbedding] Chunking complete: ${contexts.length} contexts → ${totalChunks} chunks`,
	);

	return chunkedContexts;
}

/**
 * Generate embeddings for chunked wizard contexts
 */
export async function generateWizardContextEmbeddings(params: {
	chunks: ChunkedWizardContext[];
	userId: string;
	organizationId?: string;
}): Promise<Map<string, number[][]>> {
	const { chunks, userId, organizationId } = params;

	logger.info(
		`[WizardEmbedding] Generating embeddings for ${chunks.length} contexts`,
	);

	// Get AI provider configuration using centralized function
	const providerConfig = await getSystemRAGProviderConfig({
		userId,
		organizationId,
	});

	// Flatten all chunks for batch embedding
	const allChunks: {
		contextId: string;
		chunkIndex: number;
		content: string;
	}[] = [];
	for (const context of chunks) {
		for (let i = 0; i < context.chunks.length; i++) {
			allChunks.push({
				contextId: context.contextId,
				chunkIndex: i,
				content: context.chunks[i].content,
			});
		}
	}

	if (allChunks.length === 0) {
		logger.warn("[WizardEmbedding] No chunks to embed");
		return new Map();
	}

	// Generate embeddings in batch
	const result = await generateEmbeddings(
		allChunks.map((c) => c.content),
		{ userId, organizationId },
		providerConfig,
	);

	// Group embeddings by contextId
	const embeddingsByContext = new Map<string, number[][]>();

	for (let i = 0; i < allChunks.length; i++) {
		const { contextId, chunkIndex } = allChunks[i];
		const embedding = result.embeddings[i];

		if (!embeddingsByContext.has(contextId)) {
			embeddingsByContext.set(contextId, []);
		}
		// Ensure order is preserved
		// biome-ignore lint/style/noNonNullAssertion: contextEmbeddings map is populated in the preceding loop
		const contextEmbeddings = embeddingsByContext.get(contextId)!;
		contextEmbeddings[chunkIndex] = embedding;
	}

	logger.info(
		`[WizardEmbedding] Generated ${result.embeddings.length} embeddings for ${embeddingsByContext.size} contexts`,
	);

	return embeddingsByContext;
}

/**
 * Store wizard context embeddings in Qdrant
 */
export async function storeWizardContextsInQdrant(params: {
	sessionId: string;
	userId: string;
	organizationId?: string;
	chunks: ChunkedWizardContext[];
	embeddings: Map<string, number[][]>;
}): Promise<Map<string, string[]>> {
	const { sessionId, userId, organizationId, chunks, embeddings } = params;

	logger.info(
		`[WizardEmbedding] Storing embeddings for session ${sessionId}`,
	);

	const qdrantIdsByContext = new Map<string, string[]>();

	for (const context of chunks) {
		const contextEmbeddings = embeddings.get(context.contextId);
		if (!contextEmbeddings) {
			logger.warn(
				`[WizardEmbedding] No embeddings found for context ${context.contextId}`,
			);
			continue;
		}

		const qdrantIds: string[] = [];
		const totalChunks = context.chunks.length;

		for (let i = 0; i < context.chunks.length; i++) {
			const chunk = context.chunks[i];
			const embedding = contextEmbeddings[i];

			if (!embedding) {
				logger.warn(
					`[WizardEmbedding] Missing embedding for context ${context.contextId} chunk ${i}`,
				);
				continue;
			}

			try {
				const qdrantId = await storeWizardContext({
					contextId: context.contextId,
					sessionId,
					userId,
					organizationId,
					content: chunk.content,
					embedding,
					chunkIndex: i,
					totalChunks,
					metadata: {
						type: context.type,
						filename: context.filename,
						mimeType: context.mimeType,
					},
				});
				qdrantIds.push(qdrantId);
			} catch (error) {
				logger.error(
					`[WizardEmbedding] Failed to store chunk ${i} of context ${context.contextId}: ${error}`,
				);
				// Continue with other chunks
			}
		}

		qdrantIdsByContext.set(context.contextId, qdrantIds);
	}

	logger.info(
		`[WizardEmbedding] Stored embeddings for ${qdrantIdsByContext.size} contexts`,
	);

	return qdrantIdsByContext;
}

/**
 * Update database with Qdrant embedding info
 */
export async function updateWizardContextEmbeddingStatus(params: {
	contextIds: string[];
	qdrantIds: Map<string, string[]>;
}): Promise<void> {
	const { contextIds, qdrantIds } = params;

	logger.info(
		`[WizardEmbedding] Updating embedding status for ${contextIds.length} contexts`,
	);

	const now = new Date();

	for (const contextId of contextIds) {
		const ids = qdrantIds.get(contextId);
		if (ids && ids.length > 0) {
			try {
				// Store first Qdrant ID (or a comma-separated list if needed)
				await updateWizardTempContextEmbedding(contextId, {
					qdrantId: ids[0], // Store primary Qdrant ID
					embeddedAt: now,
				});
			} catch (error) {
				logger.error(
					`[WizardEmbedding] Failed to update embedding status for ${contextId}: ${error}`,
				);
			}
		}
	}

	logger.info("[WizardEmbedding] Embedding status updated");
}
