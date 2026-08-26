/**
 * Delegated Mode Executor for Fabric AI
 *
 * This module executes Fabric patterns by passing user credentials to Fabric AI
 * for per-request AI provider authentication. This requires a modified Fabric AI
 * server with the /chat/delegated endpoint.
 *
 * Benefits over Hybrid Mode:
 * - Single API call (no round-trip to fetch pattern)
 * - Fabric AI handles pattern loading, variable substitution
 * - Supports all Fabric AI features (strategies, contexts, etc.)
 * - User isolation maintained via per-request credentials
 *
 * Requirements:
 * - Fabric AI server with /chat/delegated endpoint
 * - User's decrypted API key passed per-request
 *
 * NOTE: This mode requires modifications to the Fabric AI server.
 * See: internal/server/delegated.go in the Fabric AI server repo (to be created)
 */

import {
	getAIModelWithMetadata,
	getRAGProviderConfig,
	logModelUsageAsync,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { createFabricClient } from "./client";
import type {
	ChatPrompt,
	ChatStreamEvent,
	DelegatedChatRequest,
	DelegatedCredentials,
	FabricConfig,
	FabricPattern,
} from "./types";

/**
 * Map AI provider to Fabric AI vendor name
 */
const PROVIDER_TO_FABRIC_VENDOR: Record<string, string> = {
	GROQ: "groq",
	OPENAI_DIRECT: "openai",
	ANTHROPIC_DIRECT: "anthropic",
	DEEPSEEK: "deepseek",
	MISTRAL_AI: "mistral",
	TOGETHER_AI: "together",
	OPENROUTER: "openrouter",
	XAI: "xai",
	PERPLEXITY: "perplexity",
	// Gateways - map to their underlying providers
	VERCEL_GATEWAY: "openai",
	AZURE_AI_FOUNDRY: "azure",
	AWS_BEDROCK: "bedrock",
	GOOGLE_VERTEX_AI: "gemini",
	// Databricks Model Serving is OpenAI-compatible.
	DATABRICKS: "openai",
};

/**
 * Map Fabric pattern categories to AI task types (same as hybrid-executor.ts)
 */
const PATTERN_TO_TASK_TYPE: Record<string, string> = {
	analyze_claims: "COMPLEX",
	analyze_threat_report: "COMPLEX",
	rate_content: "COMPLEX",
	summarize: "SIMPLE",
	extract_wisdom: "SIMPLE",
	extract_insights: "SIMPLE",
	create_summary: "SIMPLE",
	improve_writing: "CHAT",
	explain_code: "CHAT",
	find_hidden_message: "REASONING",
};

function getTaskTypeForPattern(pattern: FabricPattern): string {
	if (PATTERN_TO_TASK_TYPE[pattern]) {
		return PATTERN_TO_TASK_TYPE[pattern];
	}
	if (pattern.startsWith("analyze_")) {
		return "COMPLEX";
	}
	if (pattern.startsWith("rate_")) {
		return "COMPLEX";
	}
	if (pattern.startsWith("extract_")) {
		return "SIMPLE";
	}
	if (pattern.startsWith("summarize_")) {
		return "SIMPLE";
	}
	if (pattern.startsWith("create_")) {
		return "SIMPLE";
	}
	if (pattern.startsWith("improve_")) {
		return "CHAT";
	}
	if (pattern.startsWith("explain_")) {
		return "CHAT";
	}
	if (pattern.startsWith("find_")) {
		return "REASONING";
	}
	return "COMPLEX";
}

/**
 * User context for model resolution
 */
interface UserContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Options for delegated pattern execution
 */
export interface DelegatedExecutionOptions {
	/** The input content to process */
	input: string;
	/** The pattern name to execute */
	pattern: FabricPattern;
	/** Pattern variables to substitute */
	variables?: Record<string, string>;
	/** Optional context name to include */
	context?: string;
	/** Optional strategy name to use */
	strategy?: string;
	/** User context for model resolution */
	userContext: UserContext;
	/** Temperature for AI generation (0-1) */
	temperature?: number;
	/** Override the task type (otherwise inferred from pattern) */
	taskType?: string;
	/** Fabric AI config overrides */
	fabricConfig?: Partial<FabricConfig>;
}

/**
 * Result from delegated pattern execution
 */
export interface DelegatedExecutionResult {
	output: string;
	success: boolean;
	error?: string;
	metadata: {
		pattern: string;
		model: string;
		vendor: string;
		taskType: string;
		executionMode: "delegated";
	};
}

/**
 * Execute a Fabric pattern using delegated credentials (Delegated Mode)
 *
 * This passes the user's API credentials to Fabric AI for per-request
 * authentication. Fabric AI handles pattern loading and variable substitution.
 *
 * REQUIRES: Fabric AI server with /chat/delegated endpoint
 */
export async function executePatternDelegated(
	options: DelegatedExecutionOptions,
): Promise<DelegatedExecutionResult> {
	const {
		input,
		pattern,
		variables,
		context,
		strategy,
		userContext,
		temperature = 0.7,
		taskType: overrideTaskType,
		fabricConfig,
	} = options;

	try {
		// 1. Determine task type for model selection
		const taskType = overrideTaskType || getTaskTypeForPattern(pattern);

		// 2. Get AI model metadata using centralized entry point
		let modelResult:
			| Awaited<ReturnType<typeof getAIModelWithMetadata>>
			| undefined;
		try {
			modelResult = await getAIModelWithMetadata(
				{
					taskType: taskType as
						| "SIMPLE"
						| "COMPLEX"
						| "CHAT"
						| "TOOL_CALLING"
						| "REASONING"
						| "EMBEDDING",
				},
				{
					userId: userContext.userId,
					organizationId: userContext.organizationId,
				},
			);
		} catch (_error) {
			return {
				output: "",
				success: false,
				error: "No AI provider configured. Please set up your AI provider in Settings.",
				metadata: {
					pattern,
					model: "",
					vendor: "unknown",
					taskType,
					executionMode: "delegated",
				},
			};
		}

		const { metadata, trackUsage } = modelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// 3. Get raw credentials for delegated mode (passing to Fabric AI server)
		const providerConfig = await getRAGProviderConfig({
			userId: userContext.userId,
			organizationId: userContext.organizationId,
		});

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
		const apiKey = providerConfig.apiKey;
		const modelString = metadata.modelString;

		// 4. Parse model string to get provider and model
		const provider = metadata.provider || providerConfig.provider;
		const [providerPrefix, modelName] = modelString.includes("/")
			? modelString.split("/", 2)
			: [provider?.toLowerCase() || "openai", modelString];

		// 5. Map provider to Fabric vendor name
		const vendor =
			(provider ? PROVIDER_TO_FABRIC_VENDOR[provider] : undefined) ||
			providerPrefix ||
			"openai";

		// 6. Create Fabric client
		const fabricClient = createFabricClient(fabricConfig);
		const baseUrl = fabricClient.getBaseUrl();
		const fabricApiKey = fabricClient.getApiKey();

		// 7. Build delegated chat request
		const credentials: DelegatedCredentials = {
			vendor,
			apiKey,
			model: modelName || modelString,
			// Providers that require a workspace endpoint (Databricks, Azure) must
			// send their base URL; otherwise the server falls back to the vendor's
			// default host and the request fails with the wrong credentials.
			...(providerConfig.baseUrl
				? { baseUrl: providerConfig.baseUrl }
				: {}),
		};

		const prompt: ChatPrompt = {
			userInput: input,
			vendor,
			model: modelName || modelString,
			patternName: pattern,
			contextName: context,
			strategyName: strategy,
			variables,
		};

		const request: DelegatedChatRequest = {
			prompts: [prompt],
			temperature,
			credentials,
		};

		// 8. Call Fabric AI's delegated endpoint
		const delegatedStart = Date.now();
		const response = await fetch(`${baseUrl}/chat/delegated`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(fabricApiKey ? { "X-API-Key": fabricApiKey } : {}),
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorBody = await response.text();

			// Check if delegated mode is not supported
			if (response.status === 404) {
				return {
					output: "",
					success: false,
					error: "Delegated mode not supported by Fabric AI server. Please update Fabric AI or use hybrid mode.",
					metadata: {
						pattern,
						model: modelString,
						vendor,
						taskType,
						executionMode: "delegated",
					},
				};
			}

			throw new Error(
				`Fabric delegated API error (${response.status}): ${errorBody}`,
			);
		}

		// 9. Parse SSE stream response
		const text = await response.text();
		const lines = text.split("\n").filter((line) => line.trim());
		let result = "";

		for (const line of lines) {
			try {
				const event = JSON.parse(line) as ChatStreamEvent;
				if (event.type === "content") {
					result += event.content;
				} else if (event.type === "error") {
					throw new Error(`Fabric pattern error: ${event.content}`);
				}
			} catch {
				if (line.startsWith("data:")) {
					try {
						const data = line.slice(5).trim();
						if (data) {
							const event = JSON.parse(data) as ChatStreamEvent;
							if (event.type === "content") {
								result += event.content;
							}
						}
					} catch {
						// Ignore parse errors
					}
				}
			}
		}
		const estimatedInputTokens = Math.ceil(input.length / 4);
		const estimatedOutputTokens = Math.ceil(result.length / 4);
		logModelUsageAsync({
			context: {
				userId: userContext.userId,
				organizationId: userContext.organizationId,
			},
			metadata,
			taskType: taskType as any,
			usage: {
				inputTokens: estimatedInputTokens,
				outputTokens: estimatedOutputTokens,
				totalTokens: estimatedInputTokens + estimatedOutputTokens,
			},
			latencyMs: Date.now() - delegatedStart,
			projectId: userContext.projectId,
		});

		return {
			output: result,
			success: true,
			metadata: {
				pattern,
				model: modelString,
				vendor,
				taskType,
				executionMode: "delegated",
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Delegated pattern execution failed", {
			pattern,
			error: errorMessage,
		});
		return {
			output: "",
			success: false,
			error: errorMessage,
			metadata: {
				pattern,
				model: "unknown",
				vendor: "unknown",
				taskType: overrideTaskType || getTaskTypeForPattern(pattern),
				executionMode: "delegated",
			},
		};
	}
}

/**
 * Execute a Fabric pattern with streaming using delegated credentials
 */
export async function* executePatternDelegatedStream(
	options: DelegatedExecutionOptions,
): AsyncGenerator<{ type: "content" | "error" | "complete"; content: string }> {
	const {
		input,
		pattern,
		variables,
		context,
		strategy,
		userContext,
		temperature = 0.7,
		taskType: overrideTaskType,
		fabricConfig,
	} = options;

	try {
		// 1. Determine task type for model selection
		const taskType = overrideTaskType || getTaskTypeForPattern(pattern);

		// 2. Get AI model metadata using centralized entry point
		let modelResult:
			| Awaited<ReturnType<typeof getAIModelWithMetadata>>
			| undefined;
		try {
			modelResult = await getAIModelWithMetadata(
				{
					taskType: taskType as
						| "SIMPLE"
						| "COMPLEX"
						| "CHAT"
						| "TOOL_CALLING"
						| "REASONING"
						| "EMBEDDING",
				},
				{
					userId: userContext.userId,
					organizationId: userContext.organizationId,
				},
			);
		} catch (_error) {
			yield { type: "error", content: "No AI provider configured" };
			return;
		}

		const { metadata, trackUsage } = modelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// 3. Get raw credentials for delegated mode (passing to Fabric AI server)
		const providerConfig = await getRAGProviderConfig({
			userId: userContext.userId,
			organizationId: userContext.organizationId,
		});

		// providerConfig.apiKey is already decrypted by getRAGProviderConfig()
		const apiKey = providerConfig.apiKey;
		const modelString = metadata.modelString;
		const provider = metadata.provider || providerConfig.provider;

		const [providerPrefix, modelName] = modelString.includes("/")
			? modelString.split("/", 2)
			: [provider?.toLowerCase() || "openai", modelString];

		const vendor =
			(provider ? PROVIDER_TO_FABRIC_VENDOR[provider] : undefined) ||
			providerPrefix ||
			"openai";

		// 4. Create Fabric client
		const fabricClient = createFabricClient(fabricConfig);
		const baseUrl = fabricClient.getBaseUrl();
		const fabricApiKey = fabricClient.getApiKey();

		// 7. Build delegated chat request
		const credentials: DelegatedCredentials = {
			vendor,
			apiKey,
			model: modelName || modelString,
			// Providers that require a workspace endpoint (Databricks, Azure) must
			// send their base URL; otherwise the server falls back to the vendor's
			// default host and the request fails with the wrong credentials.
			...(providerConfig.baseUrl
				? { baseUrl: providerConfig.baseUrl }
				: {}),
		};

		const prompt: ChatPrompt = {
			userInput: input,
			vendor,
			model: modelName || modelString,
			patternName: pattern,
			contextName: context,
			strategyName: strategy,
			variables,
		};

		const request: DelegatedChatRequest = {
			prompts: [prompt],
			temperature,
			credentials,
		};

		// 6. Call delegated endpoint
		const delegatedStart = Date.now();
		const response = await fetch(`${baseUrl}/chat/delegated`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(fabricApiKey ? { "X-API-Key": fabricApiKey } : {}),
			},
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			if (response.status === 404) {
				yield {
					type: "error",
					content: "Delegated mode not supported by Fabric AI server",
				};
				return;
			}
			const errorBody = await response.text();
			yield { type: "error", content: `Fabric API error: ${errorBody}` };
			return;
		}

		if (!response.body) {
			yield { type: "error", content: "No response body from Fabric AI" };
			return;
		}

		// 7. Stream the response
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let streamedText = "";

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
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}

					try {
						const event = JSON.parse(trimmed) as ChatStreamEvent;
						if (event.type === "content") {
							streamedText += event.content;
							yield { type: "content", content: event.content };
						} else if (event.type === "error") {
							yield { type: "error", content: event.content };
						}
					} catch {
						if (trimmed.startsWith("data:")) {
							try {
								const data = trimmed.slice(5).trim();
								if (data) {
									const event = JSON.parse(
										data,
									) as ChatStreamEvent;
									if (event.type === "content") {
										streamedText += event.content;
										yield {
											type: "content",
											content: event.content,
										};
									}
								}
							} catch {
								// Ignore
							}
						}
					}
				}
			}
			const estimatedInputTokens = Math.ceil(input.length / 4);
			const estimatedOutputTokens = Math.ceil(streamedText.length / 4);
			logModelUsageAsync({
				context: {
					userId: userContext.userId,
					organizationId: userContext.organizationId,
				},
				metadata,
				taskType: taskType as any,
				usage: {
					inputTokens: estimatedInputTokens,
					outputTokens: estimatedOutputTokens,
					totalTokens: estimatedInputTokens + estimatedOutputTokens,
				},
				latencyMs: Date.now() - delegatedStart,
				projectId: userContext.projectId,
			});

			yield { type: "complete", content: "" };
		} finally {
			reader.releaseLock();
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		yield { type: "error", content: errorMessage };
	}
}

/**
 * Check if Fabric AI server supports delegated mode
 */
export async function isDelegatedModeSupported(
	fabricConfig?: Partial<FabricConfig>,
): Promise<boolean> {
	try {
		const fabricClient = createFabricClient(fabricConfig);
		const baseUrl = fabricClient.getBaseUrl();

		// Try OPTIONS request to check if endpoint exists
		const response = await fetch(`${baseUrl}/chat/delegated`, {
			method: "OPTIONS",
		});

		return response.ok || response.status === 405; // 405 = Method not allowed but endpoint exists
	} catch {
		return false;
	}
}
