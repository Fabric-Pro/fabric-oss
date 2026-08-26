/**
 * Letta Client
 * HTTP client for communicating with Letta server
 * @see https://docs.letta.com
 */

import type {
	ArchivalMemoryEntry,
	ArchivalSearchResult,
	CreateIdentityConfig,
	LettaAgent,
	LettaAgentConfig,
	LettaClientOptions,
	LettaHealthStatus,
	LettaIdentity,
	LettaMessage,
	LettaMessageResponse,
	LettaTool,
	MemoryBlock,
} from "./types";

const DEFAULT_OPTIONS: Required<Omit<LettaClientOptions, "apiKey">> = {
	baseUrl: "http://localhost:8283",
	timeout: 60000,
	defaultModel: "openai/gpt-4o",
	defaultEmbeddingModel: "openai/text-embedding-3-small",
};

export class LettaClient {
	private options: LettaClientOptions & typeof DEFAULT_OPTIONS;

	constructor(
		options: LettaClientOptions = { baseUrl: DEFAULT_OPTIONS.baseUrl },
	) {
		this.options = { ...DEFAULT_OPTIONS, ...options };
	}

	/**
	 * Health check for Letta server
	 */
	async health(): Promise<LettaHealthStatus> {
		try {
			const response = await this.fetch("/v1/health");
			if (!response.ok) {
				return { healthy: false, error: `Status ${response.status}` };
			}
			const data = (await response.json()) as Record<string, unknown>;
			return { healthy: true, ...data };
		} catch (error) {
			return {
				healthy: false,
				error: error instanceof Error ? error.message : "Unknown error",
			};
		}
	}

	// =========================================================================
	// Agent Management
	// =========================================================================

