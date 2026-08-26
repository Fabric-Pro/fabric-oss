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
 * - full: Uses Fabric AI's own API keys
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
// Web Scraping and Search Activities (via Fabric AI + Jina AI)
// ============================================================================

export interface ScrapeUrlInput {
	/** URL to scrape */
	url: string;
	/** User ID for Jina API key resolution */
	userId?: string;
	/** Organization ID for Jina API key resolution */
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

/**
 * Scrape a URL to clean, LLM-friendly markdown
 *
 * Uses Jina AI Reader (https://r.jina.ai/) with user's API key.
 * Falls back to Fabric AI server if no user credentials provided.
 * No AI processing - just returns the scraped content.
 */
export async function scrapeUrlActivity(
	input: ScrapeUrlInput,
): Promise<ScrapeUrlOutput> {
	const startTime = Date.now();
	logger.info(`[Fabric AI] Scraping URL: ${input.url}`);

	try {
		// If user credentials provided, use direct Jina client with their API key
		if (input.userId) {
			const { getSearchProviderConfig } = await import("@repo/database");
			const { decryptApiKey } = await import("@repo/utils");
			const { createJinaClient } = await import("@repo/fabric-ai");

			const jinaConfig = await getSearchProviderConfig({
				userId: input.userId,
				organizationId: input.organizationId,
				providerName: "jina",
			});

			if (jinaConfig?.encryptedApiKey) {
				const apiKey = decryptApiKey(jinaConfig.encryptedApiKey);
				const jinaClient = createJinaClient({ apiKey });
				const result = await jinaClient.scrape(input.url);

				const durationMs = Date.now() - startTime;
				logger.info(
					`[Fabric AI] Scrape completed via Jina client in ${durationMs}ms`,
				);

				if (!result.success) {
					return {
						success: false,
						error: result.error,
						durationMs,
					};
				}

				return {
					success: true,
					content: result.content,
					durationMs,
				};
			}

			logger.warn(
				"[Fabric AI] No Jina API key configured for user, falling back to Fabric AI server",
			);
		}

		// Fallback to Fabric AI server (requires server to have Jina key configured)
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
 * Execution mode determined by user's delegation setting:
 * - Delegated: Routes to Fabric AI server's /delegated/scrape (user's Jina key via token exchange)
 * - Direct: Uses user's Jina API key directly, falls back to Fabric AI server
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

		// Check delegation setting to determine execution mode
		let useDelegatedExecution = true; // Default to delegated
		if (input.userId) {
			const { getEffectiveDelegationSetting } = await import(
				"@repo/database"
			);
			useDelegatedExecution = await getEffectiveDelegationSetting({
				userId: input.userId,
				organizationId: input.organizationId,
			});
			logger.info(
				`[Fabric AI] Delegation setting: ${useDelegatedExecution ? "delegated" : "direct"}`,
			);
		}

		if (useDelegatedExecution && input.userId) {
			// Delegated mode: Use Fabric AI server's delegated endpoint with token exchange
			logger.info(
				"[Fabric AI] Using delegated mode for scraping via Fabric AI server",
			);

			try {
				// Issue AI token for this user
				const { issueAIToken } = await import("@repo/ai-token");
				const aiToken = await issueAIToken({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-ai-scrape",
				});

				const fabricClient = createFabricClient();
				scrapedContent = await fabricClient.scrapeUrlDelegated(
					input.url,
					aiToken,
				);
				logger.info("[Fabric AI] Scrape completed via delegated mode", {
					contentLength: scrapedContent.length,
				});
			} catch (delegatedError) {
				// Fall back to direct mode if delegated fails
				logger.warn(
					`[Fabric AI] Delegated scrape failed, falling back to direct mode: ${delegatedError}`,
				);
			}
		}

		if (!scrapedContent) {
			// Direct mode: Try to use user's Jina API key directly
			if (input.userId) {
				const { getSearchProviderConfig } = await import(
					"@repo/database"
				);
				const { decryptApiKey } = await import("@repo/utils");
				const { createJinaClient } = await import("@repo/fabric-ai");

				const jinaConfig = await getSearchProviderConfig({
					userId: input.userId,
					organizationId: input.organizationId,
					providerName: "jina",
				});

				if (jinaConfig?.encryptedApiKey) {
					const apiKey = decryptApiKey(jinaConfig.encryptedApiKey);
					logger.info(
						"[Fabric AI] Using direct Jina client for scraping",
					);
					const jinaClient = createJinaClient({ apiKey });
					const scrapeResult = await jinaClient.scrape(input.url);

					if (scrapeResult.success) {
						scrapedContent = scrapeResult.content;
						logger.info(
							"[Fabric AI] Scrape completed via direct Jina client",
							{
								contentLength: scrapedContent.length,
							},
						);
					} else {
						logger.warn(
							`[Fabric AI] Direct Jina scrape failed: ${scrapeResult.error}`,
						);
					}
				}
			}

			// Fall back to Fabric AI server if no Jina key or scrape failed
			if (!scrapedContent) {
				logger.info(
					"[Fabric AI] Falling back to Fabric AI server for scraping",
				);
				const fabricClient = createFabricClient();
				scrapedContent = await fabricClient.scrapeUrl(input.url);
			}
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
 * Search the web using Jina AI
 *
 * Execution mode determined by user's delegation setting:
 * - Delegated: Routes to Fabric AI server's /delegated/search with X-AI-Token
 *   (Fabric AI server exchanges token to get user's Jina API key)
 * - Direct: Uses user's Jina API key directly via JinaClient
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
		// Check delegation setting to determine execution mode
		let useDelegatedExecution = true; // Default to delegated
		if (input.userId) {
			const { getEffectiveDelegationSetting } = await import(
				"@repo/database"
			);
			useDelegatedExecution = await getEffectiveDelegationSetting({
				userId: input.userId,
				organizationId: input.organizationId,
			});
			logger.info(
				`[Fabric AI] Delegation setting: ${useDelegatedExecution ? "delegated" : "direct"}`,
			);
		}

		if (useDelegatedExecution && input.userId) {
			// Delegated mode: Use Fabric AI server's delegated endpoint with token exchange
			logger.info(
				"[Fabric AI] Using delegated mode for search via Fabric AI server",
			);

			try {
				// Issue AI token for this user
				const { issueAIToken } = await import("@repo/ai-token");
				const aiToken = await issueAIToken({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-ai-search",
				});

				const client = createFabricClient();
				const results = await client.searchWebDelegated(
					input.question,
					aiToken,
				);

				const durationMs = Date.now() - startTime;
				logger.info(
					`[Fabric AI] Search completed via delegated mode in ${durationMs}ms`,
				);

				return {
					success: true,
					results,
					durationMs,
				};
			} catch (delegatedError) {
				// Fall back to direct mode if delegated fails
				logger.warn(
					`[Fabric AI] Delegated search failed, falling back to direct mode: ${delegatedError}`,
				);
			}
		}

		// Direct mode: Try to use user's Jina API key directly
		if (input.userId) {
			logger.info("[Fabric AI] Looking up Jina API key for direct mode");
			const { getSearchProviderConfig } = await import("@repo/database");
			const { decryptApiKey } = await import("@repo/utils");
			const { createJinaClient } = await import("@repo/fabric-ai");

			const jinaConfig = await getSearchProviderConfig({
				userId: input.userId,
				organizationId: input.organizationId,
				providerName: "jina",
			});

			logger.info("[Fabric AI] Jina config lookup result", {
				found: !!jinaConfig,
				hasApiKey: !!jinaConfig?.encryptedApiKey,
				enabled: jinaConfig?.enabled,
				source: jinaConfig?.source,
			});

			if (jinaConfig?.encryptedApiKey) {
				const apiKey = decryptApiKey(jinaConfig.encryptedApiKey);
				logger.info("[Fabric AI] Using direct Jina client for search");
				const jinaClient = createJinaClient({ apiKey });
				const result = await jinaClient.search(input.question);

				const durationMs = Date.now() - startTime;
				logger.info("[Fabric AI] Direct Jina search result", {
					success: result.success,
					error: result.error,
					contentLength: result.content?.length,
					durationMs,
				});

				if (!result.success) {
					return {
						success: false,
						error: result.error,
						durationMs,
					};
				}

				return {
					success: true,
					results: result.content,
					durationMs,
				};
			}

			logger.warn(
				"[Fabric AI] No Jina API key configured for user, falling back to Fabric AI server",
			);
		} else {
			logger.warn(
				"[Fabric AI] No userId provided, falling back to Fabric AI server",
			);
		}

		// Fallback to Fabric AI server (non-delegated - requires server to have Jina key)
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
 * Execution mode determined by user's delegation setting:
 * - Delegated: Routes to Fabric AI server's /delegated/search (user's Jina key via token exchange)
 * - Direct: Uses user's Jina API key directly, falls back to Fabric AI server
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

		// Check delegation setting to determine execution mode
		let useDelegatedExecution = true; // Default to delegated
		if (input.userId) {
			const { getEffectiveDelegationSetting } = await import(
				"@repo/database"
			);
			useDelegatedExecution = await getEffectiveDelegationSetting({
				userId: input.userId,
				organizationId: input.organizationId,
			});
			logger.info(
				`[Fabric AI] Delegation setting: ${useDelegatedExecution ? "delegated" : "direct"}`,
			);
		}

		if (useDelegatedExecution && input.userId) {
			// Delegated mode: Use Fabric AI server's delegated endpoint with token exchange
			logger.info(
				"[Fabric AI] Using delegated mode for search via Fabric AI server",
			);

			try {
				// Issue AI token for this user
				const { issueAIToken } = await import("@repo/ai-token");
				const aiToken = await issueAIToken({
					userId: input.userId,
					organizationId: input.organizationId,
					source: "fabric-ai-search-analyze",
				});

				const fabricClient = createFabricClient();
				searchResults = await fabricClient.searchWebDelegated(
					input.question,
					aiToken,
				);
				logger.info("[Fabric AI] Search completed via delegated mode", {
					contentLength: searchResults.length,
				});
			} catch (delegatedError) {
				// Fall back to direct mode if delegated fails
				logger.warn(
					`[Fabric AI] Delegated search failed, falling back to direct mode: ${delegatedError}`,
				);
			}
		}

		if (!searchResults) {
			// Direct mode: Try to use user's Jina API key directly
			if (input.userId) {
				const { getSearchProviderConfig } = await import(
					"@repo/database"
				);
				const { decryptApiKey } = await import("@repo/utils");
				const { createJinaClient } = await import("@repo/fabric-ai");

				const jinaConfig = await getSearchProviderConfig({
					userId: input.userId,
					organizationId: input.organizationId,
					providerName: "jina",
				});

				if (jinaConfig?.encryptedApiKey) {
					const apiKey = decryptApiKey(jinaConfig.encryptedApiKey);
					logger.info(
						"[Fabric AI] Using direct Jina client for search",
					);
					const jinaClient = createJinaClient({ apiKey });
					const searchResult = await jinaClient.search(
						input.question,
					);

					if (searchResult.success) {
						searchResults = searchResult.content;
						logger.info(
							"[Fabric AI] Search completed via direct Jina client",
							{
								contentLength: searchResults.length,
							},
						);
					} else {
						logger.warn(
							`[Fabric AI] Direct Jina search failed: ${searchResult.error}`,
						);
					}
				}
			}

			// Fall back to Fabric AI server if no Jina key or search failed
			if (!searchResults) {
				logger.info(
					"[Fabric AI] Falling back to Fabric AI server for search",
				);
				const fabricClient = createFabricClient();
				searchResults = await fabricClient.searchWeb(input.question);
			}
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
