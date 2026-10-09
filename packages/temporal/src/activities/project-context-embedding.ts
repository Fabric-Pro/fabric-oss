import { getSystemEmbeddingRAGProviderConfig } from "@repo/ai";
import { stampContextsEmbedded } from "@repo/database";
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
	const providerConfig = await getSystemEmbeddingRAGProviderConfig({
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
 *
 * Only for rows whose content is still what was embedded: `versions[i]` is
 * the content version (hash, or `updatedAt` for a row without one) copied
 * into the workflow input with `contextIds[i]`. A row that changed since stays
 * unstamped, so the next pass embeds it again, and a row that was deleted is
 * skipped instead of failing the whole batch. A caller without `versions`
 * (an execution started before they existed) is guarded by the id alone.
 */
export async function updateContextEmbeddingStatus(params: {
	projectId: string;
	contextIds: string[];
	qdrantIds: string[];
	versions?: Array<{
		contentHash: string | null;
		updatedAt: string;
	} | null>;
}): Promise<void> {
	const { projectId, contextIds, qdrantIds, versions } = params;

	const { stamped, skipped } = await stampContextsEmbedded({
		projectId,
		contexts: contextIds.map((id, index) => {
			const version = versions?.[index] ?? null;
			return {
				id,
				qdrantId: qdrantIds[index],
				version: version
					? {
							contentHash: version.contentHash,
							updatedAt: new Date(version.updatedAt),
						}
					: null,
			};
		}),
	});
	if (skipped > 0) {
		console.warn(
			`[updateContextEmbeddingStatus] Left ${skipped} of ${stamped + skipped} contexts unstamped: changed or deleted since they were embedded`,
		);
	}
}
