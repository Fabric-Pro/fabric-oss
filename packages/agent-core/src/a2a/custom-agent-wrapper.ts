/**
 * Custom Agent A2A Wrapper
 *
 * Provides utilities to wrap custom agents (defined by users with system prompts,
 * MCP servers, and tools) with A2A protocol endpoints.
 *
 * This allows user-created custom agents to be discoverable and callable by the
 * orchestrator using the same A2A protocol as system agents.
 */

import { v4 as uuidv4 } from "uuid";
import type {
	A2AAgentExecutor,
	A2AExecutionResult,
	A2AStreamEvent,
} from "./server";
import type { A2AMessage, AgentSkill, Artifact } from "./types";

/**
 * Custom agent configuration stored in the database
 */
export interface CustomAgentConfig {
	/** Unique agent identifier */
	agentId: string;
	/** Display name */
	name: string;
	/** Description of what the agent does */
	description: string;
	/** System prompt that defines the agent's behavior */
	systemPrompt: string;
	/** MCP server configurations to connect to */
	mcpServers?: Array<{
		/** MCP config ID from database */
		configId: string;
		/** Server name for display */
		name: string;
		/** Server URL */
		url: string;
	}>;
	/** Additional tools the agent has access to */
	tools?: Array<{
		name: string;
		description: string;
		parameters?: Record<string, unknown>;
	}>;
	/** Model to use (defaults to gpt-4o) */
	model?: string;
	/** Temperature setting */
	temperature?: number;
	/** Tags for discovery */
	tags?: string[];
	/** Max tokens for response */
	maxTokens?: number;
}

/**
 * Generate skills from custom agent config
 */
export function generateSkillsFromConfig(
	config: CustomAgentConfig,
): AgentSkill[] {
	const skills: AgentSkill[] = [];

	// Create a primary skill based on the agent's description
	skills.push({
		id: `${config.agentId}-main`,
		name: config.name,
		description: config.description,
		tags: config.tags || [],
	});

	// Add skills from MCP servers
	if (config.mcpServers) {
		for (const mcp of config.mcpServers) {
			skills.push({
				id: `${config.agentId}-mcp-${mcp.configId}`,
				name: `${mcp.name} Tools`,
				description: `Access to ${mcp.name} MCP server tools`,
				tags: ["mcp", mcp.name.toLowerCase()],
			});
		}
	}

	// Add skills from custom tools
	if (config.tools) {
		for (const tool of config.tools) {
			skills.push({
				id: `${config.agentId}-tool-${tool.name}`,
				name: tool.name,
				description: tool.description,
				// Note: parameters schema is omitted as it's complex to convert
				tags: ["tool", tool.name.toLowerCase()],
			});
		}
	}

	return skills;
}

/**
 * Interface for the AI model executor
 * This allows dependency injection of the actual LLM implementation
 */
export interface CustomAgentModelExecutor {
	/**
	 * Generate text using the model
	 */
	generateText(options: {
		system: string;
		prompt: string;
		tools?: Record<string, unknown>;
		model?: string;
		temperature?: number;
		maxTokens?: number;
	}): Promise<{
		text: string;
		toolCalls?: Array<{
			name: string;
			args: Record<string, unknown>;
			result: unknown;
		}>;
	}>;

	/**
	 * Generate streaming text (optional)
	 */
	generateTextStream?(options: {
		system: string;
		prompt: string;
		tools?: Record<string, unknown>;
		model?: string;
		temperature?: number;
		maxTokens?: number;
	}): AsyncGenerator<{
		text?: string;
		toolCall?: {
			name: string;
			args: Record<string, unknown>;
			result: unknown;
		};
	}>;
}

/**
 * Interface for MCP client to get tools
 */
export interface CustomAgentMcpClient {
	/**
	 * Get tools from MCP server
	 */
	getTools(configId: string): Promise<Record<string, unknown>>;

	/**
	 * Close MCP connection
	 */
	close(configId: string): Promise<void>;
}

/**
 * Create an A2A executor for a custom agent
 *
 * @param config Custom agent configuration
 * @param modelExecutor The AI model executor implementation
 * @param mcpClient Optional MCP client for tool access
 * @returns A2A agent executor
 */
