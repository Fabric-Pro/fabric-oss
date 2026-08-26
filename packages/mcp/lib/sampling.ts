/**
 * MCP Sampling Support
 *
 * Enables Fabric MCP clients to provide LLM access to MCP servers.
 * When an MCP server requests a completion via sampling/createMessage,
 * the client uses Fabric's AI providers to fulfill the request.
 *
 * This follows the MCP specification where:
 * - Sampling is a CLIENT capability
 * - Servers REQUEST completions FROM clients
 * - Clients have full discretion over model selection
 *
 * Model names are sourced from the AI Model Catalog (single source of truth).
 *
 * @see https://modelcontextprotocol.io/specification/2025-06-18/client/sampling
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	type CreateMessageRequest,
	CreateMessageRequestSchema,
	type CreateMessageResult,
	type ModelPreferences,
	type SamplingMessage,
} from "@modelcontextprotocol/sdk/types.js";

// Import from the AI Model Catalog - single source of truth for model names
import {
	DEFAULT_MODELS,
	MODEL_ALIASES,
} from "@repo/database/prisma/ai-model-catalog";
import type { AIProvider } from "@repo/database/prisma/generated/client";

// ============================================================================
// Types
// ============================================================================

export interface SamplingConfig {
	/** User ID for AI provider resolution */
	userId: string;
	/** Organization ID for AI provider resolution */
	organizationId?: string;
	/** Default model to use if server doesn't specify preferences */
	defaultModel?: string;
	/** Maximum tokens to generate (default: 4096) */
	maxTokens?: number;
	/** Whether to require user approval for sampling requests (default: false) */
	requireApproval?: boolean;
	/** Callback to request user approval */
	onApprovalRequired?: (request: SamplingApprovalRequest) => Promise<boolean>;
	/** Callback when sampling starts (for UI feedback) */
	onSamplingStart?: (request: CreateMessageRequest) => void;
	/** Callback when sampling completes (for UI feedback) */
	onSamplingComplete?: (result: CreateMessageResult) => void;
}

export interface SamplingApprovalRequest {
	/** The server's message/prompt */
	messages: SamplingMessage[];
	/** Model preferences from server */
	modelPreferences?: ModelPreferences;
	/** System prompt if provided */
	systemPrompt?: string;
	/** Server name for display */
	serverName?: string;
}

export interface SamplingHandler {
	/** Handle a sampling request from an MCP server */
	handleSamplingRequest: (
		params: CreateMessageRequest["params"],
	) => Promise<CreateMessageResult>;
}

export interface SamplingClientOptions {
	/** Server URL */
	serverUrl: string;
	/** Transport type */
	transport: "HTTP" | "SSE";
	/** Authentication headers */
	headers?: Record<string, string>;
	/** Client name */
	name?: string;
	/** Client version */
	version?: string;
	/** Sampling configuration */
	sampling?: SamplingConfig;
}

export interface SamplingMcpClient {
	/** The underlying MCP client */
	client: Client;
	/** List available tools */
	tools: () => Promise<Record<string, unknown>>;
	/** Call a tool */
	callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
	/** Close the client */
	close: () => Promise<void>;
	/** Server name */
	serverName?: string;
}

// ============================================================================
// Model Selection
// ============================================================================

/**
 * Model mapping from hints to canonical model names.
 * Re-exported from the AI Model Catalog for backwards compatibility.
 * The actual provider-specific model ID is resolved at runtime based on the user's provider.
 */
const MODEL_HINTS_MAP = MODEL_ALIASES;

/**
 * Priority-based model selection (canonical names).
 * These are resolved to provider-specific IDs based on user's configured provider.
 */
const PRIORITY_MODELS = {
	speed: DEFAULT_MODELS.SIMPLE,
	intelligence: DEFAULT_MODELS.COMPLEX,
	cost: DEFAULT_MODELS.SIMPLE,
};

/**
 * Select the best model based on server preferences.
 * Returns a canonical model name - use getProviderModelId() to get provider-specific ID.
 */
