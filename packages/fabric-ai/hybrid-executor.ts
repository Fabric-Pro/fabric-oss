/**
 * Hybrid Mode Executor for Fabric AI
 *
 * This module executes Fabric patterns using the user's configured AI provider
 * instead of Fabric AI's own provider. This enables:
 * - Multi-tenant isolation (each user uses their own API keys)
 * - Model preferences (users can configure their preferred models)
 * - Cost allocation (API costs go to user's account)
 *
 * Flow:
 * 1. Fetch pattern template from Fabric AI server
 * 2. Apply any pattern variables
 * 3. Execute with user's AI provider via @repo/ai
 */

import { getAIModelWithMetadata, logModelUsageAsync } from "@repo/ai";
import { logger } from "@repo/logs";
import { generateText, streamText } from "ai";
import { createFabricClient } from "./client";
import type { FabricConfig, FabricPattern } from "./types";

/**
 * Map Fabric pattern categories to AI task types
 * This allows us to select the appropriate model based on the pattern being executed
 */
const PATTERN_TO_TASK_TYPE: Record<string, string> = {
	// Complex analysis patterns -> COMPLEX task type
	analyze_claims: "COMPLEX",
	analyze_threat_report: "COMPLEX",
	analyze_incident: "COMPLEX",
	analyze_logs: "COMPLEX",
	analyze_paper: "COMPLEX",
	analyze_personality: "COMPLEX",
	analyze_presentation: "COMPLEX",
	analyze_prose: "COMPLEX",
	analyze_tech_impact: "COMPLEX",
	analyze_malware: "COMPLEX",
	rate_content: "COMPLEX",
	rate_ai_response: "COMPLEX",
	rate_ai_result: "COMPLEX",

	// Reasoning patterns -> REASONING task type
	create_investigation_visualization: "REASONING",
	create_threat_scenarios: "REASONING",
	create_quiz: "REASONING",
	find_hidden_message: "REASONING",
	find_logical_fallacies: "REASONING",

	// Simple extraction patterns -> SIMPLE task type
	summarize: "SIMPLE",
	summarize_meeting: "SIMPLE",
	summarize_paper: "SIMPLE",
	summarize_micro: "SIMPLE",
	create_summary: "SIMPLE",
	extract_wisdom: "SIMPLE",
	extract_insights: "SIMPLE",
	extract_main_idea: "SIMPLE",
	extract_sponsors: "SIMPLE",
	extract_article_wisdom: "SIMPLE",
	extract_book_ideas: "SIMPLE",
	extract_book_recommendations: "SIMPLE",
	extract_extraordinary_claims: "SIMPLE",
	extract_ideas: "SIMPLE",
	extract_questions: "SIMPLE",
	extract_recommendations: "SIMPLE",
	extract_references: "SIMPLE",
	extract_song_meaning: "SIMPLE",
	extract_videoid: "SIMPLE",
	extract_action_items: "SIMPLE",
	create_tags: "SIMPLE",
	youtube_summary: "SIMPLE",

	// Chat/conversation patterns -> CHAT task type
	improve_writing: "CHAT",
	improve_prompt: "CHAT",
	improve_academic_writing: "CHAT",
	improve_report_finding: "CHAT",
	explain_code: "CHAT",
	explain_project: "CHAT",
	explain_docs: "CHAT",
	explain_terms: "CHAT",
};

/**
 * Get the AI task type for a pattern
 */
function getTaskTypeForPattern(pattern: FabricPattern): string {
	// Check exact match first
	if (PATTERN_TO_TASK_TYPE[pattern]) {
		return PATTERN_TO_TASK_TYPE[pattern];
	}

	// Check prefix patterns
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

	// Default to COMPLEX for unknown patterns (safer)
	return "COMPLEX";
}

/**
 * User context for model resolution
 */
export interface UserContext {
	userId: string;
	organizationId?: string;
	projectId?: string;
}

/**
 * Options for hybrid pattern execution
 */
