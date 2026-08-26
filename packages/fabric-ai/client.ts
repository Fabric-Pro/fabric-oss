/**
 * Fabric AI REST API Client
 *
 * Client for interacting with the Fabric AI server.
 * Fabric is an open-source framework for augmenting humans using AI.
 * https://github.com/Fabric-Pro/fabric-ai
 *
 * Features:
 * - YouTube transcript extraction
 * - Pattern execution (summarize, extract_wisdom, analyze_claims, etc.)
 * - Streaming chat completions
 * - Pattern management
 */

import { DEFAULT_MODELS } from "@repo/database/prisma/ai-model-catalog";
import type {
	ChatPrompt,
	ChatRequest,
	ChatStreamEvent,
	ContextInfo,
	ContextsResponse,
	FabricConfig,
	FabricPattern,
	ModelInfo,
	PatternApplyRequest,
	ReadabilityResponse,
	StrategiesResponse,
	StrategyInfo,
	TemplatePluginRequest,
	TemplatePluginResponse,
	YouTubeCommentsResponse,
	YouTubeMetadataResponse,
	YouTubePlaylistResponse,
	YouTubeTranscriptRequest,
	YouTubeTranscriptResponse,
} from "./types";

const DEFAULT_TIMEOUT = 120000; // 2 minutes for long-running patterns

// Default model from catalog (canonical name matches OpenAI Direct model ID)
const DEFAULT_FABRIC_MODEL = DEFAULT_MODELS.COMPLEX;

export class FabricClient {
	private baseUrl: string;
	private apiKey?: string;
	private timeout: number;

	constructor(config: FabricConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
		this.apiKey = config.apiKey;
		this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
	}

	getBaseUrl(): string {
		return this.baseUrl;
	}

	getApiKey(): string | undefined {
		return this.apiKey;
	}

