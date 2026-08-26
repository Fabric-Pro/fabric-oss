/**
 * Full Mode Executor for Fabric AI
 *
 * This module executes Fabric patterns using Fabric AI's own configured API keys.
 * No user isolation - all users share the same API keys configured on the Fabric AI server.
 *
 * Use cases:
 * - Single-user deployments
 * - Team deployments with shared API costs
 * - Testing and development
 *
 * WARNING: This mode does NOT provide user isolation. All users share the same
 * API keys and costs. Use Hybrid or Delegated mode for multi-tenant deployments.
 */

import { DEFAULT_MODELS } from "@repo/database/prisma/ai-model-catalog";
import { logger } from "@repo/logs";
import { createFabricClient } from "./client";
import type { FabricConfig, FabricPattern } from "./types";

// Default model from catalog (canonical name matches OpenAI Direct model ID)
const DEFAULT_FABRIC_MODEL = DEFAULT_MODELS.COMPLEX;

/**
 * Options for full mode pattern execution
 */
export interface FullExecutionOptions {
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
	/** AI vendor to use (e.g., "openai", "anthropic") - uses Fabric AI's configured keys */
	vendor?: string;
	/** AI model to use */
	model?: string;
	/** Fabric AI config overrides */
	fabricConfig?: Partial<FabricConfig>;
}

/**
 * Result from full mode pattern execution
 */
export interface FullExecutionResult {
	output: string;
	success: boolean;
	error?: string;
	metadata: {
		pattern: string;
		vendor: string;
		model: string;
		executionMode: "full";
	};
}

/**
 * Execute a Fabric pattern using Fabric AI's own API keys (Full Mode)
 *
 * This uses the /chat endpoint with Fabric AI's server-configured API keys.
 * No user isolation - suitable for single-user or team deployments.
 */
export async function executePatternFull(
	options: FullExecutionOptions,
): Promise<FullExecutionResult> {
	const {
		input,
		pattern,
		variables,
		context,
		strategy,
		temperature = 0.7,
		vendor = "openai",
		model = DEFAULT_FABRIC_MODEL,
		fabricConfig,
	} = options;

	try {
		const fabricClient = createFabricClient(fabricConfig);

		// Use the standard executePattern method which calls /chat
		const result = await fabricClient.executePattern({
			input,
			pattern,
			vendor,
			model,
			variables,
			context,
			strategy,
			temperature,
		});

		return {
			output: result,
			success: true,
			metadata: {
				pattern,
				vendor,
				model,
				executionMode: "full",
			},
		};
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		logger.error("Full mode pattern execution failed", {
			pattern,
			error: errorMessage,
		});
		return {
			output: "",
			success: false,
			error: errorMessage,
			metadata: {
				pattern,
				vendor,
				model,
				executionMode: "full",
			},
		};
	}
}

/**
 * Execute a Fabric pattern with streaming using Fabric AI's own API keys
 */
export async function* executePatternFullStream(
	options: FullExecutionOptions,
): AsyncGenerator<{ type: "content" | "error" | "complete"; content: string }> {
	const {
		input,
		pattern,
		variables,
		context,
		strategy,
		temperature = 0.7,
		vendor = "openai",
		model = DEFAULT_FABRIC_MODEL,
		fabricConfig,
	} = options;

	try {
		const fabricClient = createFabricClient(fabricConfig);

		for await (const event of fabricClient.executePatternStream({
			input,
			pattern,
			vendor,
			model,
			variables,
			context,
			strategy,
			temperature,
		})) {
			if (event.type === "content") {
				yield { type: "content", content: event.content };
			} else if (event.type === "error") {
				yield { type: "error", content: event.content };
			} else if (event.type === "complete") {
				yield { type: "complete", content: "" };
			}
		}
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		yield { type: "error", content: errorMessage };
	}
}

/**
 * Analyze YouTube video using full mode
 */
export async function analyzeYouTubeFull(options: {
	url: string;
	pattern: FabricPattern;
	variables?: Record<string, string>;
	vendor?: string;
	model?: string;
	temperature?: number;
	fabricConfig?: Partial<FabricConfig>;
}): Promise<
	FullExecutionResult & { videoInfo?: { title: string; videoId: string } }
> {
	const {
		url,
		pattern,
		variables,
		vendor,
		model,
		temperature,
		fabricConfig,
	} = options;

	try {
		const fabricClient = createFabricClient(fabricConfig);

		// Extract transcript
		const transcriptResult =
			await fabricClient.extractYouTubeTranscript(url);

		// Execute pattern with Fabric AI's keys
		const result = await executePatternFull({
			input: transcriptResult.transcript,
			pattern,
			variables: {
				...variables,
				title: transcriptResult.title,
				videoId: transcriptResult.videoId,
			},
			vendor,
			model,
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
				vendor: vendor || "openai",
				model: model || DEFAULT_FABRIC_MODEL,
				executionMode: "full",
			},
		};
	}
}
