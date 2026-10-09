/**
 * Activities for Project Contexts Reprocess Workflow
 *
 * These activities handle the re-processing of project contexts
 * when RAG settings change.
 */

import { getSystemEmbeddingRAGProviderConfig } from "@repo/ai";
import { db } from "@repo/database/prisma/client";
import { reembedProjectContext as ragReembed } from "@repo/rag";
import { deleteOrphanProjectContextPoints } from "@repo/rag/lib/project-contexts/store";

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
		await getSystemEmbeddingRAGProviderConfig({ userId, organizationId });
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
 * Prepare a project's vectors for the re-embed that follows — without
 * deleting any of them.
 *
 * This step used to clear every point carrying the project's `projectId`
 * before a single context had been re-embedded. When the re-embed then
 * failed (a provider outage, or an embedding model whose dimensions the
 * collection cannot hold) the project was left with no vectors at all — and
 * the project-wide filter also took the project's document chunks, which this
 * workflow never rebuilds. Each context's re-embed now replaces its own points
 * only after the new ones are written (see `reembedProjectContext` in
 * `@repo/rag`), so no up-front clear is needed. The activity keeps its name
 * and its place in the workflow so existing histories replay unchanged.
 *
 * What it still deletes is the points of context rows that no longer exist:
 * nothing re-embeds them, and nothing live is among them. Code-index chunks,
 * summaries, crawled URL pages, wizard contexts, document chunks and
 * conversation bundles are never candidates. Bundles
 * are handed to the recovery sweep (null `embeddedAt`, no lease) to be
 * re-embedded under the new settings; their points stay in place until the
 * sweep's embed overwrites them.
 */
export async function deleteProjectContextsFromQdrant(params: {
	projectId: string;
	organizationId?: string;
}): Promise<void> {
	const { projectId, organizationId } = params;

	// Every row a point of this project may be written under.
	const owners = await Promise.all([
		db.projectContext.findMany({
			where: { projectId },
			select: { id: true },
		}),
		db.projectContextConversationBundle.findMany({
			where: { projectId },
			select: { id: true },
		}),
		db.projectContextUrlPage.findMany({
			where: { projectId },
			select: { id: true },
		}),
		db.projectContextSummary.findMany({
			where: { projectId },
			select: { id: true },
		}),
	]);
	const orphans = await deleteOrphanProjectContextPoints({
		projectId,
		organizationId,
		liveIds: new Set(owners.flat().map((row) => row.id)),
	});
	if (orphans > 0) {
		console.log(
			`[ReprocessActivity] Deleted ${orphans} point(s) of deleted contexts of project ${projectId}`,
		);
	}

	const requeued = await db.projectContextConversationBundle.updateMany({
		where: { projectId },
		data: { embeddedAt: null, embeddingLeaseAt: null },
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
 * centralized getSystemEmbeddingRAGProviderConfig function, which handles:
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
	const providerConfig = await getSystemEmbeddingRAGProviderConfig({
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
