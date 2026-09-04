/**
 * Shared types for Temporal workflows and activities
 */

/**
 * Workflow status enum matching Prisma schema
 */
export type WorkflowStatus =
	| "NONE"
	| "RUNNING"
	| "COMPLETED"
	| "FAILED"
	| "RETRYING"
	| "CANCELLED";

/**
 * Input for ChatTitleGenerationWorkflow
 */
export interface ChatTitleGenerationInput {
	chatId: string;
	firstMessage: string;
	userId: string;
	organizationId?: string;
}

/**
 * Output for ChatTitleGenerationWorkflow
 */
export interface ChatTitleGenerationOutput {
	success: boolean;
	title?: string;
	error?: string;
}

/**
 * Temporal client configuration
 */
export interface TemporalConfig {
	address: string;
	namespace: string;
	apiKey?: string; // For Temporal Cloud
	tls?: boolean;
}

/**
 * Input for DocumentProcessingWorkflow
 */
export interface DocumentProcessingInput {
	documentId: string;
	chatId: string;
	userId: string;
	organizationId?: string;
	extractionStrategy?:
		| "local-only"
		| "prefer-external"
		| "external-only"
		| "cost-optimized"
		| "quality-optimized";
}

/**
 * Output for DocumentProcessingWorkflow
 */
export interface DocumentProcessingOutput {
	success: boolean;
	documentId: string;
	chunkCount?: number;
	extractorUsed?: string;
	error?: string;
}

/**
 * Worker configuration
 */
export interface WorkerConfig {
	taskQueue: string;
	maxConcurrentActivityExecutionSize?: number;
	maxConcurrentWorkflowTaskExecutionSize?: number;
}

/**
 * Input for ChatMessageWorkflow
 */
export interface ChatMessageInput {
	chatId: string;
	userId: string;
	userMessage: string;
	model?: string;
	organizationId?: string;
	/** All messages in the chat including the new user message */
	allMessages: Array<{
		id?: string;
		role: "user" | "assistant" | "system";
		parts: Array<{ type: string; text: string }>;
	}>;
}

/**
 * Output for ChatMessageWorkflow
 */
export interface ChatMessageOutput {
	success: boolean;
	/** The AI assistant's response text */
	assistantMessage?: string;
	/** Generated title if this was the first message */
	title?: string;
	error?: string;
}

/**
 * Input for RagContextRetrievalWorkflow
 *
 * SECURITY: Credentials are fetched internally by activities.
 * API keys are NOT passed in workflow inputs to avoid storing them in Temporal history.
 */
export interface RagContextRetrievalInput {
	chatId: string;
	userId: string;
	organizationId?: string;
	query: string;
	topK?: number;
	minSimilarity?: number;
	/** Optional: Specific document IDs to retrieve context from (if not provided, searches all documents in chat) */
	documentIds?: string[];
}

/**
 * Output for RagContextRetrievalWorkflow
 */
export interface RagContextRetrievalOutput {
	success: boolean;
	/** Formatted RAG context string ready to inject as system message */
	context: string;
	/** Number of relevant chunks found */
	chunkCount: number;
	/** Whether documents were ready or timed out */
	documentsReady: boolean;
	error?: string;
}

/**
 * Input for ProjectDocumentGenerationWorkflow
 */
export interface ProjectDocumentGenerationInput {
	projectId: string;
	documentId: string;
	documentType: string;
	userId: string;
	organizationId?: string;
	aiToken: string; // Pre-issued AI token from API layer (where AI_TOKEN_SECRET is available)
	prompt: string;
	promptId?: string; // Optional custom prompt ID from Prompt Library
	promptVersionId?: string; // Specific prompt version ID for attribution tracking
	currentDocument?: string; // Current document content for regeneration (ensures fresh output)
	/**
	 * Source text the user supplied in the create flow, delivered straight to
	 * this run instead of being left to retrieval.
	 *
	 * Retrieval is similarity-scoped and, for content stored moments earlier,
	 * may not be indexed yet — so a run could silently ignore the very material
	 * the user just pasted. It arrives already neutralized, bounded, and wrapped
	 * in the shared attachment envelope by the API (`supplied-context.ts`); the
	 * workflow adds no escaping of its own and only joins it into the context
	 * array alongside what retrieval returns.
	 */
	suppliedContext?: string;
	/**
	 * The project context row created for this run, filtered out of this run's
	 * retrieval so the same words are not delivered twice — once directly and
	 * once through the corpus. Resolved server-side from the document, never
	 * accepted from a client.
	 */
	excludeContextId?: string;
}

