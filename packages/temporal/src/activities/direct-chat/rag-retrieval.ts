/**
 * RAG Retrieval Activities
 *
 * Handles RAG context retrieval from documents and workspaces.
 */

import { getRAGProviderConfig } from "@repo/ai";
import {
	db,
	getDefaultRagSettings,
	getEffectiveRagSettings,
} from "@repo/database";

const logger = {
	info: (message: string, data?: Record<string, unknown>) =>
		console.log(`[DirectChat RAG] ${message}`, data || ""),
	error: (message: string, error?: unknown) =>
		console.error(`[DirectChat RAG] ${message}`, error),
	warn: (message: string, data?: Record<string, unknown>) =>
		console.warn(`[DirectChat RAG] ${message}`, data || ""),
};

/**
 * RAG source type for citations
 */
export interface RagSource {
	id: string;
	title: string;
	type: "document" | "web" | "other";
	excerpt?: string;
	similarity?: number;
}

/**
 * Retrieve RAG context from attached documents
 *
 * This activity retrieves relevant context from documents attached to the chat.
 * It uses the existing RAG infrastructure to search for relevant chunks.
 *
 * IMPORTANT: This activity will wait for documents to be processed if not ready.
 */
export async function retrieveRagContextForDirectChatActivity(
	message: string,
	userId: string,
	organizationId?: string,
	chatId?: string,
	documentIds?: string[],
	topK = 5,
	minSimilarity = 0.1,
	/** When set, uses enrichment mode (files as additional context for project work) */
	projectId?: string,
): Promise<{
	context: string;
	chunkCount: number;
	documentsNotReady?: string[];
	sources?: RagSource[];
}> {
	if (!documentIds || documentIds.length === 0) {
		logger.info("No documents attached, skipping RAG context retrieval");
		return { context: "", chunkCount: 0 };
	}

	logger.info("Retrieving RAG context for direct chat", {
		userId,
		organizationId,
		chatId,
		documentCount: documentIds.length,
		documentIds,
	});

	const effectiveChatId = chatId || `direct-chat-${Date.now()}`;

	try {
		// Wait for documents to be processed
		const MAX_WAIT_TIME = 60000;
		const POLL_INTERVAL = 2000;
		const startTime = Date.now();

		let documentsReady = false;
		let pendingDocuments: string[] = [];
		let failedDocuments: string[] = [];

		while (!documentsReady && Date.now() - startTime < MAX_WAIT_TIME) {
			const documents = await db.chatDocument.findMany({
				where: {
					id: { in: documentIds },
					userId,
				},
				select: {
					id: true,
					filename: true,
					status: true,
				},
			});

			pendingDocuments = documents
				.filter(
					(d) => d.status === "PENDING" || d.status === "PROCESSING",
				)
				.map((d) => d.filename);

			failedDocuments = documents
				.filter((d) => d.status === "FAILED")
				.map((d) => d.filename);

			const readyDocuments = documents.filter(
				(d) => d.status === "READY",
			);

			logger.info("Document status check", {
				total: documents.length,
				ready: readyDocuments.length,
				pending: pendingDocuments.length,
				failed: failedDocuments.length,
			});

			if (pendingDocuments.length === 0) {
				documentsReady = true;
				break;
			}

			logger.info(
				`Waiting for ${pendingDocuments.length} documents to be processed...`,
				{
					pendingDocuments,
					elapsedMs: Date.now() - startTime,
				},
			);
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
		}

		if (!documentsReady && pendingDocuments.length > 0) {
			logger.warn("Timed out waiting for documents to be processed", {
				pendingDocuments,
				timeoutMs: MAX_WAIT_TIME,
			});
			return {
				context: `\n\n## Document Processing Status:\nThe following documents are still being processed and their content is not yet available: ${pendingDocuments.join(", ")}. Please wait a moment and try again.`,
				chunkCount: 0,
				documentsNotReady: pendingDocuments,
			};
		}

		if (failedDocuments.length > 0) {
			logger.warn("Some documents failed to process", {
				failedDocuments,
			});
		}

		// Get AI provider API key for embedding generation
		const { retrieveContext, formatContextForLLM } = await import(
			"@repo/rag"
		);

		let providerConfig:
			| Awaited<ReturnType<typeof getRAGProviderConfig>>
			| undefined;
		try {
			providerConfig = await getRAGProviderConfig({
				userId,
				organizationId,
			});
		} catch (_error) {
			logger.error("No AI provider configured for RAG retrieval");
			return {
				context:
					"\n\n## Configuration Required:\nNo AI provider is configured. Please configure an AI provider in Settings to enable document search.",
				chunkCount: 0,
			};
		}

		logger.info("Using centralized AI provider config for RAG retrieval");

		// Retrieve relevant chunks
		const chunks = await retrieveContext({
			chatId: effectiveChatId,
			query: message,
			userId,
			organizationId,
			documentIds,
			topK,
			minSimilarity,
			apiKey: providerConfig.apiKey,
			// Reached only when the user attached documents to this message
			// (the activity returns early above when documentIds is empty), so
			// drop the similarity floor to guarantee the attached content is read.
			explicitAttachment: true,
		});

		if (chunks.length === 0) {
			logger.info("No relevant chunks found in attached documents");

			const readyDocs = await db.chatDocument.findMany({
				where: {
					id: { in: documentIds },
					userId,
					status: "READY",
				},
				select: { filename: true },
			});

			if (readyDocs.length > 0) {
				return {
					context: `\n\n## Document Context:\nDocuments were processed (${readyDocs.map((d) => d.filename).join(", ")}) but no relevant content was found for your query.`,
					chunkCount: 0,
				};
			}

			return { context: "", chunkCount: 0 };
		}

		const formattedContext = formatContextForLLM(chunks, {
			purpose: projectId ? "enrichment" : "qa",
		});

		// Extract sources for citations
		const sourceMap = new Map<string, RagSource>();
		for (const chunk of chunks) {
			if (!sourceMap.has(chunk.id)) {
				sourceMap.set(chunk.id, {
					id: chunk.id,
					title: chunk.filename,
					type: "document",
					excerpt:
						chunk.content.substring(0, 200) +
						(chunk.content.length > 200 ? "..." : ""),
					similarity: chunk.similarity,
				});
			}
		}

		const sources = Array.from(sourceMap.values());

		logger.info("RAG context retrieved successfully", {
			chunkCount: chunks.length,
			sourceCount: sources.length,
			contextLength: formattedContext.length,
		});

		return {
			context: `\n\n## Context from Attached Documents:\n${formattedContext}`,
			chunkCount: chunks.length,
			sources,
		};
	} catch (error) {
		logger.error("Failed to retrieve RAG context", error);
		return {
			context: `\n\n## Document Processing Error:\nFailed to retrieve content from attached documents. Error: ${error instanceof Error ? error.message : "Unknown error"}`,
			chunkCount: 0,
		};
	}
}