export function selectModelFromPreferences(
	preferences?: ModelPreferences,
	defaultModel: string = DEFAULT_MODELS.CHAT,
): string {
	if (!preferences) {
		return defaultModel;
	}

	// Check hints first
	if (preferences.hints && preferences.hints.length > 0) {
		for (const hint of preferences.hints) {
			if (!hint.name) {
				continue;
			}
			const hintLower = hint.name.toLowerCase();

			// Check direct mapping
			if (MODEL_HINTS_MAP[hintLower]) {
				return MODEL_HINTS_MAP[hintLower];
			}

			// Check partial matches
			for (const [key, model] of Object.entries(MODEL_HINTS_MAP)) {
				if (hintLower.includes(key) || key.includes(hintLower)) {
					return model;
				}
			}
		}
	}

	// Check priorities (higher value = more important)
	const {
		speedPriority = 0,
		intelligencePriority = 0,
		costPriority = 0,
	} = preferences;

	// Find the highest priority
	const priorities = [
		{ name: "speed", value: speedPriority },
		{ name: "intelligence", value: intelligencePriority },
		{ name: "cost", value: costPriority },
	].sort((a, b) => b.value - a.value);

	const topPriority = priorities[0];
	if (topPriority.value > 0) {
		return PRIORITY_MODELS[
			topPriority.name as keyof typeof PRIORITY_MODELS
		];
	}

	return defaultModel;
}

// ============================================================================
// Sampling Handler Creation
// ============================================================================

/**
 * Creates a sampling handler that uses Fabric's AI providers
 */
export function createSamplingHandler(config: SamplingConfig): SamplingHandler {
	return {
		handleSamplingRequest: async (params) => {
			// Dynamically import @repo/ai to avoid circular dependencies
			const {
				generateText,
				getModel,
				getRAGProviderConfig,
				wrapModelWithUsageLogging,
			} = await import("@repo/ai");

			// Check if approval is required
			if (config.requireApproval && config.onApprovalRequired) {
				const approved = await config.onApprovalRequired({
					messages: params.messages,
					modelPreferences: params.modelPreferences,
					systemPrompt: params.systemPrompt,
				});

				if (!approved) {
					return {
						model: "rejected",
						role: "assistant" as const,
						content: {
							type: "text" as const,
							text: "Sampling request was rejected by the user.",
						},
						stopReason: "endTurn",
					};
				}
			}

			// Get AI provider configuration using centralized entry point
			const providerConfig = await getRAGProviderConfig({
				userId: config.userId,
				organizationId: config.organizationId,
			});

			// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
			const apiKey = providerConfig.apiKey;

			// Select model based on preferences
			const modelId = selectModelFromPreferences(
				params.modelPreferences,
				config.defaultModel,
			);

			// Get the model instance. MCP sampling resolves via getModel directly
			// (not getAIModelWithMetadata), so it would bypass the global usage
			// interceptor — wrap it explicitly so these calls are still counted.
			const rawModel = getModel(modelId, {
				userId: config.userId,
				organizationId: config.organizationId,
				apiKey,
				provider: providerConfig.provider || undefined,
				baseUrl: providerConfig.baseUrl,
			});
			const model = providerConfig.provider
				? wrapModelWithUsageLogging(rawModel, {
						userId: config.userId,
						organizationId: config.organizationId,
						// provider is typed string|null on RAGProviderConfig but is an
						// AIProvider value here; a bad value is caught by the logger.
						provider: providerConfig.provider as AIProvider,
						providerModelId: modelId,
					})
				: rawModel;

			// Convert MCP messages to AI SDK format
			const messages = params.messages.map((msg) => {
				const content = Array.isArray(msg.content)
					? msg.content
							.map((c) => {
								if (c.type === "text") {
									return c.text;
								}
								if (c.type === "image") {
									return `[Image: ${c.mimeType}]`;
								}
								return "[Unknown content]";
							})
							.join("\n")
					: msg.content.type === "text"
						? msg.content.text
						: "[Non-text content]";

				return {
					role: msg.role as "user" | "assistant",
					content,
				};
			});

			// Generate the response using prompt format (simpler, more compatible)
			const fullPrompt = [
				params.systemPrompt ? `System: ${params.systemPrompt}\n\n` : "",
				...messages.map(
					(m) =>
						`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`,
				),
			].join("\n\n");

			// The MCP protocol REQUIRES `params.maxTokens` on every
			// sampling/createMessage request — it is the server's declared output
			// ceiling and the source of truth. Fabric's `config.maxTokens` is a
			// server-side cap (documented default 4,096). Forward the smaller of
			// the two so the Vercel SDK sends an explicit `max_tokens` instead of
			// letting Databricks/Anthropic-direct silently truncate at their
			// injected defaults.
			//
			// Clamp whenever the request carries a finite number — including 0 or a
			// negative value: we must NEVER hand back a budget larger than the
			// client asked for, so let the provider reject an invalid request
			// honestly rather than silently substituting the (larger) config cap.
			// Fall back to the config cap ONLY when the required field is missing
			// entirely (undefined / NaN — a non-conformant client).
			const configuredMaxTokens = config.maxTokens ?? 4096;
			const requestedMaxTokens = params.maxTokens;
			const maxOutputTokens = Number.isFinite(requestedMaxTokens)
				? Math.min(requestedMaxTokens, configuredMaxTokens)
				: configuredMaxTokens;

			const result = await generateText({
				model,
				prompt: fullPrompt,
				maxOutputTokens,
			});

			// Map finish reason to the MCP-standard stop-reason values
			// (`endTurn` / `maxTokens` / `stopSequence`, per the installed
			// @modelcontextprotocol/sdk CreateMessageResult schema).
			const stopReasonMap: Record<string, string> = {
				stop: "endTurn",
				length: "maxTokens",
				"content-filter": "endTurn",
				"tool-calls": "endTurn",
			};

			const stopReason = stopReasonMap[result.finishReason] ?? "endTurn";

			return {
				model: modelId,
				role: "assistant" as const,
				content: {
					type: "text" as const,
					text: result.text,
				},
				stopReason,
			};
		},
	};
}