export function createCustomAgentA2AExecutor(
	config: CustomAgentConfig,
	modelExecutor: CustomAgentModelExecutor,
	mcpClient?: CustomAgentMcpClient,
): A2AAgentExecutor {
	return {
		async execute(
			message: A2AMessage,
			contextId?: string,
			metadata?: Record<string, unknown>,
		): Promise<A2AExecutionResult> {
			// Extract text from message
			const textPart = message.parts.find((p) => p.type === "text");
			const userMessage =
				textPart && "text" in textPart ? textPart.text : "";

			console.log(
				`[CustomAgent:${config.agentId}] Executing with message:`,
				userMessage.substring(0, 100),
			);

			// Gather tools from MCP servers
			const tools: Record<string, unknown> = {};
			const mcpConnections: string[] = [];

			if (mcpClient && config.mcpServers) {
				for (const mcp of config.mcpServers) {
					try {
						const mcpTools = await mcpClient.getTools(mcp.configId);
						for (const [name, def] of Object.entries(mcpTools)) {
							tools[name] = def;
						}
						mcpConnections.push(mcp.configId);
					} catch (error) {
						console.warn(
							`[CustomAgent:${config.agentId}] Failed to load tools from ${mcp.name}:`,
							error,
						);
					}
				}
			}

			// Add custom tools
			if (config.tools) {
				for (const tool of config.tools) {
					tools[tool.name] = {
						description: tool.description,
						inputSchema: tool.parameters,
					};
				}
			}

			// Build system prompt with context
			const systemPrompt = buildSystemPrompt(config, contextId, metadata);

			try {
				// Execute with model
				const result = await modelExecutor.generateText({
					system: systemPrompt,
					prompt: userMessage,
					tools: Object.keys(tools).length > 0 ? tools : undefined,
					model: config.model,
					temperature: config.temperature,
					maxTokens: config.maxTokens,
				});

				// Close MCP connections
				if (mcpClient) {
					for (const configId of mcpConnections) {
						try {
							await mcpClient.close(configId);
						} catch {}
					}
				}

				// Create artifacts from tool results if any
				const artifacts: Artifact[] = [];
				if (result.toolCalls && result.toolCalls.length > 0) {
					// Add tool call results as an artifact for transparency
					artifacts.push({
						id: uuidv4(),
						name: "tool-results",
						description:
							"Results from tool calls made during execution",
						mimeType: "application/json",
						parts: [
							{
								type: "data",
								data: {
									toolCalls: result.toolCalls.map((tc) => ({
										tool: tc.name,
										args: tc.args,
										result: tc.result,
									})),
								},
							},
						],
					});
				}

				return {
					response: result.text,
					artifacts,
					metadata: {
						agentId: config.agentId,
						model: config.model,
						toolCallCount: result.toolCalls?.length || 0,
					},
				};
			} catch (error) {
				// Close MCP connections on error
				if (mcpClient) {
					for (const configId of mcpConnections) {
						try {
							await mcpClient.close(configId);
						} catch {}
					}
				}
				throw error;
			}
		},

		async *executeStream(
			message: A2AMessage,
			contextId?: string,
			metadata?: Record<string, unknown>,
		): AsyncGenerator<A2AStreamEvent> {
			// If streaming is not supported by the model executor, fall back to non-streaming
			if (!modelExecutor.generateTextStream) {
				const result = await this.execute(message, contextId, metadata);
				yield { type: "text", text: result.response };
				if (result.artifacts) {
					for (const artifact of result.artifacts) {
						yield { type: "artifact", artifact };
					}
				}
				return;
			}

			// Extract text from message
			const textPart = message.parts.find((p) => p.type === "text");
			const userMessage =
				textPart && "text" in textPart ? textPart.text : "";

			console.log(
				`[CustomAgent:${config.agentId}] Streaming execution with message:`,
				userMessage.substring(0, 100),
			);

			// Gather tools from MCP servers
			const tools: Record<string, unknown> = {};
			const mcpConnections: string[] = [];

			if (mcpClient && config.mcpServers) {
				for (const mcp of config.mcpServers) {
					try {
						const mcpTools = await mcpClient.getTools(mcp.configId);
						for (const [name, def] of Object.entries(mcpTools)) {
							tools[name] = def;
						}
						mcpConnections.push(mcp.configId);
					} catch (error) {
						console.warn(
							`[CustomAgent:${config.agentId}] Failed to load tools from ${mcp.name}:`,
							error,
						);
					}
				}
			}

			// Add custom tools
			if (config.tools) {
				for (const tool of config.tools) {
					tools[tool.name] = {
						description: tool.description,
						inputSchema: tool.parameters,
					};
				}
			}

			// Build system prompt
			const systemPrompt = buildSystemPrompt(config, contextId, metadata);

			try {
				// Stream from model
				const stream = modelExecutor.generateTextStream({
					system: systemPrompt,
					prompt: userMessage,
					tools: Object.keys(tools).length > 0 ? tools : undefined,
					model: config.model,
					temperature: config.temperature,
					maxTokens: config.maxTokens,
				});

				const toolResults: Array<{
					name: string;
					args: Record<string, unknown>;
					result: unknown;
				}> = [];

				for await (const chunk of stream) {
					if (chunk.text) {
						yield { type: "text", text: chunk.text };
					}
					if (chunk.toolCall) {
						toolResults.push(chunk.toolCall);
					}
				}

				// Emit tool results as artifact
				if (toolResults.length > 0) {
					yield {
						type: "artifact",
						artifact: {
							id: uuidv4(),
							name: "tool-results",
							description:
								"Results from tool calls made during execution",
							mimeType: "application/json",
							parts: [
								{
									type: "data",
									data: {
										toolCalls: toolResults.map((tc) => ({
											tool: tc.name,
											args: tc.args,
											result: tc.result,
										})),
									},
								},
							],
						},
					};
				}
			} finally {
				// Close MCP connections
				if (mcpClient) {
					for (const configId of mcpConnections) {
						try {
							await mcpClient.close(configId);
						} catch {}
					}
				}
			}
		},
	};
}

