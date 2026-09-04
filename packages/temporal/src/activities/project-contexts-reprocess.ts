/**
 * Activities for Project Contexts Reprocess Workflow
 *
 * These activities handle the re-processing of project contexts
 * when RAG settings change.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { getSystemRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database/prisma/client";
import { reembedProjectContext as ragReembed } from "@repo/rag";
import {
	collectionExistsUncached,
	getCollectionName,
	PROJECT_CONTEXTS_BASE_COLLECTION,
} from "@repo/rag/lib/collection-manager";

const qdrant = new QdrantClient({
	url: process.env.QDRANT_URL || "http://localhost:6333",
	apiKey: process.env.QDRANT_API_KEY,
});

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
		await getSystemRAGProviderConfig({ userId, organizationId });
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
 * Delete all of a project's context points from Qdrant.
 *
 * Runs before the re-embed, so it is the step that keeps a reprocess from
 * stacking a second copy of every chunk on top of the old ones. Failures are
 * therefore NOT swallowed: only a collection that does not exist counts as
 * "nothing to clear", and everything else propagates so the workflow aborts
 * before a single context is re-written.
 *
 * # The delete is wider than the re-embed, so it hands the difference back
 *
 * The filter clears every point carrying this `projectId` — including the
 * conversation bundles captured under a linked channel, whose points are
 * written under the BUNDLE row's id (see `capture-conversation-bundle.ts`).
 * The re-embed that follows only walks `ProjectContext` rows of type other
 * than INTEGRATION, so nothing in this workflow ever rebuilds them.
 *
 * Left alone, those rows would still say `embeddedAt` — a claim that the
 * vector store holds their point — so the recovery sweep, which looks for a
 * null `embeddedAt`, could not see them either: the conversations would go
 * silently unsearchable until the next capture on that channel, which rebuilds
 * nothing retrospectively. Clearing the stamp is what puts them back in the
 * sweep's queue, and the sweep re-embeds each one under its own row's tenant.
 */
export async function deleteProjectContextsFromQdrant(params: {
	projectId: string;
	organizationId?: string;
}): Promise<void> {
	const { projectId, organizationId } = params;

	// Resolve the collection the re-embed will write to — an organization's
	// points live in a dedicated collection, not in the personal one.
	const collectionName = getCollectionName(
		PROJECT_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);

	console.log(
		`[ReprocessActivity] Deleting Qdrant points for project ${projectId} from collection ${collectionName}`,
	);

	// Per-organization collections are created lazily on first write, so a
	// tenant that never embedded a project context legitimately has none —
	// there is nothing to clear and nothing to fail over.
	if (!(await collectionExistsUncached(collectionName))) {
		console.log(
			`[ReprocessActivity] Collection ${collectionName} does not exist — no points to clear for project ${projectId}`,
		);
		return;
	}

	// Both filter keys are indexed payload fields on the project-contexts
	// collection; Qdrant rejects delete-by-filter on an unindexed key with 400.
	const filter: {
		must: Array<{ key: string; match: { value: string } }>;
	} = {
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

	// Delete all points matching the filter. An error here is a real failure —
	// the previous bare catch reported a clear that never happened as done, and
	// the re-embed that follows then duplicated every chunk.
	await qdrant.delete(collectionName, {
		wait: true,
		filter,
	});

	console.log(
		`[ReprocessActivity] Deleted Qdrant points for project ${projectId} from collection ${collectionName}`,
	);

	// ONLY after the delete succeeded: the rows whose points that call just
	// removed and nothing in this workflow rebuilds. Resetting the stamp puts
	// them back into the recovery sweep's queue — `embeddedAt` null and no
	// lease is exactly the predicate it lists on. Run before the delete, this
	// would queue rows whose points are still there and have a failed delete
	// leave the sweep re-embedding what was never cleared.
	const requeued = await db.projectContextConversationBundle.updateMany({
		where: { projectId },
		data: { embeddedAt: null, qdrantId: null, embeddingLeaseAt: null },
	});

	if (requeued.count > 0) {
		console.log(
			`[ReprocessActivity] Queued ${requeued.count} conversation bundle(s) of project ${projectId} for re-embedding`,
		);
	}
}

/**
 * Re-embed a single project context with new RAG settings
 *
 * This activity resolves the AI provider config internally using the
 * centralized getSystemRAGProviderConfig function, which handles:
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
	const providerConfig = await getSystemRAGProviderConfig({
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
