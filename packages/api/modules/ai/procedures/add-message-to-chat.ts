import { ORPCError, streamToEventIterator } from "@orpc/client";
import {
	convertToModelMessages,
	generateChatTitle,
	getAggressiveStreamingConfig,
	getAIModelWithMetadata,
	getRAGProviderConfig,
	logModelUsageAsync,
	streamText,
} from "@repo/ai";
import {
	getAiChatByIdForOwner,
	getChatDocumentsByChatIdForOwner,
	hasPendingDocuments,
	hasReadyDocuments,
	updateAiChat,
} from "@repo/database";
import { formatContextForLLM, retrieveContext } from "@repo/rag";
import {
	getTemporalClient,
	type RagContextRetrievalInput,
} from "@repo/temporal";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

// Define UIMessage schema for input validation
// UIMessage from Vercel AI SDK has a parts array structure
// In AI SDK v6, parts can be various types: text, tool-call, tool-result, file, etc.
const UIMessageSchema = z.object({
	id: z.string(),
	role: z.enum(["user", "assistant", "system"]),
	parts: z.array(
		z
			.object({
				type: z.string(),
				// text is optional because some part types (tool-call, tool-result, etc.) don't have text
				text: z.string().optional(),
			})
			.passthrough(), // Allow additional properties for different part types
	),
	createdAt: z.union([z.date(), z.string().datetime()]).optional(),
});

