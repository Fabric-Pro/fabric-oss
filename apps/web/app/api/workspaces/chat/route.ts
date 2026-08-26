import {
	enhancePromptWithFabric,
	generateText,
	getAIEmbeddingModelWithMetadata,
	getAIModelWithMetadata,
	getCurrentDateContext,
	logEmbeddingUsageAsync,
	logModelUsageAsync,
} from "@repo/ai";
import { db, hasWorkspaceAccess } from "@repo/database";
import { AiUsageLimitExceededError } from "@repo/payments";
import { generateSparseVector, searchWorkspaceChunks } from "@repo/rag";
import { getSession } from "@saas/auth/lib/server";
import { embed } from "ai";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Workspace Document Chat API
 * Enables chatting with documents in a workspace using RAG.
 * Uses vector search to find relevant document chunks and AI to answer questions.
 */
export async function POST(request: NextRequest) {
	try {
		const session = await getSession();
		if (!session) {
			return NextResponse.json(
				{ error: "Unauthorized" },
				{ status: 401 },
			);
		}

		const userId = session.user.id;
		const {
			workspaceId,
			organizationId,
			message,
			history = [],
		} = await request.json();

		if (!workspaceId || !message) {
			return NextResponse.json(
				{ error: "workspaceId and message are required" },
				{ status: 400 },
			);
		}

		// Verify workspace access
		const hasAccess = await hasWorkspaceAccess(
			workspaceId,
			userId,
			organizationId,
		);
		if (!hasAccess) {
			return NextResponse.json(
				{ error: "You don't have access to this workspace" },
				{ status: 403 },
			);
		}

		// Get workspace details to check if it's personal or org workspace
		const workspace = await db.workspace.findUnique({
			where: { id: workspaceId },
			select: {
				id: true,
				organizationId: true,
				type: true,
				_count: { select: { documents: true } },
			},
		});

		if (!workspace) {
			return NextResponse.json(
				{ error: "Workspace not found" },
				{ status: 404 },
			);
		}

		// Use the workspace's actual organizationId (null for personal workspaces)
		const effectiveOrgId = workspace.organizationId || undefined;

		// Resolve AI access against the workspace's actual tenant, not the request payload.
		const {
			model: aiModel,
			metadata: aiMetadata,
			trackUsage: trackAiUsage,
		} = await getAIModelWithMetadata(
			{ taskType: "CHAT" },
			{ userId, organizationId: effectiveOrgId },
		);

		// Track AI usage (fire-and-forget)
		trackAiUsage();

		console.log("[Workspace Chat] Starting RAG search", {
			workspaceId,
			workspaceType: workspace.type,
			effectiveOrgId: effectiveOrgId || "(personal)",
			documentCount: workspace._count.documents,
			query: message.substring(0, 100),
		});

		// Get embedding model using centralized entry point
		const {
			model: embeddingModel,
			metadata: embeddingMetadata,
			trackUsage: trackEmbeddingUsage,
		} = await getAIEmbeddingModelWithMetadata({
			userId,
			organizationId: effectiveOrgId,
		});

		// Track embedding usage (fire-and-forget)
		trackEmbeddingUsage();

		// Generate embedding for the query
		console.log("[Workspace Chat] Generating query embedding...");
		const embeddingStart = Date.now();
		const { embedding: queryEmbedding, usage: embeddingUsage } =
			await embed({
				model: embeddingModel,
				value: message,
			});
		logEmbeddingUsageAsync({
			context: { userId, organizationId: effectiveOrgId },
			metadata: embeddingMetadata,
			usageTokens: embeddingUsage.tokens,
			latencyMs: Date.now() - embeddingStart,
		});
		console.log(
			"[Workspace Chat] Query embedding generated, dimensions:",
			queryEmbedding.length,
		);

		// Search for relevant chunks in the workspace
		// For personal workspaces, DON'T pass organizationId to avoid filter mismatch
		console.log("[Workspace Chat] Searching workspace documents...", {
			workspaceId,
			organizationId: effectiveOrgId || "(none - personal workspace)",
			topK: 8,
			minSimilarity: 0.2,
		});
		const searchResults = await searchWorkspaceChunks({
			workspaceId,
			userId,
			organizationId: effectiveOrgId, // Use workspace's actual orgId, not request's
			queryEmbedding,
			querySparseVector: generateSparseVector(message),
			topK: 8,
			minSimilarity: 0.2, // Lower threshold for better recall
		});

		console.log(
			`[Workspace Chat] Found ${searchResults.length} relevant chunks`,
			{
				topScores: searchResults
					.slice(0, 3)
					.map((r) => ({ score: r.score, filename: r.filename })),
			},
		);

		// Debug: Check if chunks exist in database for this workspace
		if (searchResults.length === 0) {
			const dbChunkCount = await db.workspaceDocumentChunk.count({
				where: {
					document: {
						workspaceId: workspaceId,
					},
				},
			});
			console.log(
				`[Workspace Chat] DEBUG: Database has ${dbChunkCount} chunks for this workspace`,
			);

			if (dbChunkCount > 0) {
				console.warn(
					"[Workspace Chat] Chunks exist in DB but not found in Qdrant - possible indexing issue",
				);
			}
		}

		// Fetch actual content from PostgreSQL
		let context = "";
		const sources: Array<{
			filename: string;
			pageNumber?: number;
			chunkIndex: number;
			score: number;
			content: string;
		}> = [];

		if (searchResults.length > 0) {
			// Build queries using documentId and chunkIndex (since Qdrant chunkId is ${documentId}-${chunkIndex})
			const chunkQueries = searchResults.map((r) => ({
				documentId: r.documentId,
				chunkIndex: r.chunkIndex,
			}));

			console.log(
				"[Workspace Chat] Fetching chunks from DB:",
				chunkQueries,
			);

			const chunks = await db.workspaceDocumentChunk.findMany({
				where: {
					OR: chunkQueries,
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

			console.log(`[Workspace Chat] Found ${chunks.length} chunks in DB`);

			// Create a map using documentId-chunkIndex as key
			const chunkContentMap = new Map(
				chunks.map((c) => [
					`${c.documentId}-${c.chunkIndex}`,
					{ ...c, filename: c.document?.filename },
				]),
			);

			// Format context and sources
			const contextParts: string[] = [];

			for (const result of searchResults) {
				const mapKey = `${result.documentId}-${result.chunkIndex}`;
				const chunkData = chunkContentMap.get(mapKey);
				if (!chunkData) {
					console.warn(
						`[Workspace Chat] Chunk not found in DB: ${mapKey}`,
					);
					continue;
				}

				const filename =
					result.filename || chunkData.filename || "Unknown Document";
				const header = `### From: ${filename}${result.pageNumber ? ` (Page ${result.pageNumber})` : ""}`;
				contextParts.push(`${header}\n${chunkData.content}`);

				sources.push({
					filename,
					pageNumber: result.pageNumber,
					chunkIndex: result.chunkIndex,
					score: result.score,
					content: chunkData.content,
				});
			}

			context = contextParts.join("\n\n");
			console.log(
				`[Workspace Chat] Built context with ${sources.length} sources, ${context.length} chars`,
			);
		}

		console.log("[Workspace Chat] Using model:", aiMetadata.modelString);

		// Build message history
		const messages = [
			...history.map((h: { role: string; content: string }) => ({
				role: h.role as "user" | "assistant",
				content: h.content,
			})),
			{ role: "user" as const, content: message },
		];

		// Generate response with context
		let systemPrompt = context
			? `You are a helpful assistant that answers questions based on the user's documents.

## Document Context
The following content is from the user's documents. Use this information to answer their questions accurately.

${context}

## Instructions
1. Answer questions based ONLY on the document content provided above
2. If the answer is not in the documents, say so clearly
3. Use markdown formatting for better readability
4. When citing information, reference the source document name
5. Be concise but complete in your answers

${getCurrentDateContext()}`
			: `You are a helpful assistant. The user has asked a question, but no relevant content was found in their documents.

Please let the user know that you couldn't find relevant information in their documents for this question. Suggest they:
1. Try rephrasing their question
2. Upload more relevant documents
3. Check if the documents have finished processing

${getCurrentDateContext()}`;

		// Apply Fabric AI prompt enhancement
		// Auto-detects appropriate patterns, contexts, and strategies based on user message
		try {
			const fabricEnhancement = await enhancePromptWithFabric({
				userMessage: message,
				basePrompt: systemPrompt,
			});

			if (
				fabricEnhancement.fabricUsed &&
				(fabricEnhancement.components.pattern ||
					fabricEnhancement.components.context ||
					fabricEnhancement.components.strategy)
			) {
				systemPrompt = fabricEnhancement.systemPrompt;
				console.log("[Workspace Chat] Fabric AI enhancement applied:", {
					pattern: fabricEnhancement.components.pattern,
					context: fabricEnhancement.components.context,
					strategy: fabricEnhancement.components.strategy,
				});
			}
		} catch (error) {
			console.warn(
				"[Workspace Chat] Fabric AI enhancement failed:",
				error,
			);
		}

		const generationStart = Date.now();
		const result = await generateText({
			model: aiModel,
			system: systemPrompt,
			messages,
		});
		logModelUsageAsync({
			context: { userId, organizationId: effectiveOrgId },
			metadata: aiMetadata,
			taskType: "CHAT",
			usage: result.usage,
			latencyMs: Date.now() - generationStart,
		});

		return NextResponse.json({
			response:
				result.text ||
				"I couldn't generate a response. Please try again.",
			sources: sources.length > 0 ? sources : undefined,
		});
	} catch (error) {
		// AI usage-limit chokepoint hit a HARD limit.
		// Surface the rich payload so the workspace-
		// chat client renders the shared destructive toast instead of a
		// generic 500.
		if (error instanceof AiUsageLimitExceededError) {
			return NextResponse.json(
				{
					error: error.message,
					code: "AI_USAGE_LIMIT_EXCEEDED",
					data: {
						limitId: error.limitId,
						dimension: error.dimension,
						window: error.window,
						used: error.used.toString(),
						max: error.max.toString(),
						manageLimitsUrl: error.manageLimitsUrl,
					},
				},
				{ status: 429 },
			);
		}
		console.error("[Workspace Chat] Error:", error);
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Chat failed" },
			{ status: 500 },
		);
	}
}
