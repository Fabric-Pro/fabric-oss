/**
 * Unified Fabric AI Executor
 *
 * This module provides a unified interface for executing Fabric patterns
 * across all three modes: hybrid, delegated, and full.
 *
 * Mode selection is determined by:
 * 1. Explicit mode parameter
 * 2. FABRIC_AI_MODE environment variable
 * 3. Default: "hybrid" (most secure for multi-tenant)
 *
 * Environment Variables:
 * - FABRIC_AI_MODE: "hybrid" | "delegated" | "full"
 * - FABRIC_AI_URL: Base URL for Fabric AI server
 * - FABRIC_AI_API_KEY: API key for Fabric AI server authentication
 * - FABRIC_AI_TIMEOUT: Request timeout in milliseconds
 */

import { logger } from "@repo/logs";
import { createFabricClient } from "./client";
import {
	type DelegatedExecutionResult,
	executePatternDelegated,
	executePatternDelegatedStream,
	isDelegatedModeSupported,
} from "./delegated-executor";
import {
	analyzeYouTubeFull,
	executePatternFull,
	executePatternFullStream,
	type FullExecutionResult,
} from "./full-executor";
import {
	analyzeYouTubeHybrid,
	executePatternHybrid,
	executePatternHybridStream,
	type HybridExecutionResult,
	type UserContext,
} from "./hybrid-executor";
import type { FabricAIMode, FabricConfig, FabricPattern } from "./types";

/**
 * Get the configured Fabric AI mode from environment or default
 */
export function getFabricAIMode(): FabricAIMode {
	const mode = process.env.FABRIC_AI_MODE?.toLowerCase();
	if (mode === "hybrid" || mode === "delegated" || mode === "full") {
		return mode;
	}
	return "hybrid"; // Default to most secure mode
}

/**
 * Unified execution options that work across all modes
 */
export interface FabricExecutionOptions {
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
	/** Temperature for AI generation (0-1) */
	temperature?: number;
	/** Override the task type for model selection (hybrid/delegated only) */
	taskType?: string;
	/** User context for model resolution (required for hybrid/delegated modes) */
	userContext?: UserContext;
	/** AI vendor to use (full mode only, ignored in hybrid/delegated) */
	vendor?: string;
	/** AI model to use (full mode only, ignored in hybrid/delegated) */
	model?: string;
	/** Override the execution mode */
	mode?: FabricAIMode;
	/** Fabric AI config overrides */
	fabricConfig?: Partial<FabricConfig>;
}

/**
 * Unified execution result
 */
export type FabricExecutionResult = (
	| HybridExecutionResult
	| DelegatedExecutionResult
	| FullExecutionResult
) & {
	mode: FabricAIMode;
};

/**
 * Execute a Fabric pattern using the appropriate mode
 *
 * Mode selection priority:
 * 1. Explicit mode in options
 * 2. FABRIC_AI_MODE environment variable
 * 3. Default: "hybrid"
 *
 * For hybrid/delegated modes, userContext is required.
 * For full mode, vendor/model can be specified (defaults to openai and catalog default model).
 */