/**
 * Output for ProjectDocumentGenerationWorkflow
 */
export interface ProjectDocumentGenerationOutput {
	success: boolean;
	documentId: string;
	documentContent?: string;
	error?: string;
	/** Evaluation result (if golden reference evaluation was run) */
	evaluation?: {
		passed: boolean;
		score: number;
		evalId?: string;
	};
}

// =============================================================================
// Direct Chat Workflow Types
// =============================================================================

/**
 * Tool call information for streaming
 */
export interface DirectChatToolCall {
	id: string;
	name: string;
	serverName?: string;
	args: Record<string, unknown>;
	result?: unknown;
	status: "pending" | "running" | "complete" | "error";
	error?: string;
	/** MCP App: ui:// resource URI for the interactive HTML UI (if tool has MCP App support) */
	mcpAppResourceUri?: string;
	/** MCP App: MCP config ID for proxying tool calls back to the server */
	mcpAppConfigId?: string;
}

/**
 * Workflow confirmation request (for workflow execution approval)
 */
export interface DirectChatWorkflowConfirmation {
	workflowId: string;
	workflowName: string;
	description?: string;
	message: string;
}

/**
 * Progress event emitted during workflow execution
 */
export interface DirectChatProgressEvent {
	type:
		| "started"
		| "text"
		| "tool_start"
		| "tool_result"
		| "workflow_confirmation"
		| "error"
		| "done";
	content?: string;
	toolCall?: DirectChatToolCall;
	confirmation?: DirectChatWorkflowConfirmation;
	error?: string;
}

/**
 * Input for DirectChatWorkflow
 *
 * SECURITY: API keys are NOT passed in workflow inputs to avoid storing
 * them in Temporal's workflow history. Activities fetch credentials
 * internally using getAIModelWithMetadata() or getSystemRAGProviderConfig().
 */
export interface DirectChatWorkflowInput {
	/** Unique execution ID for tracking */
	executionId: string;
	/** Agent template instance ID when the chat is bound to a specific instance */
	instanceId?: string;
	/** User's message */
	message: string;
	/** Conversation history */
	history: Array<{ role: "user" | "assistant"; content: string }>;
	/** User ID */
	userId: string;
	/** Organization ID (optional) */
	organizationId?: string;
	/** Reasoning mode: lite, balanced, pro */
	reasoningMode?: "lite" | "balanced" | "pro";
	/** Enabled MCP config IDs (optional filter) */
	enabledMcpConfigIds?: string[];
	/** Enabled Fabric built-in tool IDs (optional filter) */
	enabledFabricToolIds?: string[];
	/** RAG context (pre-fetched if documents attached) */
	ragContext?: string;
	/**
	 * Full text of files the user attached in *this* turn, one finished
	 * envelope entry per file, built by `buildAiChatAttachmentEntry`.
	 *
	 * Separate from `ragContext` and from `attachedDocumentIds` because it
	 * answers a different question. `attachedDocumentIds` says "these documents
	 * exist, go retrieve from them"; retrieval then returns whichever chunks
	 * happen to rank. This says "here is every word, the user just shared it".
	 * Tab-joined spreadsheet rows embed poorly, so retrieval alone is least
	 * reliable for exactly the format this was built for.
	 *
	 * Additive, never a replacement: the retrieval path still runs, and it is
	 * what covers a file too large to deliver whole.
	 */
	inlineAttachmentContexts?: string[];
	/** Chat ID for RAG context retrieval */
	chatId?: string;
	/**
	 * AgentConversation ID for persistent operation-result message.
	 * When set, the workflow's completion step appends a
	 * `role: "system"` system message via `postOperationResultActivity`.
	 * When undefined, the activity is skipped (non-`AgentConversation`
	 * surfaces — e.g. Nexus `AiChat` — retain today's transient
	 * behaviour). Distinct from `chatId` which references `AiChat`.
	 */
	conversationId?: string;
	/** Attached document IDs for RAG context retrieval */
	attachedDocumentIds?: string[];
	/** Custom system prompt to prepend/replace the default system instructions */
	systemPrompt?: string;
	/** Workspace IDs for workspace document RAG retrieval */
	workspaceIds?: string[];
	/** Optional document IDs to scope workspace retrieval to */
	workspaceDocumentIds?: string[];
	/** Attached project ID for project metadata injection and project RAG */
	projectId?: string;
	/** Model override — canonical model name to use instead of user's default (e.g. "gpt-4o", "claude-3-5-sonnet") */
	modelOverride?: string;
	/**
	 * When true, the activity skips all tool-calling (built-in + MCP). Used by
	 * the workflow's degraded retry after a tools-related failure (#1644).
	 */
	forceDisableTools?: boolean;
}