	/**
	 * Create a new Letta agent
	 */
	async createAgent(config: LettaAgentConfig): Promise<LettaAgent> {
		const response = await this.fetch("/v1/agents", {
			method: "POST",
			body: JSON.stringify({
				name: config.name,
				description: config.description,
				model: config.model || this.options.defaultModel,
				embedding_model:
					config.embeddingModel || this.options.defaultEmbeddingModel,
				memory_blocks: config.memoryBlocks.map((b) => ({
					label: b.label,
					description: b.description,
					value: b.value,
					limit: b.limit,
					template: b.template,
					read_only: b.readOnly,
				})),
				tools: config.tools?.map((t) => t.name),
				system_prompt: config.systemPrompt,
				metadata: config.metadata,
				identity_ids: config.identityIds,
				block_ids: config.blockIds,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to create agent: ${error}`,
				"CREATE_AGENT_FAILED",
			);
		}

		return this.transformAgent(await response.json());
	}

	/**
	 * Get an agent by ID
	 */
	async getAgent(agentId: string): Promise<LettaAgent> {
		const response = await this.fetch(`/v1/agents/${agentId}`);

		if (!response.ok) {
			if (response.status === 404) {
				throw new LettaError(
					`Agent not found: ${agentId}`,
					"AGENT_NOT_FOUND",
				);
			}
			throw new LettaError(
				`Failed to get agent: ${response.statusText}`,
				"GET_AGENT_FAILED",
			);
		}

		return this.transformAgent(await response.json());
	}

	/**
	 * List all agents
	 */
	async listAgents(options?: {
		limit?: number;
		after?: string;
		identifierKeys?: string[];
	}): Promise<LettaAgent[]> {
		const params = new URLSearchParams();
		if (options?.limit) {
			params.set("limit", options.limit.toString());
		}
		if (options?.after) {
			params.set("after", options.after);
		}
		if (options?.identifierKeys && options.identifierKeys.length > 0) {
			params.set("identifier_keys", options.identifierKeys.join(","));
		}

		const response = await this.fetch(`/v1/agents?${params}`);

		if (!response.ok) {
			throw new LettaError(
				`Failed to list agents: ${response.statusText}`,
				"LIST_AGENTS_FAILED",
			);
		}

		const data = (await response.json()) as
			| { agents?: unknown[] }
			| unknown[];
		const agents = Array.isArray(data) ? data : data.agents || [];
		return agents.map((a: unknown) => this.transformAgent(a));
	}

	/**
	 * Find agent by metadata
	 */
	async findAgentByMetadata(
		metadata: Record<string, unknown>,
	): Promise<LettaAgent | null> {
		const agents = await this.listAgents({ limit: 100 });

		for (const agent of agents) {
			if (!agent.metadata) {
				continue;
			}

			const matches = Object.entries(metadata).every(
				([key, value]) => agent.metadata?.[key] === value,
			);

			if (matches) {
				return agent;
			}
		}

		return null;
	}

	/**
	 * Delete an agent
	 */
	async deleteAgent(agentId: string): Promise<void> {
		const response = await this.fetch(`/v1/agents/${agentId}`, {
			method: "DELETE",
		});

		if (!response.ok && response.status !== 204) {
			throw new LettaError(
				`Failed to delete agent: ${response.statusText}`,
				"DELETE_AGENT_FAILED",
			);
		}
	}

	// =========================================================================
	// Identity Management (Multi-Tenancy)
	// =========================================================================

	/**
	 * Create a new Identity for multi-tenancy
	 */
	async createIdentity(config: CreateIdentityConfig): Promise<LettaIdentity> {
		const response = await this.fetch("/v1/identities", {
			method: "POST",
			body: JSON.stringify({
				identifier_key: config.identifierKey,
				name: config.name,
				identity_type: config.identityType,
				agent_ids: config.agentIds,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to create identity: ${error}`,
				"CREATE_IDENTITY_FAILED",
			);
		}

		return (await response.json()) as LettaIdentity;
	}

	/**
	 * List identities with optional filtering
	 */
	async listIdentities(options?: {
		identifierKey?: string;
	}): Promise<LettaIdentity[]> {
		const params = new URLSearchParams();
		if (options?.identifierKey) {
			params.set("identifier_key", options.identifierKey);
		}

		const response = await this.fetch(`/v1/identities?${params}`);

		if (!response.ok) {
			throw new LettaError(
				`Failed to list identities: ${response.statusText}`,
				"LIST_IDENTITIES_FAILED",
			);
		}

		const data = await response.json();
		return Array.isArray(data) ? data : [];
	}

	/**
	 * Get a specific identity by ID
	 */
	async getIdentity(identityId: string): Promise<LettaIdentity> {
		const response = await this.fetch(`/v1/identities/${identityId}`);

		if (!response.ok) {
			throw new LettaError(
				`Failed to get identity: ${response.statusText}`,
				"GET_IDENTITY_FAILED",
			);
		}

		return (await response.json()) as LettaIdentity;
	}

	// =========================================================================
	// Message Management
	// =========================================================================

	/**
	 * Send a message to an agent
	 */
	async sendMessage(
		agentId: string,
		message: string,
		options?: {
			role?: "user" | "system";
			metadata?: Record<string, unknown>;
		},
	): Promise<LettaMessageResponse> {
		const response = await this.fetch(`/v1/agents/${agentId}/messages`, {
			method: "POST",
			body: JSON.stringify({
				messages: [
					{
						role: options?.role || "user",
						content: message,
					},
				],
				metadata: options?.metadata,
			}),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to send message: ${error}`,
				"SEND_MESSAGE_FAILED",
			);
		}

		return this.transformMessageResponse(await response.json());
	}

	/**
	 * Send a message with streaming response
	 */
	async *sendMessageStream(
		agentId: string,
		message: string,
		options?: { role?: "user" | "system" },
	): AsyncGenerator<LettaMessage> {
		const response = await this.fetch(
			`/v1/agents/${agentId}/messages/stream`,
			{
				method: "POST",
				headers: {
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					messages: [
						{
							role: options?.role || "user",
							content: message,
						},
					],
				}),
			},
		);

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to stream message: ${error}`,
				"STREAM_MESSAGE_FAILED",
			);
		}

		if (!response.body) {
			throw new LettaError(
				"No response body for stream",
				"NO_STREAM_BODY",
			);
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data && data !== "[DONE]") {
							try {
								yield this.transformMessage(JSON.parse(data));
							} catch {
								// Skip invalid JSON
							}
						}
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * Get message history for an agent
	 */
	async getMessages(
		agentId: string,
		options?: { limit?: number; before?: string },
	): Promise<LettaMessage[]> {
		const params = new URLSearchParams();
		if (options?.limit) {
			params.set("limit", options.limit.toString());
		}
		if (options?.before) {
			params.set("before", options.before);
		}

		const response = await this.fetch(
			`/v1/agents/${agentId}/messages?${params}`,
		);

		if (!response.ok) {
			throw new LettaError(
				`Failed to get messages: ${response.statusText}`,
				"GET_MESSAGES_FAILED",
			);
		}

		const data = (await response.json()) as
			| { messages?: unknown[] }
			| unknown[];
		const messages = Array.isArray(data) ? data : data.messages || [];
		return messages.map((m: unknown) => this.transformMessage(m));
	}

	// =========================================================================
	// Memory Block Management
	// =========================================================================

	/**
	 * Get a memory block by label
	 * First tries direct endpoint, then falls back to listing all blocks
	 */
	async getMemoryBlock(agentId: string, label: string): Promise<MemoryBlock> {
		// Try direct endpoint first
		const response = await this.fetch(
			`/v1/agents/${agentId}/core-memory/blocks/${label}`,
		);

		if (response.ok) {
			return response.json() as Promise<MemoryBlock>;
		}

		// If direct endpoint fails, try getting all blocks and filtering
		// This handles cases where the API routing differs
		if (response.status === 404) {
			try {
				const allBlocks = await this.getAllMemoryBlocks(agentId);
				const block = allBlocks.find((b) => b.label === label);
				if (block) {
					return block;
				}
			} catch {
				// Fall through to throw BLOCK_NOT_FOUND
			}
			throw new LettaError(
				`Memory block not found: ${label}`,
				"BLOCK_NOT_FOUND",
			);
		}

		throw new LettaError(
			`Failed to get memory block: ${response.statusText}`,
			"GET_BLOCK_FAILED",
		);
	}

	/**
	 * Update a memory block
	 * First tries by label, then falls back to finding block ID and updating via /v1/blocks/{id}
	 */
	async updateMemoryBlock(
		agentId: string,
		label: string,
		value: string,
	): Promise<MemoryBlock> {
		// Try direct endpoint first
		const response = await this.fetch(
			`/v1/agents/${agentId}/core-memory/blocks/${label}`,
			{
				method: "PATCH",
				body: JSON.stringify({ value }),
			},
		);

		if (response.ok) {
			return response.json() as Promise<MemoryBlock>;
		}

		// If direct endpoint fails with 404, try to find the block and update by ID
		if (response.status === 404) {
			try {
				const allBlocks = await this.getAllMemoryBlocks(agentId);
				const block = allBlocks.find((b) => b.label === label) as
					| (MemoryBlock & { id?: string })
					| undefined;

				if (block?.id) {
					// Update via block ID endpoint
					const blockResponse = await this.fetch(
						`/v1/blocks/${block.id}`,
						{
							method: "PATCH",
							body: JSON.stringify({ value }),
						},
					);

					if (blockResponse.ok) {
						return blockResponse.json() as Promise<MemoryBlock>;
					}
				}
			} catch {
				// Fall through to throw error
			}
		}

		const error = await response.text();
		throw new LettaError(
			`Failed to update memory block: ${error}`,
			"UPDATE_BLOCK_FAILED",
		);
	}

	/**
	 * Get all memory blocks for an agent
	 */
	async getAllMemoryBlocks(agentId: string): Promise<MemoryBlock[]> {
		const response = await this.fetch(
			`/v1/agents/${agentId}/core-memory/blocks`,
		);

		if (!response.ok) {
			throw new LettaError(
				`Failed to get memory blocks: ${response.statusText}`,
				"GET_BLOCKS_FAILED",
			);
		}

		const data = (await response.json()) as
			| { blocks?: MemoryBlock[] }
			| MemoryBlock[];
		return Array.isArray(data) ? data : data.blocks || [];
	}

	/**
	 * Create a new memory block for an agent
	 * Two-step process per Letta API:
	 * 1. Create standalone block via POST /v1/blocks
	 * 2. Attach block to agent via PATCH /v1/agents/{id}/core-memory/blocks/attach/{block_id}
	 */
	async createMemoryBlock(
		agentId: string,
		label: string,
		value: string,
		options?: { limit?: number; description?: string },
	): Promise<MemoryBlock> {
		// Step 1: Create standalone block
		const createResponse = await this.fetch("/v1/blocks", {
			method: "POST",
			body: JSON.stringify({
				label,
				value,
				limit: options?.limit || 10000,
				...(options?.description && {
					description: options.description,
				}),
			}),
		});

		if (!createResponse.ok) {
			const error = await createResponse.text();
			throw new LettaError(
				`Failed to create memory block: ${error}`,
				"CREATE_BLOCK_FAILED",
			);
		}

		const block = (await createResponse.json()) as MemoryBlock & {
			id?: string;
		};

		// Step 2: Attach block to agent
		if (block.id) {
			const attachResponse = await this.fetch(
				`/v1/agents/${agentId}/core-memory/blocks/attach/${block.id}`,
				{
					method: "PATCH",
				},
			);

			if (!attachResponse.ok) {
				const error = await attachResponse.text();

				// Check if attachment failed due to unique constraint (race condition)
				// Another concurrent process already attached a block with the same label
				if (
					error.includes("unique constraint") ||
					error.includes("already exists") ||
					error.includes("duplicate key")
				) {
					console.log(
						`[Letta] Block "${label}" attachment failed due to race condition, fetching existing block...`,
					);
					try {
						// Fetch the actually attached block (the one that won the race)
						const allBlocks =
							await this.getAllMemoryBlocks(agentId);
						console.log(
							`[Letta] Available blocks for agent: ${allBlocks.map((b) => b.label).join(", ") || "(none)"}`,
						);
						const existingBlock = allBlocks.find(
							(b) => b.label === label,
						);
						if (existingBlock) {
							// Clean up the orphaned block we created
							try {
								await this.fetch(`/v1/blocks/${block.id}`, {
									method: "DELETE",
								});
							} catch {
								// Ignore cleanup errors
							}
							return existingBlock;
						}
						// Block exists in DB (unique constraint) but API can't find it - corrupted state
						console.warn(
							`[Letta] Block "${label}" exists in DB but API returns different blocks. This is a Letta API issue.`,
						);
						// Clean up the orphaned block and return a mock
						try {
							await this.fetch(`/v1/blocks/${block.id}`, {
								method: "DELETE",
							});
						} catch {
							// Ignore cleanup errors
						}
						// Return a mock block marked as such
						return {
							label,
							value: "[]",
							limit: 10000,
							_isMock: true,
							_reason:
								"Block exists in DB but Letta API cannot find it",
						} as MemoryBlock & {
							_isMock?: boolean;
							_reason?: string;
						};
					} catch (fetchError) {
						console.warn(
							"[Letta] Failed to fetch blocks after race condition:",
							fetchError,
						);
						// Return a mock block
						return {
							label,
							value: "[]",
							limit: 10000,
							_isMock: true,
							_reason:
								"Failed to fetch blocks after race condition",
						} as MemoryBlock & {
							_isMock?: boolean;
							_reason?: string;
						};
					}
				}

				console.warn(
					`[Letta] Block created but failed to attach: ${error}`,
				);
				// Return the block anyway - it exists but isn't attached
			}
		}

		return block;
	}

	/**
	 * Get or create a memory block - creates it if it doesn't exist
	 * Handles various Letta API quirks including blocks that exist but can't be found directly
	 */
	async getOrCreateMemoryBlock(
		agentId: string,
		label: string,
		defaultValue: string,
		options?: { limit?: number; description?: string },
	): Promise<MemoryBlock> {
		try {
			return await this.getMemoryBlock(agentId, label);
		} catch (error) {
			if (
				error instanceof LettaError &&
				error.code === "BLOCK_NOT_FOUND"
			) {
				// Log available blocks for debugging
				try {
					const allBlocks = await this.getAllMemoryBlocks(agentId);
					console.log(
						`[Letta] Block "${label}" not found. Available blocks for agent ${agentId}:`,
						allBlocks.map((b) => b.label).join(", ") || "(none)",
					);
				} catch {
					// Ignore logging errors
				}

				try {
					return await this.createMemoryBlock(
						agentId,
						label,
						defaultValue,
						options,
					);
				} catch (createError) {
					// Check if creation failed because block already exists (unique constraint)
					const errorMessage =
						createError instanceof Error
							? createError.message
							: String(createError);
					if (
						errorMessage.includes("unique constraint") ||
						errorMessage.includes("already exists") ||
						errorMessage.includes("duplicate key")
					) {
						// Block exists in DB but API can't find it - this is a corrupted state
						// Try to detach and reattach by querying blocks directly
						console.warn(
							`[Letta] Block "${label}" exists in DB but API can't find it (corrupted state). Agent: ${agentId}`,
						);

						try {
							// Try listing all blocks (not agent-specific) and find by label
							const searchResponse = await this.fetch(
								`/v1/blocks?label=${encodeURIComponent(label)}`,
							);
							if (searchResponse.ok) {
								const blocksData =
									(await searchResponse.json()) as
										| MemoryBlock[]
										| { blocks?: MemoryBlock[] };
								const blocks = Array.isArray(blocksData)
									? blocksData
									: blocksData.blocks || [];
								console.log(
									`[Letta] Found ${blocks.length} blocks with label "${label}" globally`,
								);

								// Find the block that's supposedly attached to this agent
								// (We can't easily determine which one, so try them all)
								for (const existingBlock of blocks) {
									const blockWithId =
										existingBlock as MemoryBlock & {
											id?: string;
										};
									if (blockWithId.id) {
										// Try to get this block's value directly
										try {
											const blockResponse =
												await this.fetch(
													`/v1/blocks/${blockWithId.id}`,
												);
											if (blockResponse.ok) {
												const blockData =
													(await blockResponse.json()) as MemoryBlock;
												console.log(
													`[Letta] Retrieved block "${label}" directly via ID ${blockWithId.id}`,
												);
												return blockData;
											}
										} catch {
											// Try next block
										}
									}
								}
							}
						} catch (searchError) {
							console.warn(
								"[Letta] Failed to search global blocks:",
								searchError,
							);
						}
					}

					// If creation fails for other reasons, return a mock block so the caller can proceed
					console.warn(
						`[Letta] Could not create memory block "${label}" for agent ${agentId}, using in-memory fallback`,
					);
					return {
						label,
						value: defaultValue,
						limit: options?.limit || 10000,
						description: options?.description,
						_isMock: true, // Mark this as a mock block
					} as MemoryBlock & { _isMock?: boolean };
				}
			}
			throw error;
		}
	}

	// =========================================================================
	// Archival Memory
	// =========================================================================

	/**
	 * Insert into archival memory
	 */
	async insertArchivalMemory(
		agentId: string,
		content: string,
		metadata?: Record<string, unknown>,
	): Promise<ArchivalMemoryEntry> {
		const response = await this.fetch(`/v1/agents/${agentId}/archival`, {
			method: "POST",
			body: JSON.stringify({ content, metadata }),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to insert archival memory: ${error}`,
				"INSERT_ARCHIVAL_FAILED",
			);
		}

		return response.json() as Promise<ArchivalMemoryEntry>;
	}

	/**
	 * Search archival memory
	 */
	async searchArchivalMemory(
		agentId: string,
		query: string,
		options?: { limit?: number },
	): Promise<ArchivalSearchResult> {
		const params = new URLSearchParams({ query });
		if (options?.limit) {
			params.set("limit", options.limit.toString());
		}

		const response = await this.fetch(
			`/v1/agents/${agentId}/archival/search?${params}`,
		);

		if (!response.ok) {
			throw new LettaError(
				`Failed to search archival memory: ${response.statusText}`,
				"SEARCH_ARCHIVAL_FAILED",
			);
		}

		return response.json() as Promise<ArchivalSearchResult>;
	}

	/**
	 * Delete from archival memory
	 */
	async deleteArchivalMemory(
		agentId: string,
		entryId: string,
	): Promise<void> {
		const response = await this.fetch(
			`/v1/agents/${agentId}/archival/${entryId}`,
			{
				method: "DELETE",
			},
		);

		if (!response.ok && response.status !== 204) {
			throw new LettaError(
				`Failed to delete archival memory: ${response.statusText}`,
				"DELETE_ARCHIVAL_FAILED",
			);
		}
	}

	// =========================================================================
	// Tool Management
	// =========================================================================

	/**
	 * Attach tools to an agent
	 */
	async attachTools(agentId: string, tools: LettaTool[]): Promise<void> {
		const response = await this.fetch(`/v1/agents/${agentId}/tools`, {
			method: "POST",
			body: JSON.stringify({ tools: tools.map((t) => t.name) }),
		});

		if (!response.ok) {
			const error = await response.text();
			throw new LettaError(
				`Failed to attach tools: ${error}`,
				"ATTACH_TOOLS_FAILED",
			);
		}
	}

	/**
	 * Detach tools from an agent
	 */
	async detachTools(agentId: string, toolNames: string[]): Promise<void> {
		const response = await this.fetch(`/v1/agents/${agentId}/tools`, {
			method: "DELETE",
			body: JSON.stringify({ tools: toolNames }),
		});

		if (!response.ok && response.status !== 204) {
			throw new LettaError(
				`Failed to detach tools: ${response.statusText}`,
				"DETACH_TOOLS_FAILED",
			);
		}
	}

	// =========================================================================
	// Private Helpers
	// =========================================================================

	private async fetch(path: string, init?: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			this.options.timeout,
		);

		try {
			return await fetch(`${this.options.baseUrl}${path}`, {
				...init,
				signal: controller.signal,
				headers: {
					"Content-Type": "application/json",
					...(this.options.apiKey && {
						Authorization: `Bearer ${this.options.apiKey}`,
					}),
					...init?.headers,
				},
			});
		} finally {
			clearTimeout(timeoutId);
		}
	}

	private transformAgent(data: any): LettaAgent {
		return {
			id: data.id,
			name: data.name,
			description: data.description,
			model: data.model || data.llm_config?.model,
			embeddingModel:
				data.embedding_model || data.embedding_config?.model,
			memoryBlocks: data.memory_blocks || data.memory?.blocks || [],
			tools: data.tools || [],
			metadata: data.metadata,
			createdAt: data.created_at || new Date().toISOString(),
			updatedAt: data.updated_at || new Date().toISOString(),
		};
	}

	private transformMessage(data: any): LettaMessage {
		return {
			id: data.id || crypto.randomUUID(),
			role: data.role,
			content: data.content || data.text || "",
			toolCalls: data.tool_calls?.map((tc: any) => ({
				id: tc.id,
				name: tc.function?.name || tc.name,
				arguments:
					typeof tc.function?.arguments === "string"
						? JSON.parse(tc.function.arguments)
						: tc.function?.arguments || tc.arguments,
				result: tc.result,
			})),
			toolCallId: data.tool_call_id,
			createdAt: data.created_at || new Date().toISOString(),
		};
	}

	private transformMessageResponse(data: any): LettaMessageResponse {
		return {
			messages: (data.messages || []).map((m: any) =>
				this.transformMessage(m),
			),
			usage: data.usage
				? {
						promptTokens: data.usage.prompt_tokens,
						completionTokens: data.usage.completion_tokens,
						totalTokens: data.usage.total_tokens,
					}
				: undefined,
		};
	}
}

export class LettaError extends Error {
	code: string;

	constructor(message: string, code: string) {
		super(message);
		this.name = "LettaError";
		this.code = code;
	}
}

// Singleton client factory
let defaultClient: LettaClient | null = null;

export function getLettaClient(options?: LettaClientOptions): LettaClient {
	if (!defaultClient || options) {
		defaultClient = new LettaClient(options);
	}
	return defaultClient;
}