export async function executeFabricPattern(
	options: FabricExecutionOptions,
): Promise<FabricExecutionResult> {
	const mode = options.mode || getFabricAIMode();

	logger.info("Executing Fabric pattern", {
		pattern: options.pattern,
		mode,
		hasUserContext: !!options.userContext,
	});

	switch (mode) {
		case "hybrid": {
			if (!options.userContext) {
				return {
					output: "",
					success: false,
					error: "User context required for hybrid mode. Pass userContext with userId and optionally organizationId.",
					metadata: {
						pattern: options.pattern,
						model: "unknown",
						taskType: options.taskType || "unknown",
						executionMode: "hybrid",
					},
					mode: "hybrid",
				};
			}
			const result = await executePatternHybrid({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				userContext: options.userContext,
				temperature: options.temperature,
				taskType: options.taskType,
				fabricConfig: options.fabricConfig,
			});
			return { ...result, mode: "hybrid" };
		}

		case "delegated": {
			if (!options.userContext) {
				return {
					output: "",
					success: false,
					error: "User context required for delegated mode. Pass userContext with userId and optionally organizationId.",
					metadata: {
						pattern: options.pattern,
						model: "unknown",
						vendor: "unknown",
						taskType: options.taskType || "unknown",
						executionMode: "delegated",
					},
					mode: "delegated",
				};
			}

			// Check if delegated mode is supported
			const supported = await isDelegatedModeSupported(
				options.fabricConfig,
			);
			if (!supported) {
				logger.warn(
					"Delegated mode not supported, falling back to hybrid mode",
				);
				const result = await executePatternHybrid({
					input: options.input,
					pattern: options.pattern,
					variables: options.variables,
					context: options.context,
					strategy: options.strategy,
					userContext: options.userContext,
					temperature: options.temperature,
					taskType: options.taskType,
					fabricConfig: options.fabricConfig,
				});
				return { ...result, mode: "hybrid" };
			}

			const result = await executePatternDelegated({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				userContext: options.userContext,
				temperature: options.temperature,
				taskType: options.taskType,
				fabricConfig: options.fabricConfig,
			});
			return { ...result, mode: "delegated" };
		}

		case "full": {
			const result = await executePatternFull({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				temperature: options.temperature,
				vendor: options.vendor,
				model: options.model,
				fabricConfig: options.fabricConfig,
			});
			return { ...result, mode: "full" };
		}

		default: {
			// TypeScript exhaustiveness check
			const _exhaustive: never = mode;
			throw new Error(`Unknown Fabric AI mode: ${_exhaustive}`);
		}
	}
}

/**
 * Execute a Fabric pattern with streaming
 */
export async function* executeFabricPatternStream(
	options: FabricExecutionOptions,
): AsyncGenerator<{
	type: "content" | "error" | "complete";
	content: string;
	mode?: FabricAIMode;
}> {
	const mode = options.mode || getFabricAIMode();

	switch (mode) {
		case "hybrid": {
			if (!options.userContext) {
				yield {
					type: "error",
					content: "User context required for hybrid mode",
					mode,
				};
				return;
			}
			for await (const event of executePatternHybridStream({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				userContext: options.userContext,
				temperature: options.temperature,
				taskType: options.taskType,
				fabricConfig: options.fabricConfig,
			})) {
				yield { ...event, mode };
			}
			break;
		}

		case "delegated": {
			if (!options.userContext) {
				yield {
					type: "error",
					content: "User context required for delegated mode",
					mode,
				};
				return;
			}

			// Check if delegated mode is supported
			const supported = await isDelegatedModeSupported(
				options.fabricConfig,
			);
			if (!supported) {
				logger.warn(
					"Delegated mode not supported, falling back to hybrid mode",
				);
				for await (const event of executePatternHybridStream({
					input: options.input,
					pattern: options.pattern,
					variables: options.variables,
					context: options.context,
					strategy: options.strategy,
					userContext: options.userContext,
					temperature: options.temperature,
					taskType: options.taskType,
					fabricConfig: options.fabricConfig,
				})) {
					yield { ...event, mode: "hybrid" };
				}
				return;
			}

			for await (const event of executePatternDelegatedStream({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				userContext: options.userContext,
				temperature: options.temperature,
				taskType: options.taskType,
				fabricConfig: options.fabricConfig,
			})) {
				yield { ...event, mode };
			}
			break;
		}

		case "full": {
			for await (const event of executePatternFullStream({
				input: options.input,
				pattern: options.pattern,
				variables: options.variables,
				context: options.context,
				strategy: options.strategy,
				temperature: options.temperature,
				vendor: options.vendor,
				model: options.model,
				fabricConfig: options.fabricConfig,
			})) {
				yield { ...event, mode };
			}
			break;
		}
	}
}

/**
 * YouTube analysis options
 */
export interface YouTubeAnalysisOptions {
	/** YouTube video URL */
	url: string;
	/** The pattern name to execute */
	pattern: FabricPattern;
	/** Pattern variables to substitute */
	variables?: Record<string, string>;
	/** Temperature for AI generation (0-1) */
	temperature?: number;
	/** User context for model resolution (required for hybrid/delegated modes) */
	userContext?: UserContext;
	/** AI vendor to use (full mode only) */
	vendor?: string;
	/** AI model to use (full mode only) */
	model?: string;
	/** Override the execution mode */
	mode?: FabricAIMode;
	/** Fabric AI config overrides */
	fabricConfig?: Partial<FabricConfig>;
}