export interface HybridExecutionOptions {
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
 * Result from hybrid pattern execution
 */
export interface HybridExecutionResult {
	output: string;
	success: boolean;
	error?: string;
	metadata: {
		pattern: string;
		model: string;
		taskType: string;
		executionMode: "hybrid";
	};
}

/**
 * Apply pattern variables to a template
 */
function applyVariables(
	template: string,
	variables: Record<string, string>,
): string {
	let result = template;
	for (const [key, value] of Object.entries(variables)) {
		// Support both {{variable}} and {variable} syntax
		result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
		result = result.replace(new RegExp(`\\{${key}\\}`, "g"), value);
		// Also support Fabric's #variable syntax
		result = result.replace(new RegExp(`#${key}`, "g"), value);
	}
	return result;
}

/**
 * Build the system message in Fabric AI order:
 * [Strategy prompt] (prepended)
 *     ↓
 * [Context content] (prepended to pattern)
 *     ↓
 * [Pattern content]
 *     ↓
 * Combined System Message
 */
async function buildSystemMessage(
	fabricClient: ReturnType<typeof createFabricClient>,
	pattern: FabricPattern,
	variables: Record<string, string>,
	context?: string,
	strategy?: string,
): Promise<{ systemPrompt: string; error?: string }> {
	// 1. Fetch pattern template
	let patternContent: string;
	try {
		patternContent = await fabricClient.getPattern(pattern);
	} catch (err) {
		logger.error("Failed to fetch pattern from Fabric AI", {
			pattern,
			error: err,
		});
		return {
			systemPrompt: "",
			error: `Pattern "${pattern}" not found or Fabric AI server unavailable`,
		};
	}

	// 2. Apply variables to pattern
	patternContent = applyVariables(patternContent, variables);

	// 3. Fetch context if specified (prepended to pattern)
	let contextContent = "";
	if (context) {
		try {
			contextContent = await fabricClient.getContext(context);
		} catch (err) {
			logger.warn("Failed to fetch context from Fabric AI", {
				context,
				error: err,
			});
		}
	}

	// 4. Fetch strategy if specified (prepended to everything)
	let strategyPrompt = "";
	if (strategy) {
		try {
			const strategies = await fabricClient.listStrategies();
			const strategyInfo = strategies.find((s) => s.name === strategy);
			if (strategyInfo) {
				strategyPrompt = strategyInfo.prompt;
			}
		} catch (err) {
			logger.warn("Failed to fetch strategy from Fabric AI", {
				strategy,
				error: err,
			});
		}
	}

	// 5. Build system message in Fabric AI order:
	// Strategy → Context → Pattern
	const parts: string[] = [];

	if (strategyPrompt) {
		parts.push(strategyPrompt);
	}

	if (contextContent) {
		parts.push(contextContent);
	}

	parts.push(patternContent);

	return { systemPrompt: parts.join("\n\n") };
}

/**
 * Execute a Fabric pattern using the user's AI provider (Hybrid Mode)
 *
 * This fetches the pattern template from Fabric AI server but executes
 * the AI inference using the user's configured provider and model.
 *
 * System message order (same as Fabric AI):
 * [Strategy] → [Context] → [Pattern]
 */
export async function executePatternHybrid(
	options: HybridExecutionOptions,
): Promise<HybridExecutionResult> {
	const {
		input,
		pattern,
		variables = {},
		context,
		strategy,
		userContext,
		temperature = 0.7,
		taskType: overrideTaskType,
		fabricConfig,
	} = options;

	try {
		// 1. Create Fabric client
		const fabricClient = createFabricClient(fabricConfig);

		// 2. Build system message (Strategy → Context → Pattern)
		const { systemPrompt, error: buildError } = await buildSystemMessage(
			fabricClient,
			pattern,
			variables,
			context,
			strategy,
		);

		if (buildError) {
			return {
				output: "",
				success: false,
				error: buildError,
				metadata: {
					pattern,
					model: "unknown",
					taskType: "unknown",
					executionMode: "hybrid",
				},
			};
		}

		// 3. Determine task type for model selection
		const taskType = overrideTaskType || getTaskTypeForPattern(pattern);

		// 4. Get AI model using centralized entry point
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
					taskType,
					executionMode: "hybrid",
				},
			};
		}

		const { model, metadata, trackUsage } = modelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// 5. Execute AI inference
		const generationStart = Date.now();
		const result = await generateText({
			model,
			system: systemPrompt,
			prompt: input,
			temperature,
		});
		logModelUsageAsync({
			context: {
				userId: userContext.userId,
				organizationId: userContext.organizationId,
			},
			metadata,
			taskType: taskType as any,
			usage: result.usage,
			latencyMs: Date.now() - generationStart,
			projectId: userContext.projectId,
		});

		return {
			output: result.text,
			success: true,
			metadata: {
				pattern,
				model: metadata.modelString,
				taskType,
				executionMode: "hybrid",
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Hybrid pattern execution failed", {
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
				taskType: overrideTaskType || getTaskTypeForPattern(pattern),
				executionMode: "hybrid",
			},
		};
	}
}

/**
 * Execute a Fabric pattern with streaming using the user's AI provider
 *
 * System message order (same as Fabric AI):
 * [Strategy] → [Context] → [Pattern]
 */
