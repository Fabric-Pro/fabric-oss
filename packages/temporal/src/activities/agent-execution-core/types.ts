/**
 * Agent Execution Types
 *
 * Shared type definitions for agent execution across workflows.
 */

/**
 * Knowledge source configuration
 */
export interface KnowledgeSourceConfig {
	/** Source type (workspace, integration, mcp) */
	type: string;
	/** Integration/config ID */
	integrationId?: string;
	/** Workspace ID for RAG */
	workspaceId?: string;
	/** Additional config */
	config?: Record<string, unknown>;
}

/**
 * Tool configuration for agent execution
 */
export interface ToolConfig {
	/** Tool name */
	name: string;
	/** Tool type (mcp, integration, builtin) */
	type: string;
	/** Integration/MCP config ID */
	configId?: string;
	/** Additional config */
	config?: Record<string, unknown>;
}

/**
 * Agent execution context
 */
export interface AgentExecutionContext {
	/** System prompt for the agent */
	systemPrompt: string;
	/** AI model identifier */
	model: string;
	/** Available tools */
	tools: ToolConfig[];
	/** Knowledge sources for RAG */
	knowledgeSources: KnowledgeSourceConfig[];
	/** Workspace IDs for document search */
	workspaceIds: string[];
	/** User ID */
	userId: string;
	/** Organization ID */
	organizationId?: string;
}

/**
 * Input for knowledge fetching
 */
export interface FetchKnowledgeInput {
	/** Knowledge sources to fetch from */
	knowledgeSources: KnowledgeSourceConfig[];
	/** Workspace IDs for document search */
	workspaceIds: string[];
	/** Query for semantic search */
	query: string;
	/** User ID */
	userId: string;
	/** Organization ID */
	organizationId?: string;
	/** Execution ID for Qdrant collection */
	executionId: string;
	/** Enable RAG indexing */
	enableRag?: boolean;
	/** Max results per source */
	maxResultsPerSource?: number;
}

/**
 * Retrieved knowledge chunk
 */
export interface KnowledgeChunk {
	/** Content text */
	content: string;
	/** Similarity score */
	similarity: number;
	/** Source information */
	source: {
		type: string;
		id: string;
		name?: string;
	};
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}

/**
 * Result from knowledge fetching
 */
export interface FetchKnowledgeResult {
	/** Retrieved knowledge chunks */
	chunks: KnowledgeChunk[];
	/** Qdrant collection ID if RAG was used */
	qdrantCollectionId?: string;
	/** Total chunks retrieved */
	totalChunks: number;
	/** Sources that were fetched */
	sourcesFetched: string[];
	/** Any errors encountered */
	errors?: Array<{ source: string; error: string }>;
}

/**
 * Tool call record
 */
export interface ToolCallRecord {
	/** Unique ID for this call */
	id: string;
	/** Tool name */
	name: string;
	/** Server/integration name */
	serverName?: string;
	/** Arguments passed to tool */
	args: Record<string, unknown>;
	/** Result from tool */
	result: unknown;
	/** Call status */
	status: "success" | "error" | "pending";
	/** Duration in milliseconds */
	durationMs: number;
}

/**
 * Input for agent turn execution
 */
export interface ExecuteAgentTurnInput {
	/** System prompt */
	systemPrompt: string;
	/** User message */
	userMessage: string;
	/** Retrieved knowledge context */
	knowledgeContext?: string;
	/** RAG collection for retrieval */
	qdrantCollectionId?: string;
	/** Available tools (MCP config IDs) */
	mcpConfigIds?: string[];
	/** Integration configurations for OAuth tool loading (Teams, GitHub) */
	integrationConfigurations?: Array<{
		integrationId: string;
		integrationType: string;
		allowedResources?: unknown;
	}>;
	/** AI model to use */
	model?: string;
	/** User ID */
	userId: string;
	/** Organization ID */
	organizationId?: string;
	/** Project ID for per-project AI usage attribution */
	projectId?: string;
	/** Max tool iterations */
	maxIterations?: number;
	/** Conversation history */
	conversationHistory?: Array<{
		role: "user" | "assistant";
		content: string;
	}>;
	/** Execution ID for real-time event publishing via Redis */
	executionId?: string;
	/** Optional image references for multimodal input */
	imageRefs?: Array<{
		storagePath: string;
		mimeType: string;
		name: string;
	}>;
	/** Built-in tool names to load (e.g., "image-generation") */
	builtInToolNames?: string[];
	/** Agent instance ID for capabilities that need scoped state (e.g. memory) */
	agentInstanceId?: string;
	/** Calling agent ID for run-agent delegation loop protection */
	callingAgentId?: string;
	/** Current run-agent recursion depth */
	currentDepth?: number;
}

/**
 * Result from agent turn execution
 */
export interface ExecuteAgentTurnResult {
	/** Agent's response text */
	response: string;
	/** Tool calls made during execution */
	toolCalls: ToolCallRecord[];
	/** Token usage */
	tokenUsage?: {
		inputTokens: number;
		outputTokens: number;
		totalCost?: number;
	};
	/** Whether execution completed successfully */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

/**
 * Extracted variable from execution
 */
export interface ExtractedVariable {
	name: string;
	value: unknown;
	setBy: string;
	setAt: string;
}