/**
 * Analyze a YouTube video using Fabric AI
 *
 * 1. Extracts transcript via Fabric AI (no AI needed)
 * 2. Executes pattern using the configured mode
 */
export async function analyzeYouTube(
	options: YouTubeAnalysisOptions,
): Promise<
	FabricExecutionResult & { videoInfo?: { title: string; videoId: string } }
> {
	const mode = options.mode || getFabricAIMode();

	switch (mode) {
		case "hybrid": {
			if (!options.userContext) {
				return {
					output: "",
					success: false,
					error: "User context required for hybrid mode",
					metadata: {
						pattern: options.pattern,
						model: "unknown",
						taskType: "unknown",
						executionMode: "hybrid",
					},
					mode: "hybrid",
				};
			}
			const result = await analyzeYouTubeHybrid({
				url: options.url,
				pattern: options.pattern,
				variables: options.variables,
				userContext: options.userContext,
				temperature: options.temperature,
				fabricConfig: options.fabricConfig,
			});
			return { ...result, mode: "hybrid" };
		}

		case "delegated": {
			// For YouTube analysis in delegated mode, we still extract transcript locally
			// then use delegated execution for the pattern
			if (!options.userContext) {
				return {
					output: "",
					success: false,
					error: "User context required for delegated mode",
					metadata: {
						pattern: options.pattern,
						model: "unknown",
						vendor: "unknown",
						taskType: "unknown",
						executionMode: "delegated",
					},
					mode: "delegated",
				};
			}

			const fabricClient = createFabricClient(options.fabricConfig);
			const transcriptResult =
				await fabricClient.extractYouTubeTranscript(options.url);

			const result = await executePatternDelegated({
				input: transcriptResult.transcript,
				pattern: options.pattern,
				variables: {
					...options.variables,
					title: transcriptResult.title,
					videoId: transcriptResult.videoId,
				},
				userContext: options.userContext,
				temperature: options.temperature,
				fabricConfig: options.fabricConfig,
			});

			return {
				...result,
				videoInfo: {
					title: transcriptResult.title,
					videoId: transcriptResult.videoId,
				},
				mode: "delegated",
			};
		}

		case "full": {
			const result = await analyzeYouTubeFull({
				url: options.url,
				pattern: options.pattern,
				variables: options.variables,
				vendor: options.vendor,
				model: options.model,
				temperature: options.temperature,
				fabricConfig: options.fabricConfig,
			});
			return { ...result, mode: "full" };
		}
	}
}

/**
 * Get available Fabric patterns
 */
export async function listFabricPatterns(
	fabricConfig?: Partial<FabricConfig>,
): Promise<string[]> {
	const client = createFabricClient(fabricConfig);
	return client.listPatterns();
}

/**
 * Get a specific pattern template
 */
export async function getFabricPattern(
	name: string,
	fabricConfig?: Partial<FabricConfig>,
): Promise<string> {
	const client = createFabricClient(fabricConfig);
	return client.getPattern(name);
}

/**
 * Get available strategies
 */
export async function listFabricStrategies(
	fabricConfig?: Partial<FabricConfig>,
): Promise<{ name: string; description: string; prompt: string }[]> {
	const client = createFabricClient(fabricConfig);
	return client.listStrategies();
}

/**
 * Get available contexts
 */
export async function listFabricContexts(
	fabricConfig?: Partial<FabricConfig>,
): Promise<string[]> {
	const client = createFabricClient(fabricConfig);
	return client.listContexts();
}

/**
 * Extract YouTube transcript (no AI needed)
 */
export async function extractYouTubeTranscript(
	url: string,
	timestamps = false,
	fabricConfig?: Partial<FabricConfig>,
): Promise<{
	videoId: string;
	title: string;
	description: string;
	transcript: string;
}> {
	const client = createFabricClient(fabricConfig);
	return client.extractYouTubeTranscript(url, timestamps);
}

/**
 * Check Fabric AI server health
 */
export async function checkFabricAIHealth(
	fabricConfig?: Partial<FabricConfig>,
): Promise<{
	healthy: boolean;
	mode: FabricAIMode;
	delegatedSupported: boolean;
}> {
	const client = createFabricClient(fabricConfig);
	const healthy = await client.healthCheck();
	const delegatedSupported = await isDelegatedModeSupported(fabricConfig);

	return {
		healthy,
		mode: getFabricAIMode(),
		delegatedSupported,
	};
}