/**
 * Build the system prompt for a custom agent
 */
function buildSystemPrompt(
	config: CustomAgentConfig,
	contextId?: string,
	metadata?: Record<string, unknown>,
): string {
	let prompt = config.systemPrompt;

	// Add context information if available
	if (contextId) {
		prompt += `\n\n[Session Context: ${contextId}]`;
	}

	// Add metadata context if available
	if (metadata) {
		const relevantMetadata: string[] = [];

		if (
			metadata.previousStepResults &&
			Array.isArray(metadata.previousStepResults)
		) {
			relevantMetadata.push(
				"Previous step results are available in the conversation context.",
			);
		}

		if (metadata.variables && typeof metadata.variables === "object") {
			const varNames = Object.keys(metadata.variables as object);
			if (varNames.length > 0) {
				relevantMetadata.push(
					`Available variables: ${varNames.join(", ")}`,
				);
			}
		}

		if (relevantMetadata.length > 0) {
			prompt += `\n\n[Context Information]\n${relevantMetadata.join("\n")}`;
		}
	}

	return prompt;
}

/**
 * Generate an A2A Agent Card for a custom agent
 */
export function generateAgentCard(
	config: CustomAgentConfig,
	baseUrl: string,
): {
	name: string;
	description: string;
	url: string;
	protocolVersion: string;
	capabilities: {
		streaming: boolean;
		pushNotifications: boolean;
		stateTransitionHistory: boolean;
	};
	skills: AgentSkill[];
	defaultInputModes: string[];
	defaultOutputModes: string[];
} {
	return {
		name: config.agentId,
		description: config.description,
		url: baseUrl,
		protocolVersion: "0.3.0",
		capabilities: {
			streaming: true,
			pushNotifications: false,
			stateTransitionHistory: true,
		},
		skills: generateSkillsFromConfig(config),
		defaultInputModes: ["text"],
		defaultOutputModes: ["text"],
	};
}
