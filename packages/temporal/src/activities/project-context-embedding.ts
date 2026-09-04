import { getSystemRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database";
import {
	ensureCollection,
	generateEmbeddings,
	generatePointId,
	qdrantClient,
} from "@repo/rag";

/**
 * Generate embeddings for project contexts
 *
 * Note: Filters out contexts with empty content (e.g., INTEGRATION type contexts)
 * as a defensive measure. The caller should already filter these, but this
 * prevents OpenAI API errors if they slip through.
 */
export async function generateContextEmbeddings(params: {
	contexts: Array<{ id: string; type: string; content: string }>;
	userId: string;
	organizationId?: string;
	projectId?: string;
}): Promise<number[][]> {
	const { contexts, userId, organizationId, projectId } = params;

	// Filter out any contexts with empty content (e.g., INTEGRATION type)
	// OpenAI API rejects empty strings with '$.input' is invalid error
	const validContexts = contexts.filter(
		(c) => c.content && c.content.trim().length > 0,
	);

	if (validContexts.length === 0) {
		console.warn(
			"[generateContextEmbeddings] No valid contexts to embed after filtering empty content",
		);
		return [];
	}

	if (validContexts.length !== contexts.length) {
		console.warn(
			`[generateContextEmbeddings] Filtered ${contexts.length - validContexts.length} contexts with empty content`,
		);
	}

	// Get AI provider configuration using centralized function
	const providerConfig = await getSystemRAGProviderConfig({
		userId,
		organizationId,
	});

	const result = await generateEmbeddings(
		validContexts.map((c) => c.content),
		{ userId, organizationId, projectId },
		providerConfig,
	);
	return result.embeddings;
}

/**
 * Store contexts in Qdrant with tenant isolation
 * Uses the centralized collection manager for proper multi-tenancy
 */
export async function storeContextsInQdrant(params: {
	projectId: string;
	userId: string;
	organizationId?: string;
	contexts: Array<{ id: string; type: string; content: string }>;
	embeddings: number[][];
}): Promise<string[]> {
	const { projectId, userId, organizationId, contexts, embeddings } = params;

	// Use the centralized collection manager (ensures proper naming and tenant isolation)
	const collectionName = await ensureCollection(
		"project-contexts",
		organizationId,
	);

	// Prepare points for Qdrant with proper point ID format
	const points = contexts.map((context, index) => ({
		id: generatePointId(context.id), // Convert CUID to valid Qdrant point ID
		vector: embeddings[index],
		payload: {
			projectId,
			userId,
			organizationId: organizationId || null,
			contextId: context.id,
			contextType: context.type,
			content: context.content,
			createdAt: new Date().toISOString(),
		},
	}));

	// Upsert points to Qdrant
	await qdrantClient.upsert(collectionName, {
		wait: true,
		points,
	});

	// Return the point IDs (for storing in database)
	return contexts.map((c) => generatePointId(c.id));
}

/**
 * Update database with Qdrant IDs and embeddedAt timestamp
 */
export async function updateContextEmbeddingStatus(params: {
	contextIds: string[];
	qdrantIds: string[];
}): Promise<void> {
	const { contextIds, qdrantIds } = params;

	// Update all contexts in a transaction
	await db.$transaction(
		contextIds.map((contextId, index) =>
			db.projectContext.update({
				where: { id: contextId },
				data: {
					qdrantId: qdrantIds[index],
					embeddedAt: new Date(),
				},
			}),
		),
	);
}