/**
 * Token usage information from AI SDK
 */
export interface TokenUsage {
	/** Input/prompt tokens */
	inputTokens?: number;
	/** Output/completion tokens */
	outputTokens?: number;
	/** Total tokens (input + output) */
	totalTokens?: number;
	/** Reasoning tokens (for reasoning models like o1) */
	reasoningTokens?: number;
	/** Cached input tokens */
	cachedInputTokens?: number;
}

/**
 * RAG source information for citations
 */
export interface DirectChatSource {
	/** Unique source ID */
	id: string;
	/** Document filename */
	title: string;
	/** Source type */
	type: "document" | "web" | "other";
	/** Relevant excerpt from the source */
	excerpt?: string;
	/** Similarity score (0-1) */
	similarity?: number;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Output for DirectChatWorkflow
 */
export interface DirectChatWorkflowOutput {
	success: boolean;
	/** Final assistant response text */
	responseText?: string;
	/** Final reasoning / thinking text emitted by the model before answering. */
	reasoningText?: string;
	/** Duration of the reasoning phase in milliseconds (from first reasoning delta to first answer delta). */
	reasoningDurationMs?: number;
	/** All tool calls made during execution */
	toolCalls?: DirectChatToolCall[];
	/** Pending workflow confirmation (if any) */
	pendingConfirmation?: DirectChatWorkflowConfirmation;
	/** Error message if failed */
	error?: string;
	/** Execution duration in milliseconds */
	durationMs?: number;
	/** Token usage from AI model */
	usage?: TokenUsage;
	/** RAG sources used to generate the response */
	sources?: DirectChatSource[];
}

/**
 * Progress update for DirectChatWorkflow (queryable state)
 */
export interface DirectChatProgressUpdate {
	/** Current phase of execution */
	phase:
		| "initializing"
		| "collecting_tools"
		| "generating_memory"
		| "retrieving_rag"
		| "generating_suggestions"
		| "executing_ai"
		| "completed"
		| "failed";
	/** Human-readable message about current status */
	message: string;
	/** Progress percentage (0-100) */
	progress: number;
	/** Current activity being executed */
	currentActivity?: string;
	/** Tool calls collected so far */
	toolCalls: DirectChatToolCall[];
	/** Response text generated so far */
	responseText?: string;
	/** Final reasoning / thinking text emitted by the model before answering. */
	reasoningText?: string;
	/** Duration of the reasoning phase in milliseconds (from first reasoning delta to first answer delta). */
	reasoningDurationMs?: number;
	/** Error message if failed */
	error?: string;
	/** Pending confirmation if any */
	pendingConfirmation?: DirectChatWorkflowConfirmation;
}

// =============================================================================
// Activity Heartbeat Types (for real-time progress streaming)
// =============================================================================

/**
 * Heartbeat details sent from activities for real-time progress updates.
 * These are sent every few seconds during long-running activities.
 */
export interface ActivityHeartbeatDetails {
	/** Current phase of execution */
	phase: string;
	/** Human-readable status message */
	message: string;
	/** Progress percentage (0-100) */
	progress: number;
	/** Tool calls in progress or completed */
	toolCalls: DirectChatToolCall[];
	/** Partial response text generated so far */
	responseText?: string;
	/** Final reasoning / thinking text emitted by the model before answering. */
	reasoningText?: string;
	/** Duration of the reasoning phase in milliseconds (from first reasoning delta to first answer delta). */
	reasoningDurationMs?: number;
	/** Timestamp of this heartbeat */
	timestamp: number;
}

/**
 * Orchestrator step heartbeat details for real-time step execution updates.
 */
export interface OrchestratorHeartbeatDetails {
	/** Current step ID being executed */
	stepId: string;
	/** Step description */
	stepDescription: string;
	/** Current phase within step execution */
	phase:
		| "loading_tools"
		| "building_context"
		| "executing"
		| "processing_results";
	/** Tool calls made during this step */
	toolCalls: Array<{
		id: string;
		name: string;
		serverName?: string;
		status: "pending" | "running" | "complete" | "error";
		args?: Record<string, unknown>;
		result?: unknown;
		error?: string;
		mcpAppResourceUri?: string;
		mcpAppConfigId?: string;
	}>;
	/** Partial response generated so far */
	partialResponse?: string;
	/** Timestamp of this heartbeat */
	timestamp: number;
}