export const addMessageToChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AI_CHAT))
	.route({
		method: "POST",
		path: "/ai/chats/{chatId}/messages",
		tags: ["AI"],
		summary: "Add message to chat",
		description:
			"Send all messages of the chat to the AI model to get a response",
	})
	.input(
		z.object({
			chatId: z.string(),
			messages: z.array(UIMessageSchema),
			model: z.string().optional(),
			documentIds: z.array(z.string()).optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { chatId, messages, model, documentIds } = input;
		const user = context.user;

		console.log("[AI] ========== ADD MESSAGE TO CHAT ==========");
		console.log(
			"[AI] Received messages:",
			JSON.stringify(messages, null, 2),
		);
		console.log("[AI] chatId:", chatId);
		console.log("[AI] documentIds:", documentIds);
		console.log("[AI] messages count:", messages.length);
		console.log(
			"[AI] messages structure:",
			JSON.stringify(messages, null, 2),
		);

		const chat = await getAiChatByIdForOwner(chatId, user.id);

		if (!chat) {
			throw new ORPCError("NOT_FOUND");
		}

		// Defense-in-depth: if the chat is scoped to an org, also verify
		// the caller is still a member. The per-user filter above already
		// enforces ownership; this closes the race where a chat outlives
		// its cascade-delete (e.g. workflow in-flight after removal).
		if (chat.organizationId) {
			const membership = await verifyOrganizationMembership(
				chat.organizationId,
				user.id,
			);

			if (!membership) {
				throw new ORPCError("FORBIDDEN");
			}
		}

		// Get AI model using centralized entry point
		// Handles provider resolution, API key decryption, and usage tracking
		console.log(
			"[AI] Getting AI model for user:",
			user.id,
			"org:",
			chat.organizationId,
		);

		let aiModelResult:
			| Awaited<ReturnType<typeof getAIModelWithMetadata>>
			| undefined;
		try {
			aiModelResult = await getAIModelWithMetadata(
				{
					taskType: "CHAT",
					modelOverride: model || undefined,
				},
				{
					userId: user.id,
					organizationId: chat.organizationId || undefined,
				},
			);
		} catch (error) {
			console.error("[AI] Failed to get AI model:", error);
			throw new ORPCError("BAD_REQUEST", {
				message:
					error instanceof Error
						? error.message
						: "No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
			});
		}

		const { model: aiModel, metadata, trackUsage } = aiModelResult;

		console.log("[AI] AI model resolved:", {
			modelString: metadata.modelString,
			provider: metadata.provider,
			source: metadata.selectionSource,
		});

		// Track usage (fire-and-forget)
		trackUsage();

		// Note: RAG operations fetch credentials internally - no apiKey needed here

		// RAG: Retrieve relevant context from uploaded documents
		// Check if chat has any documents (pending or ready)
		console.log(`[RAG] Checking for documents in chat ${chatId}`);

		// Debug: List all documents in this chat (scoped to caller)
		const allDocuments = await getChatDocumentsByChatIdForOwner(
			chatId,
			user.id,
		);
		console.log(
			`[RAG] Found ${allDocuments.length} total documents in chat:`,
			allDocuments.map((d) => ({
				id: d.id,
				filename: d.filename,
				status: d.status,
			})),
		);

		// Check if there are any pending/processing documents
		const hasPending = await hasPendingDocuments(chatId);
		console.log(`[RAG] hasPendingDocuments result: ${hasPending}`);

		// Extract user query from the last message (needed for both workflow and inline retrieval)
		const lastUserMessage = messages.filter((m) => m.role === "user").pop();

		const userQuery = lastUserMessage
			? (lastUserMessage.parts
					?.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join(" ") ?? "")
			: "";

		if (hasPending && userQuery) {
			// Documents are still processing - use workflow to wait and retrieve
			console.log(
				"[RAG] Documents are pending/processing, using workflow to wait and retrieve context",
			);

			try {
				// Get Temporal client
				const client = await getTemporalClient();

				// Create workflow ID (idempotent - same ID for same chat + message)
				const workflowId = `rag-context-${chatId}-${Date.now()}`;

				// Prepare workflow input
				// SECURITY: Credentials are fetched internally by the workflow activities
				const workflowInput: RagContextRetrievalInput = {
					chatId,
					userId: user.id,
					organizationId: chat.organizationId || undefined,
					query: userQuery,
					topK: 5,
					minSimilarity: 0.5, // Increased from 0.1 to 0.5 for better relevance (cosine similarity)
					documentIds, // Pass specific document IDs if provided
				};

				if (documentIds && documentIds.length > 0) {
					console.log(
						"[RAG] Filtering by specific documents:",
						documentIds,
					);
				}

				console.log("[RAG] Starting RAG context retrieval workflow");
				console.log("[RAG] Workflow ID:", workflowId);

				// Start workflow and wait for result
				const handle = await client.workflow.start(
					"ragContextRetrievalWorkflow",
					withCorrelationMemo({
						taskQueue: "document-processing",
						workflowId,
						args: [workflowInput],
						// Workflow execution timeout (max time for entire workflow)
						workflowExecutionTimeout: "2m",
					}),
				);

				console.log("[RAG] Workflow started, waiting for result");

				// Wait for workflow to complete and get result
				const result = await handle.result();

				console.log("[RAG] Workflow completed:", {
					success: result.success,
					chunkCount: result.chunkCount,
					documentsReady: result.documentsReady,
					contextLength: result.context.length,
				});

				// Inject context into system message if context was retrieved
				if (result.success && result.context) {
					console.log(
						`[RAG] Injecting workflow-retrieved context (${result.chunkCount} chunks)`,
					);

					// Add system message with RAG context
					messages.unshift({
						id: `context_${Date.now()}`,
						role: "system",
						parts: [
							{
								type: "text",
								text: result.context,
							},
						],
					});
				} else {
					console.log(
						"[RAG] Workflow returned empty context or failed, proceeding without RAG",
					);
				}
			} catch (error) {
				console.error("[RAG] Failed to execute workflow:", error);
				// Continue without RAG context - don't block the chat
			}
		} else {
			// No pending documents - use inline retrieval (existing logic)
			const hasDocuments = await hasReadyDocuments(chatId);
			console.log(`[RAG] hasReadyDocuments result: ${hasDocuments}`);

			if (hasDocuments && userQuery) {
				console.log(
					"[RAG] Chat has ready documents, attempting inline retrieval",
				);
				if (documentIds && documentIds.length > 0) {
					console.log(
						"[RAG] Filtering by specific documents:",
						documentIds,
					);
				}

				try {
					// Get API key for inline RAG retrieval
					// This is an API procedure (not Temporal workflow), so fetching key here is safe
					const ragConfig = await getRAGProviderConfig({
						userId: user.id,
						organizationId: chat.organizationId || undefined,
					});

					// Retrieve relevant chunks from vector database
					// Very low threshold (0.1) for better recall when documents are attached
					// This ensures we retrieve context even for generic queries like "summarize"
					const relevantChunks = await retrieveContext({
						chatId,
						userId: user.id,
						organizationId: chat.organizationId || undefined,
						query: userQuery,
						topK: 5,
						minSimilarity: 0.1, // Very low threshold for testing
						apiKey: ragConfig.apiKey, // Fetched from database
						documentIds, // Pass specific document IDs if provided
						// User-attached documents for this chat message: drop the
						// similarity floor (when documentIds are present) so the
						// attached content always reaches the model.
						explicitAttachment: true,
					});

					// Inject context into system message if relevant chunks found
					if (relevantChunks.length > 0) {
						console.log(
							`[RAG] Found ${relevantChunks.length} relevant chunks, injecting into context`,
						);

						// If specific documentIds were provided, this is a follow-up message with new documents
						const isNewDocument =
							documentIds && documentIds.length > 0;
						if (isNewDocument) {
							console.log(
								"[RAG] New document(s) attached - emphasizing newly uploaded content",
							);
						}

						const contextContent = formatContextForLLM(
							relevantChunks,
							{
								isNewDocument,
								documentIds,
							},
						);

						// Add system message with context at the beginning
						messages.unshift({
							id: `context_${Date.now()}`,
							role: "system",
							parts: [
								{
									type: "text",
									text: contextContent,
								},
							],
						});
					} else {
						console.log("[RAG] No relevant chunks found");
					}
				} catch (error) {
					console.error("[RAG] Failed to retrieve context:", error);
					// Continue without RAG context - don't block the chat
				}
			} else {
				console.log(
					"[RAG] No ready documents or no query, skipping retrieval",
				);
			}
		}

		// Model is already resolved from getAIModelWithMetadata
		const resolvedModel = metadata.modelString;
		const modelSelectionSource = metadata.selectionSource;

		console.log(
			`[AI] Using model: ${resolvedModel} (source: ${modelSelectionSource})`,
		);

		// Stream the response for real-time UX
		// No artificial delays - let Groq's fast inference stream at full speed (up to 1000 tokens/sec)
		// IMPORTANT: Disable content encoding to prevent proxy buffering (Vercel AI SDK best practice)
		console.log(
			"[AI] Starting streaming with model:",
			resolvedModel,
			`(source: ${modelSelectionSource})`,
		);
		console.log("[AI] Messages to send (including RAG context if any):", {
			messageCount: messages.length,
			hasSystemMessage: messages.some((m) => m.role === "system"),
		});

		let response: ReturnType<typeof streamText>;
		const streamStart = Date.now();
		try {
			response = streamText({
				model: aiModel,
				messages: await convertToModelMessages(messages as any),
				// Apply aggressive streaming configuration to prevent paragraph buffering
				...getAggressiveStreamingConfig(resolvedModel).aiConfig,
				async onFinish({ text, usage }) {
					const updatedMessages = [
						...messages,
						{
							role: "assistant",
							parts: [{ type: "text", text }],
						},
					];

					// Generate title if this is the first message exchange (no existing title)
					// Filter out system messages (RAG context) when checking message count
					const nonSystemMessages = messages.filter(
						(m) => m.role !== "system",
					);
					let title = chat.title;
					if (
						!title &&
						nonSystemMessages.length === 1 &&
						nonSystemMessages[0].role === "user"
					) {
						// Extract text from the first user message
						const firstUserMessage =
							nonSystemMessages[0].parts
								?.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join(" ") ?? "";

						if (firstUserMessage) {
							// Direct title generation (no workflow)
							try {
								title = await generateChatTitle(
									firstUserMessage,
									{
										userId: user.id,
										organizationId:
											chat.organizationId || undefined,
										projectId: chat.projectId || undefined,
									},
								);
							} catch (error) {
								console.error(
									"Failed to generate chat title:",
									error,
								);
								// Fallback to truncated message
								title = firstUserMessage.substring(0, 50);
								if (title.length === 50) {
									title += "...";
								}
							}
						}
					}

					// Save messages and title to database
					await updateAiChat({
						id: chatId,
						messages: updatedMessages,
						title: title ?? undefined,
					});
					logModelUsageAsync({
						context: {
							userId: user.id,
							organizationId: chat.organizationId || undefined,
						},
						metadata,
						taskType: "CHAT",
						usage,
						latencyMs: Date.now() - streamStart,
						conversationId: chatId,
						projectId: chat.projectId || undefined,
					});
				},
			});
			console.log("[AI] Successfully created streamText response");
		} catch (error) {
			console.error("[AI] Failed to create streamText:", error);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: `Failed to generate AI response: ${error instanceof Error ? error.message : "Unknown error"}`,
			});
		}

		return streamToEventIterator(response.toUIMessageStream());
	});
