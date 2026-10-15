/**
 * Fabric AI Activities
 *
 * Temporal activities for executing Fabric AI patterns.
 * Integrates with the Fabric AI REST API server.
 *
 * Features:
 * - YouTube transcript extraction
 * - Pattern execution (summarize, extract_wisdom, etc.)
 * - Three execution modes: hybrid, delegated, full
 * - Model-per-task-type selection based on user preferences
 *
 * Execution Modes:
 * - hybrid: Extract via Fabric AI, AI execution via user's provider (default, multi-tenant safe)
 * - delegated: Full Fabric AI with per-request credentials (requires Fabric AI modification)
 * - full: Fabric AI's own keys (no user isolation)
 *
 * Set mode via FABRIC_AI_MODE environment variable.
 */

import {
	analyzeYouTube,
	checkFabricAIHealth,
	createFabricClient,
	createJinaClient,
	executeFabricPattern as executePattern,
	extractYouTubeTranscript as extractTranscript,
	type FabricAIMode,
	type FabricPattern,
	getFabricAIMode,
	listFabricContexts,
	listFabricStrategies,
	listFabricPatterns as listPatterns,
	type TranscriptionModel,
	transcribeAndAnalyze,
	transcribeAudio,
} from "@repo/fabric-ai";
import { logger } from "@repo/logs";
import { createProvider, type SearchResult } from "@repo/search";
import {
	guardDispatch,
	rethrowIfDispatchStopped,
	throwIfDispatchStopped,
} from "@repo/utils/dispatch-guard";

export interface ExecuteFabricPatternInput {
	pattern: FabricPattern;
	input: string;
	/** User ID for model resolution (required for hybrid/delegated modes) */
	userId?: string;
	/** Organization ID for model resolution */
	organizationId?: string;
	/** Project ID for per-project AI usage attribution */
	projectId?: string;
	/** Override the AI task type for model selection */
	taskType?: string;
	/** Override the execution mode */
	mode?: FabricAIMode;
	/** Vendor for full mode */
	vendor?: string;
	/** Model for full mode */
	model?: string;
	variables?: Record<string, string>;
	context?: string;
	strategy?: string;
	temperature?: number;
}

export interface ExecuteFabricPatternOutput {
	success: boolean;
	output: string;
	error?: string;
	durationMs: number;
	metadata?: {
		pattern: string;
		model?: string;
		taskType?: string;
		executionMode: string;
	};
}

export interface ExtractYouTubeTranscriptInput {
	url: string;
	timestamps?: boolean;
}

export interface ExtractYouTubeTranscriptOutput {
	success: boolean;
	videoId?: string;
	title?: string;
	description?: string;
	transcript?: string;
	error?: string;
	durationMs: number;
}

export interface AnalyzeYouTubeVideoInput {
	url: string;
	pattern?: FabricPattern;
	/** User ID for model resolution (required for hybrid/delegated modes) */
	userId?: string;
	/** Organization ID for model resolution */
	organizationId?: string;
	/** Project ID for per-project AI usage attribution */
	projectId?: string;
	/** Override the execution mode */
	mode?: FabricAIMode;
	/** Vendor for full mode */
	vendor?: string;
	/** Model for full mode */
	model?: string;
	includeTranscript?: boolean;
}

export interface AnalyzeYouTubeVideoOutput {
	success: boolean;
	videoId?: string;
	title?: string;
	analysis?: string;
	transcript?: string;
	error?: string;
	durationMs: number;
	metadata?: {
		pattern: string;
		model?: string;
		executionMode: string;
	};
}

/**
 * Execute a Fabric AI pattern
 *
 * Uses the configured mode (FABRIC_AI_MODE) or explicit mode parameter:
 * - hybrid: Uses user's AI provider (requires userId)
 * - delegated: Uses Fabric AI with user's credentials (requires userId)
 * - full: Uses Fabric AI's own keys (no user isolation)
 */