	private getHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};
		if (this.apiKey) {
			headers["X-API-Key"] = this.apiKey;
		}
		return headers;
	}

	private async fetch<T>(
		path: string,
		options: RequestInit = {},
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(url, {
				...options,
				headers: {
					...this.getHeaders(),
					...(options.headers || {}),
				},
				signal: controller.signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorBody = await response.text();
				let errorMessage: string;
				try {
					const errorJson = JSON.parse(errorBody);
					errorMessage = errorJson.error || errorBody;
				} catch {
					errorMessage = errorBody;
				}
				throw new Error(
					`Fabric API error (${response.status}): ${errorMessage}`,
				);
			}

			const contentType = response.headers.get("content-type");
			if (contentType?.includes("application/json")) {
				return response.json() as Promise<T>;
			}
			return response.text() as unknown as T;
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`Fabric API timeout after ${this.timeout}ms`);
			}
			throw error;
		}
	}

	/**
	 * Check if the Fabric server is healthy
	 */
	async healthCheck(): Promise<boolean> {
		try {
			await this.fetch<string[]>("/patterns/names");
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * List all available pattern names
	 */
	async listPatterns(): Promise<string[]> {
		return this.fetch<string[]>("/patterns/names");
	}

	/**
	 * Get pattern content by name
	 */
	async getPattern(name: string): Promise<string> {
		const response = await this.fetch<{
			Name: string;
			Description: string;
			Pattern: string;
		}>(`/patterns/${encodeURIComponent(name)}`);
		return response.Pattern;
	}

	/**
	 * Check if a pattern exists
	 */
	async patternExists(name: string): Promise<boolean> {
		try {
			const patterns = await this.listPatterns();
			return patterns.includes(name);
		} catch {
			return false;
		}
	}

	/**
	 * Apply a pattern to input text with optional variables
	 */
	async applyPattern(
		patternName: string,
		input: string,
		variables?: Record<string, string>,
	): Promise<string> {
		const request: PatternApplyRequest = { input, variables };
		return this.fetch<string>(
			`/patterns/${encodeURIComponent(patternName)}/apply`,
			{
				method: "POST",
				body: JSON.stringify(request),
			},
		);
	}

	/**
	 * Extract transcript from a YouTube video
	 *
	 * Uses yt-dlp under the hood to extract VTT subtitles.
	 *
	 * @param url - YouTube video URL
	 * @param timestamps - Include timestamps in format [HH:MM:SS]
	 * @param language - Language code (default: "en")
	 */
	async extractYouTubeTranscript(
		url: string,
		timestamps = false,
		language = "en",
	): Promise<YouTubeTranscriptResponse> {
		const request: YouTubeTranscriptRequest = { url, timestamps, language };
		return this.fetch<YouTubeTranscriptResponse>("/youtube/transcript", {
			method: "POST",
			body: JSON.stringify(request),
		});
	}

	/**
	 * Scrape a URL to clean, LLM-friendly markdown using Jina AI
	 *
	 * Uses https://r.jina.ai/{url} service internally.
	 *
	 * @param url - URL to scrape
	 */
	async scrapeUrl(url: string): Promise<string> {
		const response = await this.fetch<{ content: string; url: string }>(
			"/scrape",
			{
				method: "POST",
				body: JSON.stringify({ url }),
			},
		);
		return response.content;
	}

	/**
	 * Search the web and return results using Jina AI
	 *
	 * Uses https://s.jina.ai/{question} service internally.
	 *
	 * @param question - Search query
	 */
	async searchWeb(question: string): Promise<string> {
		const response = await this.fetch<{
			content: string;
			question: string;
		}>("/search", {
			method: "POST",
			body: JSON.stringify({ question }),
		});
		return response.content;
	}

	// =============================================================================
	// Delegated Endpoints (using X-AI-Token for credential exchange)
	// =============================================================================

	/**
	 * Search the web using delegated auth (user's Jina API key via token exchange)
	 *
	 * @param question - Search query
	 * @param aiToken - AI token for credential exchange
	 */
	async searchWebDelegated(
		question: string,
		aiToken: string,
	): Promise<string> {
		const response = await fetch(`${this.baseUrl}/delegated/search`, {
			method: "POST",
			headers: {
				...this.getHeaders(),
				"X-AI-Token": aiToken,
			},
			body: JSON.stringify({ question }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric delegated search error (${response.status}): ${errorBody}`,
			);
		}

		const result = (await response.json()) as {
			content: string;
			question: string;
		};
		return result.content;
	}

	/**
	 * Scrape a URL using delegated auth (user's Jina API key via token exchange)
	 *
	 * @param url - URL to scrape
	 * @param aiToken - AI token for credential exchange
	 */
	async scrapeUrlDelegated(url: string, aiToken: string): Promise<string> {
		const response = await fetch(`${this.baseUrl}/delegated/scrape`, {
			method: "POST",
			headers: {
				...this.getHeaders(),
				"X-AI-Token": aiToken,
			},
			body: JSON.stringify({ url }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric delegated scrape error (${response.status}): ${errorBody}`,
			);
		}

		const result = (await response.json()) as {
			content: string;
			url: string;
		};
		return result.content;
	}

	/**
	 * Execute a pattern with chat completions (non-streaming)
	 * Collects all streaming events and returns the final result
	 */
	async executePattern(options: {
		input: string;
		pattern: FabricPattern;
		vendor?: string;
		model?: string;
		variables?: Record<string, string>;
		context?: string;
		strategy?: string;
		temperature?: number;
	}): Promise<string> {
		const {
			input,
			pattern,
			vendor = "openai",
			model = DEFAULT_FABRIC_MODEL,
			variables,
			context,
			strategy,
			temperature = 0.7,
		} = options;

		const prompt: ChatPrompt = {
			userInput: input,
			vendor,
			model,
			patternName: pattern,
			contextName: context,
			strategyName: strategy,
			variables,
		};

		const request: ChatRequest = {
			prompts: [prompt],
			temperature,
		};

		// Fabric uses SSE streaming, we need to collect all chunks
		const response = await fetch(`${this.baseUrl}/chat`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric chat error (${response.status}): ${errorBody}`,
			);
		}

		// Parse SSE stream
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
			} catch (_e) {
				// Skip non-JSON lines (SSE metadata)
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
						// Ignore parse errors for SSE format variations
					}
				}
			}
		}

		return result;
	}

	/**
	 * Execute a pattern with streaming (returns async iterator)
	 */
	async *executePatternStream(options: {
		input: string;
		pattern: FabricPattern;
		vendor?: string;
		model?: string;
		variables?: Record<string, string>;
		context?: string;
		strategy?: string;
		temperature?: number;
	}): AsyncGenerator<ChatStreamEvent> {
		const {
			input,
			pattern,
			vendor = "openai",
			model = DEFAULT_FABRIC_MODEL,
			variables,
			context,
			strategy,
			temperature = 0.7,
		} = options;

		const prompt: ChatPrompt = {
			userInput: input,
			vendor,
			model,
			patternName: pattern,
			contextName: context,
			strategyName: strategy,
			variables,
		};

		const request: ChatRequest = {
			prompts: [prompt],
			temperature,
		};

		const response = await fetch(`${this.baseUrl}/chat`, {
			method: "POST",
			headers: this.getHeaders(),
			body: JSON.stringify(request),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric chat error (${response.status}): ${errorBody}`,
			);
		}

		if (!response.body) {
			throw new Error("No response body from Fabric API");
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
					const trimmed = line.trim();
					if (!trimmed) {
						continue;
					}

					try {
						// Try direct JSON parse first
						const event = JSON.parse(trimmed) as ChatStreamEvent;
						yield event;
					} catch {
						// Try SSE format
						if (trimmed.startsWith("data:")) {
							const data = trimmed.slice(5).trim();
							if (data) {
								try {
									const event = JSON.parse(
										data,
									) as ChatStreamEvent;
									yield event;
								} catch {
									// Ignore unparseable SSE data
								}
							}
						}
					}
				}
			}

			// Process remaining buffer
			if (buffer.trim()) {
				try {
					const event = JSON.parse(buffer.trim()) as ChatStreamEvent;
					yield event;
				} catch {
					// Ignore
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	/**
	 * List available AI models
	 */
	async listModels(): Promise<ModelInfo> {
		return this.fetch<ModelInfo>("/models/names");
	}

	/**
	 * List available strategies (Chain of Thought, etc.)
	 */
	async listStrategies(): Promise<StrategyInfo[]> {
		return this.fetch<StrategyInfo[]>("/strategies");
	}

	/**
	 * Get context content by name
	 */
	async getContext(name: string): Promise<string> {
		const response = await this.fetch<{ Name: string; Content: string }>(
			`/contexts/${encodeURIComponent(name)}`,
		);
		return response.Content;
	}

	/**
	 * List all context names
	 */
	async listContexts(): Promise<string[]> {
		return this.fetch<string[]>("/contexts/names");
	}

	// =========================================================================
	// Extended YouTube Methods (Delegated - require AI token)
	// =========================================================================

	/**
	 * Get comprehensive metadata for a YouTube video
	 *
	 * Includes title, description, channel, duration, view count, likes, tags.
	 * Uses delegated auth (user's YouTube API key via token exchange).
	 *
	 * @param url - YouTube video URL
	 * @param aiToken - AI token for credential exchange
	 */
	async getYouTubeMetadata(
		url: string,
		aiToken: string,
	): Promise<YouTubeMetadataResponse> {
		const response = await fetch(
			`${this.baseUrl}/delegated/youtube/metadata`,
			{
				method: "POST",
				headers: {
					...this.getHeaders(),
					"X-AI-Token": aiToken,
				},
				body: JSON.stringify({ url }),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric YouTube metadata error (${response.status}): ${errorBody}`,
			);
		}

		return (await response.json()) as YouTubeMetadataResponse;
	}

	/**
	 * Get comments from a YouTube video
	 *
	 * Returns top-level comments with replies indented.
	 * Uses delegated auth (user's YouTube API key via token exchange).
	 *
	 * @param url - YouTube video URL
	 * @param aiToken - AI token for credential exchange
	 */
	async getYouTubeComments(
		url: string,
		aiToken: string,
	): Promise<YouTubeCommentsResponse> {
		const response = await fetch(
			`${this.baseUrl}/delegated/youtube/comments`,
			{
				method: "POST",
				headers: {
					...this.getHeaders(),
					"X-AI-Token": aiToken,
				},
				body: JSON.stringify({ url }),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric YouTube comments error (${response.status}): ${errorBody}`,
			);
		}

		return (await response.json()) as YouTubeCommentsResponse;
	}

	/**
	 * Get all videos from a YouTube playlist
	 *
	 * Returns video IDs, titles, and URLs for all videos in the playlist.
	 * Uses delegated auth (user's YouTube API key via token exchange).
	 *
	 * @param url - YouTube playlist URL
	 * @param aiToken - AI token for credential exchange
	 */
	async getYouTubePlaylist(
		url: string,
		aiToken: string,
	): Promise<YouTubePlaylistResponse> {
		const response = await fetch(
			`${this.baseUrl}/delegated/youtube/playlist`,
			{
				method: "POST",
				headers: {
					...this.getHeaders(),
					"X-AI-Token": aiToken,
				},
				body: JSON.stringify({ url }),
			},
		);

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Fabric YouTube playlist error (${response.status}): ${errorBody}`,
			);
		}

		return (await response.json()) as YouTubePlaylistResponse;
	}

	// =========================================================================
	// HTML Readability Methods
	// =========================================================================

	/**
	 * Extract clean, readable content from raw HTML
	 *
	 * Uses the go-readability library to extract the main article content,
	 * removing navigation, ads, and other non-content elements.
	 *
	 * @param html - Raw HTML content
	 * @param url - Optional source URL for context
	 */
	async extractReadableContent(
		html: string,
		url?: string,
	): Promise<ReadabilityResponse> {
		return this.fetch<ReadabilityResponse>("/readability", {
			method: "POST",
			body: JSON.stringify({ html, url }),
		});
	}

	// =========================================================================
	// Template Plugin Methods
	// =========================================================================

	/**
	 * Apply Fabric template plugins to a template string
	 *
	 * Supports the following plugin namespaces:
	 * - text: uppercase, lowercase, reverse, length, repeat
	 * - datetime: now, today, time, unix, rel:-1d, startofweek, etc.
	 * - file: read, lines, mtime
	 * - fetch: get:URL
	 * - sys: hostname, user, os, env:VAR, pwd
	 * - hash: sha256:string, sha256file:path
	 *
	 * Template syntax: {{plugin:namespace:operation:value}}
	 * Example: "Report generated on {{plugin:datetime:today}}"
	 *
	 * @param template - Template string with {{plugin:...}} placeholders
	 * @param variables - Optional variables for {{variableName}} substitution
	 * @param input - Optional input text for {{input}} placeholder
	 */
	async applyTemplate(
		template: string,
		variables?: Record<string, string>,
		input?: string,
	): Promise<TemplatePluginResponse> {
		const request: TemplatePluginRequest = { template, variables, input };
		return this.fetch<TemplatePluginResponse>("/template/apply", {
			method: "POST",
			body: JSON.stringify(request),
		});
	}

	// =========================================================================
	// Extended Strategies & Contexts Methods
	// =========================================================================

	/**
	 * Get all strategies with their full content
	 *
	 * Strategies are system-level prompts that define HOW to think.
	 * Example: "chain_of_thought", "socratic_method"
	 */
	async getStrategiesWithContent(): Promise<StrategiesResponse> {
		return this.fetch<StrategiesResponse>("/strategies");
	}

	/**
	 * Get a specific strategy by name with its content
	 */
	async getStrategy(
		name: string,
	): Promise<{ name: string; content: string }> {
		return this.fetch<{ name: string; content: string }>(
			`/strategies/${encodeURIComponent(name)}`,
		);
	}

	/**
	 * Get all contexts with their full content
	 *
	 * Contexts are user-defined background information that provides
	 * domain expertise or persona to the AI.
	 */
	async getContextsWithContent(): Promise<ContextsResponse> {
		return this.fetch<ContextsResponse>("/contexts");
	}

	/**
	 * Get a specific context by name with its content
	 */
	async getContextContent(name: string): Promise<ContextInfo> {
		return this.fetch<ContextInfo>(`/contexts/${encodeURIComponent(name)}`);
	}

	// =========================================================================
	// MCP CLI Methods - Dynamic MCP Server Discovery and Tool Execution
	// These methods enable agents to dynamically discover and interact with
	// MCP servers without loading all tool schemas upfront (~99% token reduction).
	// Requires mcp-cli to be installed on the Fabric AI server.
	// NOTE: These use non-delegated endpoints (no AI token required).
	// =========================================================================

	/**
	 * List all available MCP servers and their tools
	 *
	 * @param withDescriptions - Include tool descriptions (uses more tokens)
	 * @returns List of servers with their tools
	 */
	async mcpCliList(withDescriptions = false): Promise<McpCliListResponse> {
		return this.fetch<McpCliListResponse>("/mcp-cli/list", {
			method: "POST",
			body: JSON.stringify({ withDescriptions }),
		});
	}

	/**
	 * Search for MCP tools by glob pattern across all servers
	 *
	 * @param pattern - Glob pattern to search for (e.g., '*file*', '*search*')
	 * @param withDescriptions - Include tool descriptions
	 * @returns List of matching tools
	 */
	async mcpCliGrep(
		pattern: string,
		withDescriptions = false,
	): Promise<McpCliGrepResponse> {
		return this.fetch<McpCliGrepResponse>("/mcp-cli/grep", {
			method: "POST",
			body: JSON.stringify({ pattern, withDescriptions }),
		});
	}

	/**
	 * Get the full JSON schema for a specific MCP tool
	 *
	 * @param serverTool - Tool identifier in format 'server/tool'
	 * @returns Tool schema with parameter definitions
	 */
	async mcpCliSchema(serverTool: string): Promise<McpCliSchemaResponse> {
		return this.fetch<McpCliSchemaResponse>("/mcp-cli/schema", {
			method: "POST",
			body: JSON.stringify({ serverTool }),
		});
	}

	/**
	 * Execute an MCP tool with the given arguments
	 *
	 * @param serverTool - Tool identifier in format 'server/tool'
	 * @param args - Tool arguments as JSON object
	 * @returns Tool execution result
	 */
	async mcpCliCall(
		serverTool: string,
		args: Record<string, unknown> = {},
	): Promise<McpCliCallResponse> {
		return this.fetch<McpCliCallResponse>("/mcp-cli/call", {
			method: "POST",
			body: JSON.stringify({ serverTool, arguments: args }),
		});
	}
}

// =========================================================================
// MCP CLI Types
// =========================================================================

export interface McpCliToolInfo {
	name: string;
	server: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpCliServerInfo {
	name: string;
	tools: McpCliToolInfo[];
}

export interface McpCliListResponse {
	servers: McpCliServerInfo[];
	count: number;
}

export interface McpCliGrepResponse {
	tools: McpCliToolInfo[];
	count: number;
}

export interface McpCliSchemaResponse {
	name: string;
	server: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpCliCallResponse {
	content: unknown;
	isError?: boolean;
	error?: string;
}

/**
 * Create a Fabric client from environment variables
 */
export function createFabricClient(
	overrides?: Partial<FabricConfig>,
): FabricClient {
	const baseUrl =
		overrides?.baseUrl ||
		process.env.FABRIC_AI_URL ||
		"http://localhost:8080";
	const apiKey = overrides?.apiKey || process.env.FABRIC_AI_API_KEY;
	const timeout =
		overrides?.timeout ||
		(process.env.FABRIC_AI_TIMEOUT
			? Number.parseInt(process.env.FABRIC_AI_TIMEOUT, 10)
			: undefined);

	return new FabricClient({
		baseUrl,
		apiKey,
		timeout,
	});
}
