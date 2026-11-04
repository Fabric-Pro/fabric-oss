import {
	enhancePromptWithFabric,
	getAIEmbeddingModelWithMetadata,
	getAIModelWithMetadata,
	getCurrentDateContext,
	type LanguageModel,
	logEmbeddingUsageAsync,
	logModelUsageAsync,
} from "@repo/ai";
import {
	type AnswerModelInfo,
	answerModelInfo,
} from "@repo/ai/lib/answer-model-info";
import { db, hasWorkspaceAccess } from "@repo/database";
import {
	boundQueryForEmbedding,
	generateSparseVector,
	searchWorkspaceChunks,
} from "@repo/rag";
import type { WorkspaceDocumentSource } from "@saas/agents/lib/workspace-document-chat-protocol";
import { embed } from "ai";

/**
 * One turn of a library's Chat with Documents, shared by the dialog's route
 * (`POST /api/workspaces/chat`, one JSON reply) and the agent runtime's
 * `library-chat` engine (a streamed reply): the access check, the model and
 * embedding resolution and their billing, the retrieval, and the prompt. The
 * caller runs the model on the prepared turn and records its usage with the
 * turn's `recordAnswer`.
 *
 * The tenant is the workspace's own (`null` for a personal library), never
 * the request's.
 */

type ChatRole = "user" | "assistant";

export interface WorkspaceChatWorkspace {
	id: string;
	organizationId: string | null;
	type: string;
	_count: { documents: number };
}

export type WorkspaceChatAccess =
	| { ok: true; workspace: WorkspaceChatWorkspace }
	| { ok: false; status: 403 | 404; error: string };

/** Whether the person may chat with this workspace's documents, and the workspace. */
export async function checkWorkspaceChatAccess(
	userId: string,
	workspaceId: string,
): Promise<WorkspaceChatAccess> {
	if (!(await hasWorkspaceAccess(workspaceId, userId))) {
		return {
			ok: false,
			status: 403,
			error: "You don't have access to this workspace",
		};
	}
	const workspace = await db.workspace.findUnique({
		where: { id: workspaceId },
		select: {
			id: true,
			organizationId: true,
			type: true,
			_count: { select: { documents: true } },
		},
	});
	return workspace
		? { ok: true, workspace }
		: { ok: false, status: 404, error: "Workspace not found" };
}

/** A turn ready for the model: its model, prompt, messages and sources. */
export interface PreparedWorkspaceChatTurn {
	model: LanguageModel;
	instructions: string;
	messages: Array<{ role: ChatRole; content: string }>;
	sources: WorkspaceDocumentSource[];
	getAnswerModel: () => AnswerModelInfo;
	/** Records the answer's model usage against the workspace's tenant. */
	recordAnswer: (usage: ModelUsage, latencyMs: number) => void;
}

type ModelUsage = Parameters<typeof logModelUsageAsync>[0]["usage"];

/**
 * Resolve the model and the embedding model for the workspace's tenant
 * (billing both), retrieve the passages the question matches and build the
 * prompt. A usage-limit refusal at resolution throws.
 */
export async function prepareWorkspaceChatTurn(args: {
	userId: string;
	workspace: WorkspaceChatWorkspace;
	message: string;
	history: ReadonlyArray<{ role: ChatRole; content: string }>;
	ragSettings?: { topK: number; similarityThreshold: number };
}): Promise<PreparedWorkspaceChatTurn> {
	const { userId, workspace, message } = args;
	const topK = args.ragSettings?.topK ?? 8;
	const minSimilarity = args.ragSettings?.similarityThreshold ?? 0.2;
	const workspaceId = workspace.id;
	// Use the workspace's actual organizationId (null for personal workspaces)
	const effectiveOrgId = workspace.organizationId || undefined;

	// Resolve AI access against the workspace's actual tenant, not the request payload.
	const {
		model: aiModel,
		metadata: aiMetadata,
		trackUsage: trackAiUsage,
	} = await getAIModelWithMetadata(
		{ taskType: "CHAT" },
		{
			userId,
			organizationId: effectiveOrgId,
			// A person is driving this request, so it may run on their own
			// ChatGPT plan where they turned it on.
			planEligible: true,
		},
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
		featureKey: "knowledge-search",
	});

	// Track embedding usage (fire-and-forget)
	trackEmbeddingUsage();

	// Generate embedding for the query
	console.log("[Workspace Chat] Generating query embedding...");
	const boundedQuery = boundQueryForEmbedding(message);
	const embeddingStart = Date.now();
	const { embedding: queryEmbedding, usage: embeddingUsage } = await embed({
		model: embeddingModel,
		value: boundedQuery,
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
		topK,
		minSimilarity,
	});
	const searchResults = await searchWorkspaceChunks({
		workspaceId,
		userId,
		organizationId: effectiveOrgId, // Use workspace's actual orgId, not request's
		queryEmbedding,
		querySparseVector: generateSparseVector(boundedQuery),
		topK,
		minSimilarity,
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
	const sources: WorkspaceDocumentSource[] = [];

	if (searchResults.length > 0) {
		// Build queries using documentId and chunkIndex (since Qdrant chunkId is ${documentId}-${chunkIndex})
		const chunkQueries = searchResults.map((r) => ({
			documentId: r.documentId,
			chunkIndex: r.chunkIndex,
		}));

		console.log("[Workspace Chat] Fetching chunks from DB:", chunkQueries);

		const chunks = await db.workspaceDocumentChunk.findMany({
			where: {
				OR: chunkQueries,
				document: { workspaceId },
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
		...args.history.map((h) => ({
			role: h.role,
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
		console.warn("[Workspace Chat] Fabric AI enhancement failed:", error);
	}

	return {
		model: aiModel,
		instructions: systemPrompt,
		messages,
		sources,
		getAnswerModel: () =>
			answerModelInfo(aiMetadata.answerSnapshot ?? aiMetadata),
		recordAnswer: (usage, latencyMs) =>
			logModelUsageAsync({
				context: { userId, organizationId: effectiveOrgId },
				metadata: aiMetadata,
				taskType: "CHAT",
				usage,
				latencyMs,
			}),
	};
}

/** What the model answers when it produced no text. */
export const EMPTY_WORKSPACE_CHAT_ANSWER =
	"I couldn't generate a response. Please try again.";