export async function executeFabricPattern(
	input: ExecuteFabricPatternInput,
): Promise<ExecuteFabricPatternOutput> {
	const startTime = Date.now();
	const mode = input.mode || getFabricAIMode();
	logger.info(
		`[Fabric AI] Executing pattern: ${input.pattern} (mode: ${mode})`,
	);

	try {
		// For hybrid/delegated modes, userId is required
		if ((mode === "hybrid" || mode === "delegated") && !input.userId) {
			throw new Error(`User ID required for ${mode} mode`);
		}

		const result = await executePattern({
			input: input.input,
			pattern: input.pattern,
			variables: input.variables,
			context: input.context,
			strategy: input.strategy,
			temperature: input.temperature,
			taskType: input.taskType,
			mode,
			// User context for hybrid/delegated modes
			userContext: input.userId
				? {
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
					}
				: undefined,
			// Vendor/model for full mode
			vendor: input.vendor,
			model: input.model,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Pattern ${input.pattern} completed in ${durationMs}ms (mode: ${result.mode})`,
		);

		return {
			success: result.success,
			output: result.output,
			error: result.error,
			durationMs,
			metadata: {
				pattern: input.pattern,
				model:
					"metadata" in result
						? (result.metadata as { model?: string }).model
						: undefined,
				taskType:
					"metadata" in result
						? (result.metadata as { taskType?: string }).taskType
						: undefined,
				executionMode: result.mode,
			},
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			`[Fabric AI] Pattern ${input.pattern} failed: ${errorMessage}`,
		);

		return {
			success: false,
			output: "",
			error: errorMessage,
			durationMs,
			metadata: {
				pattern: input.pattern,
				executionMode: mode,
			},
		};
	}
}

/**
 * Extract transcript from a YouTube video (no AI needed)
 */
export async function extractYouTubeTranscript(
	input: ExtractYouTubeTranscriptInput,
): Promise<ExtractYouTubeTranscriptOutput> {
	const startTime = Date.now();
	logger.info(`[Fabric AI] Extracting YouTube transcript: ${input.url}`);

	try {
		const result = await extractTranscript(
			input.url,
			input.timestamps ?? false,
		);

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Transcript extracted (${result.transcript.length} chars) in ${durationMs}ms`,
		);

		return {
			success: true,
			videoId: result.videoId,
			title: result.title,
			description: result.description,
			transcript: result.transcript,
			durationMs,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			`[Fabric AI] Transcript extraction failed: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

/**
 * Extract transcript and analyze a YouTube video in one step
 *
 * Uses the configured mode for AI execution:
 * - hybrid: Extract via Fabric AI, analyze with user's AI
 * - delegated: Full Fabric AI with user's credentials
 * - full: Full Fabric AI with server keys
 */
export async function analyzeYouTubeVideo(
	input: AnalyzeYouTubeVideoInput,
): Promise<AnalyzeYouTubeVideoOutput> {
	const startTime = Date.now();
	const pattern = input.pattern ?? "extract_wisdom";
	const mode = input.mode || getFabricAIMode();
	logger.info(
		`[Fabric AI] Analyzing YouTube video with pattern ${pattern} (mode: ${mode}): ${input.url}`,
	);

	try {
		// For hybrid/delegated modes, userId is required
		if ((mode === "hybrid" || mode === "delegated") && !input.userId) {
			throw new Error(`User ID required for ${mode} mode`);
		}

		const result = await analyzeYouTube({
			url: input.url,
			pattern,
			mode,
			userContext: input.userId
				? {
						userId: input.userId,
						organizationId: input.organizationId,
						projectId: input.projectId,
					}
				: undefined,
			vendor: input.vendor,
			model: input.model,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Video analysis completed in ${durationMs}ms (mode: ${result.mode})`,
		);

		// Get transcript if requested
		let transcript: string | undefined;
		if (input.includeTranscript && result.videoInfo) {
			const transcriptResult = await extractTranscript(input.url, false);
			transcript = transcriptResult.transcript;
		}

		return {
			success: result.success,
			videoId: result.videoInfo?.videoId,
			title: result.videoInfo?.title,
			analysis: result.output,
			transcript,
			error: result.error,
			durationMs,
			metadata: {
				pattern,
				model:
					"metadata" in result
						? (result.metadata as { model?: string }).model
						: undefined,
				executionMode: result.mode,
			},
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Video analysis failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
			metadata: {
				pattern,
				executionMode: mode,
			},
		};
	}
}

/**
 * List available Fabric patterns
 */
export async function listFabricPatternsActivity(): Promise<{
	success: boolean;
	patterns?: string[];
	error?: string;
}> {
	try {
		const patterns = await listPatterns();
		return { success: true, patterns };
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		return { success: false, error: errorMessage };
	}
}

/**
 * Check Fabric AI server health and mode support
 */
export async function checkFabricHealth(): Promise<{
	healthy: boolean;
	mode?: FabricAIMode;
	delegatedSupported?: boolean;
	error?: string;
}> {
	try {
		const health = await checkFabricAIHealth();
		return {
			healthy: health.healthy,
			mode: health.mode,
			delegatedSupported: health.delegatedSupported,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		return { healthy: false, error: errorMessage };
	}
}

// ============================================================================
// Audio/Video Transcription Activities
// ============================================================================

export interface TranscribeAudioInput {
	/** Base64-encoded file content */
	fileContentBase64: string;
	/** Original file name (for extension detection) */
	fileName: string;
	/** Transcription model to use */
	model?: TranscriptionModel;
	/** User ID for API key resolution (required for hybrid/delegated modes) */
	userId?: string;
	/** Organization ID for API key resolution */
	organizationId?: string;
	/** Override the execution mode */
	mode?: FabricAIMode;
}

export interface TranscribeAudioOutput {
	success: boolean;
	transcript?: string;
	error?: string;
	durationMs: number;
	metadata?: {
		model: string;
		executionMode: string;
	};
}

export interface TranscribeAndAnalyzeInput extends TranscribeAudioInput {
	/** Pattern to execute on the transcript */
	pattern: FabricPattern;
	/** Pattern variables */
	variables?: Record<string, string>;
	/** Context name to include */
	context?: string;
	/** Strategy name to use */
	strategy?: string;
}

export interface TranscribeAndAnalyzeOutput {
	success: boolean;
	transcript?: string;
	analysis?: string;
	error?: string;
	durationMs: number;
}

/**
 * Transcribe an audio/video file
 *
 * Supports all three modes:
 * - hybrid: Uses user's OpenAI API key directly
 * - delegated: Uses Fabric AI with user's credentials
 * - full: transcribes as hybrid; audio never runs on Fabric's own keys
 *
 * Supported formats: mp3, mp4, mpeg, mpga, m4a, wav, webm
 * Max file size: 25MB
 */
export async function transcribeAudioActivity(
	input: TranscribeAudioInput,
): Promise<TranscribeAudioOutput> {
	const startTime = Date.now();
	const mode = input.mode || getFabricAIMode();
	logger.info(
		`[Fabric AI] Transcribing audio: ${input.fileName} (mode: ${mode})`,
	);

	try {
		// For hybrid/delegated modes, userId is required
		if ((mode === "hybrid" || mode === "delegated") && !input.userId) {
			throw new Error(`User ID required for ${mode} mode`);
		}

		// Decode base64 content
		const fileContent = Buffer.from(input.fileContentBase64, "base64");

		const result = await transcribeAudio(fileContent, input.fileName, {
			model: input.model,
			mode,
			userContext: input.userId
				? { userId: input.userId, organizationId: input.organizationId }
				: undefined,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Transcription completed in ${durationMs}ms (mode: ${result.metadata.executionMode})`,
		);

		return {
			success: result.success,
			transcript: result.transcript,
			error: result.error,
			durationMs,
			metadata: {
				model: result.metadata.model,
				executionMode: result.metadata.executionMode,
			},
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Transcription failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

/**
 * Transcribe an audio/video file and analyze with a pattern
 *
 * Combines transcription and pattern execution in one activity.
 */
export async function transcribeAndAnalyzeActivity(
	input: TranscribeAndAnalyzeInput,
): Promise<TranscribeAndAnalyzeOutput> {
	const startTime = Date.now();
	const mode = input.mode || getFabricAIMode();
	logger.info(
		`[Fabric AI] Transcribe and analyze: ${input.fileName} with pattern ${input.pattern} (mode: ${mode})`,
	);

	try {
		// For hybrid/delegated modes, userId is required
		if ((mode === "hybrid" || mode === "delegated") && !input.userId) {
			throw new Error(`User ID required for ${mode} mode`);
		}

		// Decode base64 content
		const fileContent = Buffer.from(input.fileContentBase64, "base64");

		const result = await transcribeAndAnalyze({
			fileContent,
			fileName: input.fileName,
			pattern: input.pattern,
			variables: input.variables,
			context: input.context,
			strategy: input.strategy,
			mode,
			transcriptionModel: input.model,
			userContext: input.userId
				? { userId: input.userId, organizationId: input.organizationId }
				: undefined,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Transcribe and analyze completed in ${durationMs}ms`,
		);

		return {
			success: result.success,
			transcript: result.transcript,
			analysis: result.analysis,
			error: result.error,
			durationMs,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(
			`[Fabric AI] Transcribe and analyze failed: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

// ============================================================================
// Web Scraping and Search Activities
// (scraping: the tenant's configured scraper, else the Fabric AI server;
// search: Jina AI, else the Fabric AI server)
// ============================================================================

export interface ScrapeUrlInput {
	/** URL to scrape */
	url: string;
	/** User ID for scrape provider resolution */
	userId?: string;
	/** Organization ID for scrape provider resolution */
	organizationId?: string;
}

export interface ScrapeUrlOutput {
	success: boolean;
	content?: string;
	error?: string;
	durationMs: number;
}

export interface ScrapeAndAnalyzeInput {
	/** URL to scrape */
	url: string;
	/** Pattern to execute on the scraped content */
	pattern: FabricPattern;
	/** User ID for API key and scrape provider resolution (required for hybrid mode) */
	userId: string;
	/** Organization ID for API key and scrape provider resolution */
	organizationId?: string;
	/** Project ID for per-project AI usage attribution */
	projectId?: string;
	/** Pattern variables */
	variables?: Record<string, string>;
	/** Context name to include */
	context?: string;
	/** Strategy name to use */
	strategy?: string;
	/** Temperature for AI generation */
	temperature?: number;
}

export interface ScrapeAndAnalyzeOutput {
	success: boolean;
	analysis?: string;
	error?: string;
	durationMs: number;
	metadata?: {
		pattern: string;
		model: string;
		executionMode: string;
	};
}

export interface SearchWebInput {
	/** Search question/query */
	question: string;
	/** User ID for Jina API key resolution */
	userId?: string;
	/** Organization ID for Jina API key resolution */
	organizationId?: string;
}

export interface SearchWebOutput {
	success: boolean;
	results?: string;
	error?: string;
	durationMs: number;
}

export interface SearchAndAnalyzeInput {
	/** Search question/query */
	question: string;
	/** Pattern to execute on the search results */
	pattern: FabricPattern;
	/** User ID for API key resolution (required for hybrid mode) */
	userId: string;
	/** Organization ID for API key resolution */
	organizationId?: string;
	/** Project ID for per-project AI usage attribution */
	projectId?: string;
	/** Pattern variables */
	variables?: Record<string, string>;
	/** Context name to include */
	context?: string;
	/** Strategy name to use */
	strategy?: string;
	/** Temperature for AI generation */
	temperature?: number;
}

export interface SearchAndAnalyzeOutput {
	success: boolean;
	analysis?: string;
	error?: string;
	durationMs: number;
	metadata?: {
		pattern: string;
		model: string;
		executionMode: string;
	};
}

const SEARCH_MAX_RESULTS = 10;

/** Renders provider results as markdown: title, URL, then content or snippet. */
function formatSearchResults(results: SearchResult[]): string {
	return results
		.map((result) => {
			const body = (result.content || result.snippet || "").trim();
			return [`## ${result.title}`, result.url, body]
				.filter(Boolean)
				.join("\n\n");
		})
		.join("\n\n---\n\n");
}

/**
 * Runs one search on the tenant's resolved provider and returns markdown, or
 * null when the provider cannot be built. Throws on any failure (including a
 * Jina `{ success: false }`) so callers choose between a failure result and a
 * fallback.
 *
 * Jina goes through `JinaClient`, which returns the Reader's full markdown
 * unchanged; the registry's Jina provider reduces each hit to a 500-character
 * snippet. Other providers go through `createProvider`. Provider requests
 * cannot be aborted mid-flight, so the stop check runs first (a no-op outside
 * a dispatch guard).
 */
async function searchWithTenantProvider(
	providerConfig: { apiKey: string; providerName: string },
	question: string,
): Promise<string | null> {
	logger.info(`[Fabric AI] Searching via ${providerConfig.providerName}`);
	if (providerConfig.providerName === "jina") {
		await guardDispatch();
		throwIfDispatchStopped();
		const result = await createJinaClient({
			apiKey: providerConfig.apiKey,
		}).search(question);
		if (!result.success) {
			throw new Error(result.error ?? "Jina search failed");
		}
		return result.content;
	}

	const provider = createProvider(
		providerConfig.providerName,
		providerConfig.apiKey,
	);
	if (!provider) {
		return null;
	}
	await guardDispatch();
	throwIfDispatchStopped();
	const response = await provider.search(question, {
		maxResults: SEARCH_MAX_RESULTS,
		category: "general",
	});
	return formatSearchResults(response.results);
}

/**
 * Scrape a URL to clean, LLM-friendly markdown
 *
 * Uses the scraper the tenant has configured under Settings > Search
 * Providers (Firecrawl, Jina, Tavily, Exa or Cloudflare Browser Rendering),
 * chosen by `getWebScraperForTenant`: default provider first, then priority.
 * A failed scrape is returned as `{ success: false }` with no fallback.
 * Falls back to the Fabric AI server when no user ID is provided or the
 * tenant has no scrape-capable provider.
 * No AI processing - just returns the scraped content.
 */
export async function scrapeUrlActivity(
	input: ScrapeUrlInput,
): Promise<ScrapeUrlOutput> {
	const startTime = Date.now();
	logger.info(`[Fabric AI] Scraping URL: ${input.url}`);

	try {
		// If user credentials provided, use the tenant's configured scraper
		if (input.userId) {
			const { getWebScraperForTenant } = await import(
				"../lib/get-web-scraper"
			);

			const scraper = await getWebScraperForTenant({
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				requireCrawl: false,
			});

			if (scraper) {
				const result = await scraper.scrapeUrl(input.url);

				const durationMs = Date.now() - startTime;
				logger.info(
					`[Fabric AI] Scrape completed via ${scraper.providerName} in ${durationMs}ms`,
				);

				if (!result.success) {
					return {
						success: false,
						error: result.error.message,
						durationMs,
					};
				}

				return {
					success: true,
					content: result.data.markdown,
					durationMs,
				};
			}

			logger.warn(
				"[Fabric AI] No scrape provider configured for tenant, falling back to Fabric AI server",
			);
		}

		// Fallback to Fabric AI server (requires server to have a scrape key configured)
		const client = createFabricClient();
		const content = await client.scrapeUrl(input.url);

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Scrape completed via Fabric AI server in ${durationMs}ms`,
		);

		return {
			success: true,
			content,
			durationMs,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Scrape failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

/**
 * Scrape a URL and analyze with a Fabric pattern
 *
 * Scrapes with the tenant's configured scraper (`getWebScraperForTenant`),
 * falling back to the Fabric AI server when none is configured, no user ID
 * is provided, or the scrape fails. The user's delegation setting is not
 * consulted.
 */
export async function scrapeAndAnalyzeActivity(
	input: ScrapeAndAnalyzeInput,
): Promise<ScrapeAndAnalyzeOutput> {
	const startTime = Date.now();
	logger.info(
		`[Fabric AI] Scrape and analyze: ${input.url} with pattern ${input.pattern}`,
		{
			userId: input.userId,
			organizationId: input.organizationId,
		},
	);

	try {
		let scrapedContent: string | null = null;

		// Try the tenant's configured scraper
		if (input.userId) {
			const { getWebScraperForTenant } = await import(
				"../lib/get-web-scraper"
			);

			const scraper = await getWebScraperForTenant({
				userId: input.userId,
				organizationId: input.organizationId ?? null,
				requireCrawl: false,
			});

			if (scraper) {
				logger.info(
					`[Fabric AI] Using ${scraper.providerName} scraper for scraping`,
				);
				const scrapeResult = await scraper.scrapeUrl(input.url);

				if (scrapeResult.success) {
					scrapedContent = scrapeResult.data.markdown;
					logger.info(
						`[Fabric AI] Scrape completed via ${scraper.providerName} scraper`,
						{ contentLength: scrapedContent.length },
					);
				} else {
					logger.warn(
						`[Fabric AI] ${scraper.providerName} scrape failed: ${scrapeResult.error.message}`,
					);
				}
			}
		}

		// Fall back to Fabric AI server if no scrape provider or scrape failed
		if (!scrapedContent) {
			logger.info(
				"[Fabric AI] Falling back to Fabric AI server for scraping",
			);
			const fabricClient = createFabricClient();
			scrapedContent = await fabricClient.scrapeUrl(input.url);
		}

		// Now execute the pattern with the scraped content
		const { executePatternHybrid } = await import("@repo/fabric-ai");
		const result = await executePatternHybrid({
			input: scrapedContent,
			pattern: input.pattern,
			variables: {
				...input.variables,
				url: input.url,
			},
			context: input.context,
			strategy: input.strategy,
			userContext: {
				userId: input.userId,
				organizationId: input.organizationId,
				projectId: input.projectId,
			},
			temperature: input.temperature,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Scrape and analyze completed in ${durationMs}ms`,
		);

		return {
			success: result.success,
			analysis: result.output,
			error: result.error,
			durationMs,
			metadata: result.success
				? {
						pattern: result.metadata.pattern,
						model: result.metadata.model,
						executionMode: result.metadata.executionMode,
					}
				: undefined,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Scrape and analyze failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

/**
 * Search the web
 *
 * Uses the search provider the tenant has configured under Settings > Search
 * Providers (`resolveSearchProviderForTenant`): default provider first, then
 * any other enabled one. Results are returned as markdown. A provider error
 * is returned as `{ success: false }` with no fallback. Falls back to the
 * Fabric AI server when no user ID is provided or no search provider is
 * configured. The user's delegation setting is not consulted.
 */
export async function searchWebActivity(
	input: SearchWebInput,
): Promise<SearchWebOutput> {
	const startTime = Date.now();
	logger.info(`[Fabric AI] Searching web: ${input.question}`, {
		userId: input.userId,
		organizationId: input.organizationId,
	});

	try {
		if (input.userId) {
			const { resolveSearchProviderForTenant } = await import(
				"../lib/get-search-provider"
			);
			const providerConfig = await resolveSearchProviderForTenant(
				input.userId,
				input.organizationId,
			);
			const results = providerConfig
				? await searchWithTenantProvider(providerConfig, input.question)
				: null;

			if (providerConfig && results !== null) {
				const durationMs = Date.now() - startTime;
				logger.info(
					`[Fabric AI] Search completed via ${providerConfig.providerName} in ${durationMs}ms`,
				);

				return {
					success: true,
					results,
					durationMs,
				};
			}

			logger.warn(
				"[Fabric AI] No search provider configured for tenant, falling back to Fabric AI server",
			);
		} else {
			logger.warn(
				"[Fabric AI] No userId provided, falling back to Fabric AI server",
			);
		}

		// Fallback to Fabric AI server (requires the server to have a search key)
		logger.info("[Fabric AI] Falling back to Fabric AI server for search");
		const client = createFabricClient();
		const results = await client.searchWeb(input.question);

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Search completed via Fabric AI server fallback in ${durationMs}ms`,
		);

		return {
			success: true,
			results,
			durationMs,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Search failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

/**
 * Search the web and analyze results with a Fabric pattern
 *
 * Searches with the tenant's configured search provider
 * (`resolveSearchProviderForTenant`), falling back to the Fabric AI server
 * when none is configured, no user ID is provided, or the provider fails or
 * returns nothing. The user's delegation setting is not consulted.
 */
export async function searchAndAnalyzeActivity(
	input: SearchAndAnalyzeInput,
): Promise<SearchAndAnalyzeOutput> {
	const startTime = Date.now();
	logger.info(
		`[Fabric AI] Search and analyze: "${input.question}" with pattern ${input.pattern}`,
		{
			userId: input.userId,
			organizationId: input.organizationId,
		},
	);

	try {
		let searchResults: string | null = null;

		if (input.userId) {
			const { resolveSearchProviderForTenant } = await import(
				"../lib/get-search-provider"
			);
			const providerConfig = await resolveSearchProviderForTenant(
				input.userId,
				input.organizationId,
			);
			if (providerConfig) {
				try {
					const formatted = await searchWithTenantProvider(
						providerConfig,
						input.question,
					);
					if (formatted) {
						searchResults = formatted;
						logger.info(
							`[Fabric AI] Search completed via ${providerConfig.providerName}`,
							{ contentLength: formatted.length },
						);
					} else {
						logger.warn(
							`[Fabric AI] ${providerConfig.providerName} search returned no results`,
						);
					}
				} catch (searchError) {
					// A stop is not a provider failure: falling back would send
					// a second request for a stopped turn.
					rethrowIfDispatchStopped(searchError);
					logger.warn(
						`[Fabric AI] ${providerConfig.providerName} search failed: ${searchError}`,
					);
				}
			}
		}

		// Fall back to Fabric AI server if no search provider or the search failed
		if (!searchResults) {
			logger.info(
				"[Fabric AI] Falling back to Fabric AI server for search",
			);
			const fabricClient = createFabricClient();
			searchResults = await fabricClient.searchWeb(input.question);
		}

		// Now execute the pattern with the search results
		const { executePatternHybrid } = await import("@repo/fabric-ai");
		const result = await executePatternHybrid({
			input: searchResults,
			pattern: input.pattern,
			variables: {
				...input.variables,
				question: input.question,
			},
			context: input.context,
			strategy: input.strategy,
			userContext: {
				userId: input.userId,
				organizationId: input.organizationId,
				projectId: input.projectId,
			},
			temperature: input.temperature,
		});

		const durationMs = Date.now() - startTime;
		logger.info(
			`[Fabric AI] Search and analyze completed in ${durationMs}ms`,
		);

		return {
			success: result.success,
			analysis: result.output,
			error: result.error,
			durationMs,
			metadata: result.success
				? {
						pattern: result.metadata.pattern,
						model: result.metadata.model,
						executionMode: result.metadata.executionMode,
					}
				: undefined,
		};
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const durationMs = Date.now() - startTime;
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		logger.error(`[Fabric AI] Search and analyze failed: ${errorMessage}`);

		return {
			success: false,
			error: errorMessage,
			durationMs,
		};
	}
}

// ============================================================================
// Strategy and Context Activities
// ============================================================================

export interface ListStrategiesOutput {
	success: boolean;
	strategies?: Array<{ name: string; description: string; prompt: string }>;
	error?: string;
}

export interface ListContextsOutput {
	success: boolean;
	contexts?: string[];
	error?: string;
}

/**
 * List available strategies from Fabric AI
 *
 * Strategies are prompt engineering techniques like:
 * - cot (Chain of Thought)
 * - tot (Tree of Thoughts)
 * - reflexion (Self-reflection)
 */
export async function listStrategiesActivity(): Promise<ListStrategiesOutput> {
	try {
		const strategies = await listFabricStrategies();
		return { success: true, strategies };
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		return { success: false, error: errorMessage };
	}
}

/**
 * List available contexts from Fabric AI
 *
 * Contexts are reusable system-level instructions that can be
 * prepended to patterns (e.g., writing style, persona, etc.)
 */
export async function listContextsActivity(): Promise<ListContextsOutput> {
	try {
		const contexts = await listFabricContexts();
		return { success: true, contexts };
	} catch (error) {
		// In an Advisor chat turn a stop leaves the activity as an error;
		// outside a dispatch guard this is a no-op.
		rethrowIfDispatchStopped(error);
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		return { success: false, error: errorMessage };
	}
}

// Export all activities
export const fabricAiActivities = {
	executeFabricPattern,
	extractYouTubeTranscript,
	analyzeYouTubeVideo,
	listFabricPatterns: listFabricPatternsActivity,
	checkFabricHealth,
	transcribeAudio: transcribeAudioActivity,
	transcribeAndAnalyze: transcribeAndAnalyzeActivity,
	// Web scraping and search
	scrapeUrl: scrapeUrlActivity,
	scrapeAndAnalyze: scrapeAndAnalyzeActivity,
	searchWeb: searchWebActivity,
	searchAndAnalyze: searchAndAnalyzeActivity,
	// Strategies and contexts
	listStrategies: listStrategiesActivity,
	listContexts: listContextsActivity,
};