// ============================================================================
// Sampling-Enabled Client
// ============================================================================

/**
 * Creates an MCP client with sampling capability enabled.
 *
 * This client can:
 * 1. Connect to any MCP server
 * 2. Provide LLM access when the server requests sampling
 * 3. Use Fabric's AI providers for completions
 *
 * @example
 * ```typescript
 * const client = await createSamplingMcpClient({
 *   serverUrl: "https://mcp-server.example.com",
 *   transport: "HTTP",
 *   headers: { Authorization: "Bearer token" },
 *   sampling: {
 *     userId: "user-123",
 *     organizationId: "org-456",
 *     defaultModel: "anthropic/claude-sonnet-4-20250514",
 *   },
 * });
 *
 * // The server can now request LLM completions from this client
 * const tools = await client.tools();
 * ```
 */
export async function createSamplingMcpClient(
	options: SamplingClientOptions,
): Promise<SamplingMcpClient> {
	const {
		serverUrl,
		transport,
		headers = {},
		name = "fabric-mcp-client",
		version = "1.0.0",
		sampling,
	} = options;

	const url = new URL(serverUrl);

	// Create the appropriate transport
	const mcpTransport =
		transport === "SSE"
			? new SSEClientTransport(url, {
					requestInit:
						Object.keys(headers).length > 0
							? { headers }
							: undefined,
				})
			: new StreamableHTTPClientTransport(url, {
					requestInit:
						Object.keys(headers).length > 0
							? { headers }
							: undefined,
				});

	// Create client with sampling capability
	const client = new Client(
		{ name, version },
		{
			capabilities: {
				// Declare sampling capability so servers know we support it
				sampling: sampling ? {} : undefined,
			},
		},
	);

	// Set up sampling request handler if sampling is enabled
	if (sampling) {
		const handler = createSamplingHandler(sampling);

		client.setRequestHandler(
			CreateMessageRequestSchema,
			async (request) => {
				// Notify UI that sampling is starting
				sampling.onSamplingStart?.(request);

				try {
					const result = await handler.handleSamplingRequest(
						request.params,
					);

					// Notify UI that sampling completed
					sampling.onSamplingComplete?.(result);

					return result;
				} catch (error) {
					console.error(
						"[MCP Sampling] Error handling sampling request:",
						error,
					);
					throw error;
				}
			},
		);
	}

	// Connect to the server
	await client.connect(mcpTransport);

	// Create a wrapper that matches our interface
	return {
		client,

		tools: async () => {
			const result = await client.listTools();
			const tools: Record<string, unknown> = {};

			for (const tool of result.tools) {
				tools[tool.name] = {
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					execute: async (
						args: Record<string, unknown>,
						_context?: { toolCallId?: string },
					) => {
						const callResult = await client.callTool({
							name: tool.name,
							arguments: args,
						});
						return callResult;
					},
				};
			}

			return tools;
		},

		callTool: async (name: string, args: Record<string, unknown>) => {
			const result = await client.callTool({ name, arguments: args });
			return result;
		},

		close: async () => {
			await client.close();
		},
	};
}