export async function* executePatternHybridStream(
	options: HybridExecutionOptions,
): AsyncGenerator<{ type: "content" | "error" | "complete"; content: string }> {
	const {
		input,
		pattern,
		variables = {},
		context,
		strategy,
		userContext,
		temperature = 0.7,
		taskType: overrideTaskType,
		fabricConfig,
	} = options;

	try {
		// 1. Create Fabric client
		const fabricClient = createFabricClient(fabricConfig);

		// 2. Build system message (Strategy → Context → Pattern)
		const { systemPrompt, error: buildError } = await buildSystemMessage(
			fabricClient,
			pattern,
			variables,
			context,
			strategy,
		);

		if (buildError) {
			yield { type: "error", content: buildError };
			return;
		}

		// 3. Determine task type for model selection
		const taskType = overrideTaskType || getTaskTypeForPattern(pattern);

		// 4. Get AI model using centralized entry point
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

		const { model, metadata, trackUsage } = modelResult;

		// Track usage (fire-and-forget)
		trackUsage();

		// 5. Execute AI inference with streaming
		const generationStart = Date.now();
		const result = streamText({
			model,
			system: systemPrompt,
			prompt: input,
			temperature,
		});

		// 6. Stream the response
		for await (const chunk of result.textStream) {
			yield { type: "content", content: chunk };
		}
		const usage = await result.usage;
		logModelUsageAsync({
			context: {
				userId: userContext.userId,
				organizationId: userContext.organizationId,
			},
			metadata,
			taskType: taskType as any,
			usage,
			latencyMs: Date.now() - generationStart,
			projectId: userContext.projectId,
		});

		yield { type: "complete", content: "" };
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		yield { type: "error", content: errorMessage };
	}
}

/**
 * Analyze YouTube video using hybrid mode
 * Extracts transcript via Fabric AI, then executes pattern with user's AI
 */
export async function analyzeYouTubeHybrid(options: {
	url: string;
	pattern: FabricPattern;
	variables?: Record<string, string>;
	userContext: UserContext;
	temperature?: number;
	fabricConfig?: Partial<FabricConfig>;
}): Promise<
	HybridExecutionResult & { videoInfo?: { title: string; videoId: string } }
> {
	const { url, pattern, variables, userContext, temperature, fabricConfig } =
		options;

	try {
		// 1. Extract transcript via Fabric AI (no AI needed)
		const fabricClient = createFabricClient(fabricConfig);
		const transcriptResult =
			await fabricClient.extractYouTubeTranscript(url);

		// 2. Execute pattern with user's AI
		const result = await executePatternHybrid({
			input: transcriptResult.transcript,
			pattern,
			variables: {
				...variables,
				title: transcriptResult.title,
				videoId: transcriptResult.videoId,
			},
			userContext,
			temperature,
			fabricConfig,
		});

		return {
			...result,
			videoInfo: {
				title: transcriptResult.title,
				videoId: transcriptResult.videoId,
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			output: "",
			success: false,
			error: errorMessage,
			metadata: {
				pattern,
				model: "unknown",
				taskType: getTaskTypeForPattern(pattern),
				executionMode: "hybrid",
			},
		};
	}
}

/**
 * Scrape URL and analyze with pattern using hybrid mode
 *
 * Uses Jina AI via Fabric AI for scraping (https://r.jina.ai/)
 */
export async function scrapeAndAnalyzeHybrid(options: {
	url: string;
	pattern: FabricPattern;
	variables?: Record<string, string>;
	context?: string;
	strategy?: string;
	userContext: UserContext;
	temperature?: number;
	fabricConfig?: Partial<FabricConfig>;
}): Promise<HybridExecutionResult> {
	const {
		url,
		pattern,
		variables,
		context,
		strategy,
		userContext,
		temperature,
		fabricConfig,
	} = options;

	try {
		// 1. Scrape URL via Fabric AI's Jina integration (no AI needed)
		const fabricClient = createFabricClient(fabricConfig);
		const scrapedContent = await fabricClient.scrapeUrl(url);

		// 2. Execute pattern with user's AI
		return await executePatternHybrid({
			input: scrapedContent,
			pattern,
			variables: {
				...variables,
				url,
			},
			context,
			strategy,
			userContext,
			temperature,
			fabricConfig,
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			output: "",
			success: false,
			error: errorMessage,
			metadata: {
				pattern,
				model: "unknown",
				taskType: getTaskTypeForPattern(pattern),
				executionMode: "hybrid",
			},
		};
	}
}

/**
 * Search the web and analyze results with pattern using hybrid mode
 *
 * Uses Jina AI via Fabric AI for search (https://s.jina.ai/)
 */
export async function searchAndAnalyzeHybrid(options: {
	question: string;
	pattern: FabricPattern;
	variables?: Record<string, string>;
	context?: string;
	strategy?: string;
	userContext: UserContext;
	temperature?: number;
	fabricConfig?: Partial<FabricConfig>;
}): Promise<HybridExecutionResult> {
	const {
		question,
		pattern,
		variables,
		context,
		strategy,
		userContext,
		temperature,
		fabricConfig,
	} = options;

	try {
		// 1. Search web via Fabric AI's Jina integration (no AI needed)
		const fabricClient = createFabricClient(fabricConfig);
		const searchResults = await fabricClient.searchWeb(question);

		// 2. Execute pattern with user's AI
		return await executePatternHybrid({
			input: searchResults,
			pattern,
			variables: {
				...variables,
				question,
			},
			context,
			strategy,
			userContext,
			temperature,
			fabricConfig,
		});
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		return {
			output: "",
			success: false,
			error: errorMessage,
			metadata: {
				pattern,
				model: "unknown",
				taskType: getTaskTypeForPattern(pattern),
				executionMode: "hybrid",
			},
		};
	}
}