/**
 * Retrieve RAG context from workspace documents
 *
 * Uses workspace-specific RAG settings for topK and similarityThreshold.
 * When multiple workspaces are selected, loads settings for each workspace
 * and applies per-workspace filtering after the initial search.
 */
export async function retrieveWorkspaceDocumentsActivity(
	message: string,
	userId: string,
	organizationId?: string,
	workspaceIds?: string[],
	documentIds?: string[],
	topKOverride?: number,
	minSimilarityOverride?: number,
): Promise<{
	context: string;
	chunkCount: number;
	sources?: RagSource[];
}> {
	if (!workspaceIds || workspaceIds.length === 0) {
		logger.info(
			"No workspaces attached, skipping workspace document retrieval",
		);
		return { context: "", chunkCount: 0 };
	}

	// Load RAG settings for all workspaces
	// For multi-workspace search, we use the most permissive settings for the initial search
	// then apply per-workspace filtering
	const defaults = getDefaultRagSettings();
	const workspaceSettingsMap = new Map<
		string,
		{ topK: number; minSimilarity: number }
	>();

	// Load effective settings for each workspace (includes org-level defaults)
	for (const workspaceId of workspaceIds) {
		try {
			// getEffectiveRagSettings handles the inheritance:
			// Workspace settings > Organization settings > System defaults
			const ragSettings = await getEffectiveRagSettings(workspaceId);
			workspaceSettingsMap.set(workspaceId, {
				topK: topKOverride ?? ragSettings.topK,
				minSimilarity:
					minSimilarityOverride ?? ragSettings.similarityThreshold,
			});
		} catch (error) {
			logger.warn(
				"[WorkspaceRAG] Failed to load workspace RAG settings",
				{
					workspaceId,
					error:
						error instanceof Error
							? error.message
							: "Unknown error",
				},
			);
			workspaceSettingsMap.set(workspaceId, {
				topK: topKOverride ?? defaults.topK,
				minSimilarity:
					minSimilarityOverride ?? defaults.similarityThreshold,
			});
		}
	}

	// Use the most permissive settings for the initial search
	// (highest topK, lowest minSimilarity) to get all potentially relevant results
	const allSettings = Array.from(workspaceSettingsMap.values());
	const topK = Math.max(...allSettings.map((s) => s.topK));
	const minSimilarity = Math.min(...allSettings.map((s) => s.minSimilarity));

	logger.info("[WorkspaceRAG] Using per-workspace RAG settings", {
		workspaceCount: workspaceIds.length,
		searchTopK: topK,
		searchMinSimilarity: minSimilarity,
		perWorkspaceSettings: Object.fromEntries(workspaceSettingsMap),
	});

	logger.info("[WorkspaceRAG] Starting workspace document retrieval", {
		userId,
		organizationId: organizationId || "(personal)",
		workspaceCount: workspaceIds.length,
		workspaceIds,
		query: message.substring(0, 100),
		topK,
		minSimilarity,
	});

	try {
		const { searchMultipleWorkspaces } = await import(
			"@repo/rag/lib/workspace-documents/store"
		);
		const { generateEmbedding, generateSparseVector } = await import(
			"@repo/rag"
		);

		// Get AI provider configuration using centralized function
		const providerConfig = await getRAGProviderConfig({
			userId,
			organizationId,
		});
		logger.info("[WorkspaceRAG] Using centralized AI provider config");

		logger.info("[WorkspaceRAG] Generating query embedding...");
		const embeddingResult = await generateEmbedding(
			message,
			{ userId, organizationId, tags: ["workspace-rag", "query"] },
			providerConfig,
		);
		logger.info("[WorkspaceRAG] Query embedding generated", {
			embeddingDimensions: embeddingResult.embedding.length,
		});

		const queryEmbedding = embeddingResult.embedding;

		logger.info("[WorkspaceRAG] Searching Qdrant for similar chunks...", {
			workspaceIds,
			topK,
			minSimilarity,
		});
		const searchResults = await searchMultipleWorkspaces({
			workspaceIds,
			userId,
			organizationId: organizationId || undefined,
			queryEmbedding,
			querySparseVector: generateSparseVector(message),
			topK,
			minSimilarity,
			documentIds,
		});

		logger.info("[WorkspaceRAG] Qdrant search completed", {
			resultCount: searchResults.length,
			topScores: searchResults.slice(0, 3).map((r) => r.score),
		});

		if (searchResults.length === 0) {
			logger.warn(
				"[WorkspaceRAG] No relevant chunks found in workspace documents",
				{
					workspaceIds,
					minSimilarity,
				},
			);
			return {
				context:
					"\n\n## Workspace Documents:\nNo relevant content was found in the attached workspace documents for your query.",
				chunkCount: 0,
			};
		}

		// Apply per-workspace filtering
		// Group results by workspace and apply each workspace's minSimilarity and topK settings
		const filteredResults: typeof searchResults = [];
		const resultsByWorkspace = new Map<string, typeof searchResults>();

		// Group results by workspace
		for (const result of searchResults) {
			const wsResults = resultsByWorkspace.get(result.workspaceId) || [];
			wsResults.push(result);
			resultsByWorkspace.set(result.workspaceId, wsResults);
		}

		// Apply per-workspace filtering
		for (const [wsId, wsResults] of resultsByWorkspace) {
			const wsSettings = workspaceSettingsMap.get(wsId) || {
				topK: defaults.topK,
				minSimilarity: defaults.similarityThreshold,
			};

			// Filter by minSimilarity and limit to topK
			const filtered = wsResults
				.filter((r) => r.score >= wsSettings.minSimilarity)
				.slice(0, wsSettings.topK);

			filteredResults.push(...filtered);
		}

		// Sort all results by score descending
		filteredResults.sort((a, b) => b.score - a.score);

		logger.info("[WorkspaceRAG] Applied per-workspace filtering", {
			originalCount: searchResults.length,
			filteredCount: filteredResults.length,
			byWorkspace: Object.fromEntries(
				Array.from(resultsByWorkspace.entries()).map(
					([wsId, results]) => {
						const wsSettings = workspaceSettingsMap.get(wsId);
						return [
							wsId,
							{
								original: results.length,
								filtered: filteredResults.filter(
									(r) => r.workspaceId === wsId,
								).length,
								settings: wsSettings,
							},
						];
					},
				),
			),
		});

		if (filteredResults.length === 0) {
			logger.warn(
				"[WorkspaceRAG] No chunks passed per-workspace filtering",
				{
					workspaceIds,
				},
			);
			return {
				context:
					"\n\n## Workspace Documents:\nNo relevant content was found in the attached workspace documents for your query.",
				chunkCount: 0,
			};
		}

		// Use filteredResults instead of searchResults for content fetching
		const searchResultsToUse = filteredResults;

		// Fetch actual content from PostgreSQL
		const chunkLookups = searchResultsToUse.map((r) => {
			const lastDashIndex = r.chunkId.lastIndexOf("-");
			if (lastDashIndex === -1) {
				return { documentId: r.documentId, chunkIndex: r.chunkIndex };
			}
			const docId = r.chunkId.substring(0, lastDashIndex);
			const chunkIdx = Number.parseInt(
				r.chunkId.substring(lastDashIndex + 1),
				10,
			);
			return {
				documentId: docId || r.documentId,
				chunkIndex: Number.isNaN(chunkIdx) ? r.chunkIndex : chunkIdx,
			};
		});

		logger.info("[WorkspaceRAG] Chunk lookups:", {
			chunkLookups: chunkLookups.slice(0, 3),
		});

		const chunks = await db.workspaceDocumentChunk.findMany({
			where: {
				OR: chunkLookups.map(({ documentId, chunkIndex }) => ({
					documentId,
					chunkIndex,
				})),
			},
			select: {
				id: true,
				documentId: true,
				content: true,
				chunkIndex: true,
				pageNumber: true,
				document: {
					select: {
						id: true,
						filename: true,
					},
				},
			},
		});

		logger.info("[WorkspaceRAG] Fetched chunks from PostgreSQL:", {
			requestedCount: searchResultsToUse.length,
			fetchedCount: chunks.length,
		});

		const chunkContentMap = new Map(
			chunks.map((c) => [
				`${c.documentId}-${c.chunkIndex}`,
				{ ...c, filename: c.document?.filename },
			]),
		);

		// Format results
		const contextParts: string[] = [];
		const sources: RagSource[] = [];

		for (const result of searchResultsToUse) {
			const chunkData = chunkContentMap.get(result.chunkId);
			if (!chunkData) {
				continue;
			}

			const filename = result.filename || chunkData.filename;
			const header = filename
				? `### From: ${filename}`
				: "### Document chunk";
			contextParts.push(`${header}\n${chunkData.content}`);

			if (!sources.some((s) => s.id === result.documentId)) {
				sources.push({
					id: result.documentId,
					title: filename || "Workspace Document",
					type: "document",
					excerpt:
						chunkData.content.substring(0, 200) +
						(chunkData.content.length > 200 ? "..." : ""),
					similarity: result.score,
				});
			}
		}

		const formattedContext = contextParts.join("\n\n");

		logger.info("Workspace RAG context retrieved successfully", {
			chunkCount: contextParts.length,
			sourceCount: sources.length,
			contextLength: formattedContext.length,
		});

		return {
			context: `\n\n## Workspace Documents:\nThe following content is from the user's attached workspace documents. USE THIS CONTENT to answer questions about "my docs", "personal documents", etc.\n\n${formattedContext}`,
			chunkCount: contextParts.length,
			sources,
		};
	} catch (error) {
		logger.error("Failed to retrieve workspace RAG context", error);
		return {
			context: `\n\n## Workspace Document Error:\nFailed to retrieve content from workspace documents. Error: ${error instanceof Error ? error.message : "Unknown error"}`,
			chunkCount: 0,
		};
	}
}
