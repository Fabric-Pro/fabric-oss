/**
 * Streaming Configuration
 *
 * This module provides streaming configurations for LLM responses.
 *
 * The key issue with fast providers (Groq, Cerebras, etc.) is token generation speed:
 * - Cerebras: 1000+ tokens/sec (~4000-5000 chars/sec)
 * - Groq: 300+ tokens/sec
 * - Standard providers: 50-100 tokens/sec
 *
 * Without smoothing, ultra-fast providers dump text faster than users can read,
 * creating a jarring experience where text appears all at once.
 *
 * We use smoothStream with provider-specific delays to create readable streaming:
 * - Ultra-fast (Cerebras): Line-level chunking with 15ms delay
 * - Fast (Groq): Word-level chunking with 8ms delay
 * - Standard: Raw streaming for lowest latency
 */

import { smoothStream } from "ai";

/**
 * Enhanced Response component configuration
 * Prevents paragraph accumulation and buffering
 */
export const ENHANCED_RESPONSE_CONFIG = {
	parseIncompleteMarkdown: true,
	// Disable any internal buffering
	isAnimating: false,
	// Force immediate rendering
	className: "streaming-response",
};

/**
 * Ultra-fast provider streaming (Cerebras: 1000+ tokens/sec)
 * Uses line-level chunking to batch into readable units
 * Higher delay spreads tokens over time for smooth UX
 */
export const ULTRA_FAST_CEREBRAS_STREAMING = {
	experimental_transform: smoothStream({
		// 15ms delay - creates ~66 chunks/sec for readable flow
		delayInMs: 15,
		// Line-level chunking batches into complete sentences/lines
		chunking: "line" as const,
	}),
};

/**
 * Fast provider streaming (Groq: 300+ tokens/sec)
 * Word-level chunking with moderate delay
 */
export const FAST_GROQ_STREAMING = {
	experimental_transform: smoothStream({
		// 8ms delay for word-by-word appearance
		delayInMs: 8,
		// Word-level chunking for natural reading
		chunking: "word" as const,
	}),
};

/**
 * Moderate-speed provider streaming (Together AI, Fireworks, etc.)
 * Light smoothing for consistent experience
 */
export const MODERATE_STREAMING = {
	experimental_transform: smoothStream({
		// 5ms delay for light smoothing
		delayInMs: 5,
		// Word-level chunking
		chunking: "word" as const,
	}),
};

/**
 * Raw streaming - no transforms, no buffering
 * Best for slow providers where every ms of latency matters
 */
export const RAW_STREAMING = {
	// No experimental_transform - let tokens flow immediately
};

/**
 * Ultra-fast providers that need aggressive smoothing
 * These providers can generate 500+ tokens/sec
 */
const ULTRA_FAST_PROVIDERS = ["cerebras"];

/**
 * Fast providers that need moderate smoothing
 * These providers generate 200-500 tokens/sec
 */
const FAST_PROVIDERS = ["groq"];

/**
 * Moderate-speed providers that benefit from light smoothing
 * These providers generate 100-200 tokens/sec
 */
const MODERATE_PROVIDERS = ["together", "fireworks", "sambanova"];

/**
 * Get the streaming configuration for a given model
 *
 * @param model - Model identifier (e.g., "groq/llama-3.3-70b-versatile", "cerebras/llama-3.3-70b")
 * @returns Streaming configuration
 */
export function getAggressiveStreamingConfig(model: string) {
	const provider = model.split("/")[0].toLowerCase();

	// Cerebras: 1000+ tokens/sec - needs aggressive smoothing
	if (ULTRA_FAST_PROVIDERS.includes(provider)) {
		return {
			aiConfig: ULTRA_FAST_CEREBRAS_STREAMING,
			responseConfig: ENHANCED_RESPONSE_CONFIG,
		};
	}

	// Groq: 300+ tokens/sec - moderate smoothing
	if (FAST_PROVIDERS.includes(provider)) {
		return {
			aiConfig: FAST_GROQ_STREAMING,
			responseConfig: ENHANCED_RESPONSE_CONFIG,
		};
	}

	// Together, Fireworks, etc: 100-200 tokens/sec - light smoothing
	if (MODERATE_PROVIDERS.includes(provider)) {
		return {
			aiConfig: MODERATE_STREAMING,
			responseConfig: ENHANCED_RESPONSE_CONFIG,
		};
	}

	// Standard providers (OpenAI, Anthropic, etc): raw streaming
	// These providers stream at readable speeds naturally
	return {
		aiConfig: RAW_STREAMING,
		responseConfig: ENHANCED_RESPONSE_CONFIG,
	};
}

/**
 * Debug function - returns raw streaming for debugging
 */
export function createDebugStreamingConfig() {
	return RAW_STREAMING;
}
