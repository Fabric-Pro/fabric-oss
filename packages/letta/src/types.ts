/**
 * Letta Types
 * Types for Letta (formerly MemGPT) integration
 * @see https://docs.letta.com
 */

/**
 * Memory Block - A labeled piece of information in agent memory
 */
export interface MemoryBlock {
	label: string;
	description?: string;
	value: string;
	limit?: number;
	template?: string;
	readOnly?: boolean;
}

/**
 * Letta Identity - Multi-tenancy primitive
 * Each user or organization gets an Identity with a unique identifier_key
 */
export interface LettaIdentity {
	id: string;
	identifier_key: string;
	name?: string;
	identity_type: "user" | "org" | "other";
	agent_ids: string[];
	organization_id?: string;
	created_at: string;
}

/**
 * Configuration for creating a new Identity
 */
export interface CreateIdentityConfig {
	identifierKey: string;
	name?: string;
	identityType: "user" | "org" | "other";
	agentIds?: string[];
}

/**
 * Agent configuration for Letta
 */
export interface LettaAgentConfig {
	name: string;
	description?: string;
	model?: string;
	embeddingModel?: string;
	memoryBlocks: MemoryBlock[];
	tools?: LettaTool[];
	systemPrompt?: string;
	metadata?: Record<string, unknown>;
	identityIds?: string[];
	blockIds?: string[];
}

/**
 * Letta Agent representation
 */
export interface LettaAgent {
	id: string;
	name: string;
	description?: string;
	model: string;
	embeddingModel?: string;
	memoryBlocks: MemoryBlock[];
	tools: LettaTool[];
	metadata?: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

/**
 * Tool definition for Letta agents
 */
export interface LettaTool {
	name: string;
	description: string;
	parameters?: {
		type: string;
		properties: Record<
			string,
			{
				type: string;
				description?: string;
				enum?: string[];
			}
		>;
		required?: string[];
	};
}

/**
 * Message in Letta conversation
 */
export interface LettaMessage {
	id: string;
	role: "user" | "assistant" | "system" | "tool";
	content: string;
	toolCalls?: LettaToolCall[];
	toolCallId?: string;
	createdAt: string;
}

/**
 * Tool call in Letta
 */
export interface LettaToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	result?: string;
}

/**
 * Response from sending a message to Letta agent
 */
export interface LettaMessageResponse {
	messages: LettaMessage[];
	usage?: {
		promptTokens: number;
		completionTokens: number;
		totalTokens: number;
	};
}

/**
 * Archival memory entry
 */
export interface ArchivalMemoryEntry {
	id: string;
	content: string;
	embedding?: number[];
	metadata?: Record<string, unknown>;
	createdAt: string;
}

/**
 * Search result from archival memory
 */
export interface ArchivalSearchResult {
	entries: ArchivalMemoryEntry[];
	query: string;
	totalCount: number;
}

/**
 * Agent types for Fabric orchestrator
 */
export type FabricAgentType =
	| "orchestrator"
	| "tool_executor"
	| "document_generator"
	| "task_planner"
	| "code_executor";

/**
 * Shared memory block configuration
 */
export interface SharedMemoryConfig {
	organizationId: string;
	blockLabels: string[];
	syncInterval?: number;
}

/**
 * Tool result cache entry
 */
export interface ToolResultCache {
	toolName: string;
	result: unknown;
	cachedAt: string;
	expiresAt?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Agent memory state
 */
export interface AgentMemoryState {
	agentId: string;
	userId: string;
	organizationId?: string;
	memoryBlocks: Record<string, string>;
	toolResultCache: Record<string, ToolResultCache>;
	archivalMemoryCount: number;
	lastUpdated: string;
}

/**
 * Letta client options
 */
export interface LettaClientOptions {
	baseUrl: string;
	apiKey?: string;
	timeout?: number;
	defaultModel?: string;
	defaultEmbeddingModel?: string;
}

/**
 * Letta server health status
 */
export interface LettaHealthStatus {
	healthy: boolean;
	version?: string;
	uptime?: number;
	models?: string[];
	error?: string;
}
