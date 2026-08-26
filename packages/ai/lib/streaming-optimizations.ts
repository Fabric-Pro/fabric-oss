/**
 * AI Streaming Optimizations for High-Speed Inference Engines
 *
 * This module provides optimized streaming configurations for different AI providers
 * to ensure smooth, fast streaming without artificial delays.
 *
 * Groq Optimization:
 * - Reduces smoothStream delay from default 10ms to 1ms for near-instant streaming
 * - Uses "word" chunking for optimal token delivery
 * - Prevents buffering artifacts that cause "bursty" output
 *
 * Performance Characteristics:
 * - Groq: Up to 1000 tokens/second with minimal latency
 * - Optimized for real-time UX with sub-millisecond delays
 * - Maintains text coherence while maximizing streaming speed
 */

import { smoothStream } from "ai";

/**
 * Configuration for high-speed inference engines like Groq
 * Optimized for streaming speeds up to 1000 tokens/second
 */
export const GROQ_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		// Reduce delay from default 10ms to 1ms for near-instant streaming
		delayInMs: 1,
		// Use word-level chunking for optimal token delivery
		chunking: "word",
	}),
};

/**
 * Configuration for standard-speed providers (OpenAI, Anthropic, etc.)
 * Balances smoothness with performance
 */
export const STANDARD_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		// Default 10ms delay for smooth but not overly delayed streaming
		delayInMs: 10,
		// Word-level chunking for good balance
		chunking: "word",
	}),
};

/**
 * Configuration for ultra-fast streaming with minimal smoothing
 * Use for applications requiring maximum responsiveness
 */
export const ULTRA_FAST_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		// Minimal delay for ultra-fast streaming
		delayInMs: 1,
		// Word-level chunking
		chunking: "word",
	}),
};

/**
 * Configuration for smooth, conversational streaming
 * Use for chat applications where natural flow is important
 */
export const CONVERSATIONAL_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		// Slightly longer delay for more natural conversation flow
		delayInMs: 15,
		// Word-level chunking
		chunking: "word",
	}),
};

/**
 * Helper function to get the optimal streaming configuration for a model
 * Based on provider and model characteristics
 */
export function getOptimalStreamingConfig(model: string) {
	// Extract provider from model string (e.g., "groq/llama-3.3-70b-versatile" → "groq")
	const provider = model.split("/")[0].toLowerCase();

	switch (provider) {
		case "groq":
			// Groq supports ultra-fast inference (up to 1000 tokens/sec)
			return GROQ_STREAMING_CONFIG;

		case "openai":
		case "anthropic":
		case "deepseek":
			// Standard providers with normal speeds
			return STANDARD_STREAMING_CONFIG;

		case "ollama":
		case "local":
			// Local models can be very fast
			return ULTRA_FAST_STREAMING_CONFIG;

		default:
			// Default to standard for unknown providers
			return STANDARD_STREAMING_CONFIG;
	}
}

/**
 * Get streaming configuration based on task type
 */
export function getStreamingConfigForTask(
	taskType: "chat" | "generation" | "tool" | "reasoning",
) {
	switch (taskType) {
		case "chat":
			// Chat benefits from smooth but responsive streaming
			return GROQ_STREAMING_CONFIG;

		case "generation":
			// Document generation can handle faster streaming
			return ULTRA_FAST_STREAMING_CONFIG;

		case "tool":
			// Tool calling needs responsive feedback
			return GROQ_STREAMING_CONFIG;

		case "reasoning":
			// Reasoning tasks often have longer outputs, balance speed and readability
			return STANDARD_STREAMING_CONFIG;

		default:
			return STANDARD_STREAMING_CONFIG;
	}
}
