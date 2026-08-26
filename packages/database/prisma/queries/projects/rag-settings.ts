/**
 * Database queries for ProjectRagSettings model
 * Handles per-project RAG configuration
 */

import { type ChunkSplitMethod, db, type EmbeddingModel } from "../../client";

/**
 * Default RAG settings optimized for hybrid search + reranking pipeline
 *
 * Strategy:
 * 1. Retrieve more contexts initially (topK: 50) with lower threshold (0.3)
 * 2. Rerank to get the most relevant (rerankTopK: 10)
 * 3. Include episodic memory for project context
 */
const DEFAULT_RAG_SETTINGS = {
	chunkSize: 3000,
	chunkOverlap: 500,
	splitMethod: "DOCUMENT" as ChunkSplitMethod, // Structure-aware splitting (markdown, code)
	embeddingModel: "TEXT_EMBEDDING_3_SMALL" as EmbeddingModel,
	topK: 50, // Retrieve more for reranking to filter
	similarityThreshold: 0.3, // Lower threshold since reranking will filter
	enableReranking: true, // Enable by default for better quality
	rerankTopK: 10, // Final count after reranking
	rerankerProvider: "cross-encoder", // Free, self-hosted default
	enableEpisodicMemory: true, // Include past project discussions
	codeSearchEnabled: false,
	codeSearchProvider: null as string | null,
	codeEmbeddingModel: "TEXT_EMBEDDING_3_SMALL" as string | null,
};

/**
 * Get RAG settings for a project
 * Returns default settings if none exist
 */
export async function getProjectRagSettings(projectId: string) {
	const settings = await db.projectRagSettings.findUnique({
		where: { projectId },
	});

	if (!settings) {
		return {
			...DEFAULT_RAG_SETTINGS,
			projectId,
			id: null,
			createdAt: null,
			updatedAt: null,
		};
	}

	return settings;
}

/**
 * Create or update RAG settings for a project
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function upsertProjectRagSettings(
	projectId: string,
	data: {
		chunkSize?: number;
		chunkOverlap?: number;
		splitMethod?: ChunkSplitMethod;
		embeddingModel?: EmbeddingModel;
		topK?: number;
		similarityThreshold?: number;
		enableReranking?: boolean;
		rerankTopK?: number;
		rerankerProvider?: string;
		enableEpisodicMemory?: boolean;
		codeSearchEnabled?: boolean;
		codeSearchProvider?: string | null;
		codeEmbeddingModel?: string | null;
		// Tenant isolation fields
		userId: string;
		organizationId?: string;
	},
) {
	return await db.projectRagSettings.upsert({
		where: { projectId },
		create: {
			projectId,
			chunkSize: data.chunkSize ?? DEFAULT_RAG_SETTINGS.chunkSize,
			chunkOverlap:
				data.chunkOverlap ?? DEFAULT_RAG_SETTINGS.chunkOverlap,
			splitMethod: data.splitMethod ?? DEFAULT_RAG_SETTINGS.splitMethod,
			embeddingModel:
				data.embeddingModel ?? DEFAULT_RAG_SETTINGS.embeddingModel,
			topK: data.topK ?? DEFAULT_RAG_SETTINGS.topK,
			similarityThreshold:
				data.similarityThreshold ??
				DEFAULT_RAG_SETTINGS.similarityThreshold,
			enableReranking:
				data.enableReranking ?? DEFAULT_RAG_SETTINGS.enableReranking,
			rerankTopK: data.rerankTopK ?? DEFAULT_RAG_SETTINGS.rerankTopK,
			rerankerProvider:
				data.rerankerProvider ?? DEFAULT_RAG_SETTINGS.rerankerProvider,
			enableEpisodicMemory:
				data.enableEpisodicMemory ??
				DEFAULT_RAG_SETTINGS.enableEpisodicMemory,
			codeSearchEnabled:
				data.codeSearchEnabled ??
				DEFAULT_RAG_SETTINGS.codeSearchEnabled,
			codeSearchProvider:
				data.codeSearchProvider ??
				DEFAULT_RAG_SETTINGS.codeSearchProvider,
			codeEmbeddingModel:
				data.codeEmbeddingModel ??
				DEFAULT_RAG_SETTINGS.codeEmbeddingModel,
			userId: data.userId,
			organizationId: data.organizationId,
		},
		update: {
			...(data.chunkSize !== undefined && { chunkSize: data.chunkSize }),
			...(data.chunkOverlap !== undefined && {
				chunkOverlap: data.chunkOverlap,
			}),
			...(data.splitMethod !== undefined && {
				splitMethod: data.splitMethod,
			}),
			...(data.embeddingModel !== undefined && {
				embeddingModel: data.embeddingModel,
			}),
			...(data.topK !== undefined && { topK: data.topK }),
			...(data.similarityThreshold !== undefined && {
				similarityThreshold: data.similarityThreshold,
			}),
			...(data.enableReranking !== undefined && {
				enableReranking: data.enableReranking,
			}),
			...(data.rerankTopK !== undefined && {
				rerankTopK: data.rerankTopK,
			}),
			...(data.rerankerProvider !== undefined && {
				rerankerProvider: data.rerankerProvider,
			}),
			...(data.enableEpisodicMemory !== undefined && {
				enableEpisodicMemory: data.enableEpisodicMemory,
			}),
			...(data.codeSearchEnabled !== undefined && {
				codeSearchEnabled: data.codeSearchEnabled,
			}),
			...(data.codeSearchProvider !== undefined && {
				codeSearchProvider: data.codeSearchProvider,
			}),
			...(data.codeEmbeddingModel !== undefined && {
				codeEmbeddingModel: data.codeEmbeddingModel,
			}),
		},
	});
}

/**
 * Delete RAG settings for a project
 */
export async function deleteProjectRagSettings(projectId: string) {
	return await db.projectRagSettings.delete({
		where: { projectId },
	});
}

/**
 * Reset RAG settings to defaults
 *
 * TENANT ISOLATION: userId and organizationId are required for proper tenant filtering.
 */
export async function resetProjectRagSettings(
	projectId: string,
	tenantContext: {
		userId: string;
		organizationId?: string;
	},
) {
	return await db.projectRagSettings.upsert({
		where: { projectId },
		create: {
			projectId,
			...DEFAULT_RAG_SETTINGS,
			userId: tenantContext.userId,
			organizationId: tenantContext.organizationId,
		},
		update: DEFAULT_RAG_SETTINGS,
	});
}
