/**
 * Activities for Project Contexts Reprocess Workflow
 *
 * These activities handle the re-processing of project contexts
 * when RAG settings change.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { getRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database/prisma/client";
import { reembedProjectContext as ragReembed } from "@repo/rag";

const qdrant = new QdrantClient({
	url: process.env.QDRANT_URL || "http://localhost:6333",
	apiKey: process.env.QDRANT_API_KEY,
});

const COLLECTION_NAME = "project_contexts";

export interface ProjectContextForReprocess {
	id: string;
	type: string;
	content: string;
	originalFilename?: string | null;
	sourceUrl?: string | null;
	sourceTitle?: string | null;
}

/**
 * Validate RAG provider configuration before reprocessing
 *
 * This prevents data loss by ensuring we can re-embed BEFORE deleting existing embeddings.
 * If this throws, the workflow aborts without deleting any data.
 */
export async function validateRAGProviderConfig(params: {
	userId: string;
	organizationId?: string;
}): Promise<void> {
	const { userId, organizationId } = params;

	console.log("[ReprocessActivity] Validating RAG provider configuration");

	try {
		// This will throw if no provider configured or credentials invalid
		await getRAGProviderConfig({ userId, organizationId });
		console.log("[ReprocessActivity] RAG provider configuration validated");
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unknown error";
		console.error(
			`[ReprocessActivity] RAG provider validation failed: ${message}`,
		);
		throw new Error(
			`Cannot reprocess contexts: AI provider not configured or invalid. ${message}. ` +
				"Please configure an AI provider with embedding support in Settings > AI Configuration.",
		);
	}
}

/**
 * Fetch all contexts for a project that need reprocessing
 */
export async function fetchProjectContextsForReprocess(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
}): Promise<ProjectContextForReprocess[]> {
	const { projectId } = params;

	// Filter out INTEGRATION type contexts - they don't have content to embed
	// (they provide live tool access via Teams/Slack search, not indexed content)
	const contexts = await db.projectContext.findMany({
		where: {
			projectId,
			type: { not: "INTEGRATION" },
		},
		select: {
			id: true,
			type: true,
			content: true,
			originalFilename: true,
			sourceUrl: true,
			sourceTitle: true,
		},
	});

	console.log(
		`[ReprocessActivity] Found ${contexts.length} contexts for project ${projectId}`,
	);

	return contexts;
}

/**
 * Delete all project contexts from Qdrant
 */
export async function deleteProjectContextsFromQdrant(params: {
	projectId: string;
	organizationId?: string;
}): Promise<void> {
	const { projectId, organizationId } = params;

	console.log(
		`[ReprocessActivity] Deleting Qdrant points for project ${projectId}`,
	);

	try {
		// Build filter for deletion
		const filter: any = {
			must: [
				{
					key: "projectId",
					match: { value: projectId },
				},
			],
		};

		if (organizationId) {
			filter.must.push({
				key: "organizationId",
				match: { value: organizationId },
			});
		}

		// Delete all points matching the filter
		await qdrant.delete(COLLECTION_NAME, {
			wait: true,
			filter,
		});

		console.log(
			`[ReprocessActivity] Deleted Qdrant points for project ${projectId}`,
		);
	} catch {
		// Collection might not exist yet - that's OK
		console.log(
			`[ReprocessActivity] No existing points to delete or collection doesn't exist`,
		);
	}
}

/**
 * Re-embed a single project context with new RAG settings
 *
 * This activity resolves the AI provider config internally using the
 * centralized getRAGProviderConfig function, which handles:
 * - User/org preference lookup
 * - API key decryption
 * - Proper tenant isolation
 */
export async function reembedProjectContext(params: {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	type: string;
	metadata?: {
		originalFilename?: string | null;
		sourceUrl?: string | null;
		sourceTitle?: string | null;
	};
}): Promise<void> {
	const {
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type,
		metadata,
	} = params;

	console.log(`[ReprocessActivity] Re-embedding context ${contextId}`);

	// Resolve AI provider config internally (handles user/org preferences, decryption)
	const providerConfig = await getRAGProviderConfig({
		userId,
		organizationId,
	});

	// Use the RAG library's reembed function which uses project RAG settings
	const result = await ragReembed({
		contextId,
		projectId,
		userId,
		organizationId,
		content,
		type,
		apiKey: providerConfig, // Pass full provider config (apiKey, provider, baseUrl)
		metadata: {
			filename: metadata?.originalFilename || undefined,
			sourceUrl: metadata?.sourceUrl || undefined,
			sourceTitle: metadata?.sourceTitle || undefined,
		},
	});

	if (!result.success) {
		throw new Error(
			`Failed to re-embed context ${contextId}: ${result.error}`,
		);
	}

	console.log(
		`[ReprocessActivity] Re-embedded context ${contextId} (${result.chunksCreated} chunks)`,
	);
}

/**
 * Update reprocess progress (for UI feedback)
 */
export async function updateReprocessProgress(params: {
	projectId: string;
	totalContexts: number;
	processedCount: number;
	failedCount: number;
}): Promise<void> {
	// For now, just log progress
	// In future, could update a database field or send to websocket
	console.log(
		`[ReprocessActivity] Progress: ${params.processedCount}/${params.totalContexts} (${params.failedCount} failed)`,
	);
}
