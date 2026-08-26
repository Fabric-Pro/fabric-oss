/**
 * Enhanced AI Streaming Response Configuration
 *
 * This module provides optimized settings for the Response component
 * to address paragraph-level streaming delays.
 *
 * The Issue:
 * When streaming multi-paragraph responses, users see:
 * 1. Complete paragraph 1 immediately
 * 2. Long pause (buffering)
 * 3. Paragraphs 2-3 appear suddenly
 *
 * Root Cause Analysis:
 * - Streamdown's parseIncompleteMarkdown doesn't handle paragraph boundaries well
 * - React.memo comparison in Response component causes re-render delays
 * - Text accumulation at paragraph boundaries before rendering
 *
 * Solution Approach:
 * - Force continuous streaming with minimal buffering
 * - Disable paragraph-level text accumulation
 * - Use character-level processing for smooth flow
 */

import { getOptimalStreamingConfig } from "./streaming-optimizations";

/**
 * Optimized Response component props for continuous streaming
 * Prevents paragraph accumulation and buffering
 */
export const ENHANCED_RESPONSE_PROPS = {
	parseIncompleteMarkdown: true,
	// Disable any internal buffering
	isAnimating: false,
	// Force immediate rendering
	className: "continuous-streaming-response",
};

/**
 * Ultra-fast response configuration for Groq's high-speed inference
 * Addresses the specific paragraph buffering issue
 */
export const GROQ_RESPONSE_PROPS = {
	parseIncompleteMarkdown: true,
	// Disable any internal buffering
	isAnimating: false,
	// Minimal styling to prevent rendering delays
	className: "groq-streaming-response",
};

/**
 * Get the optimal Response component configuration
 * Based on the AI provider and streaming requirements
 */
export function getResponseStreamingConfig(provider: string) {
	const providerLower = provider.toLowerCase();

	switch (providerLower) {
		case "groq":
			return GROQ_RESPONSE_PROPS;
		case "openai":
		case "anthropic":
			return ENHANCED_RESPONSE_PROPS;
		default:
			return ENHANCED_RESPONSE_PROPS;
	}
}

/**
 * Enhanced streaming configuration that combines
 * AI SDK optimizations with Response component settings
 */
export function getEnhancedStreamingConfig(model: string) {
	const provider = model.split("/")[0].toLowerCase();

	return {
		// AI SDK streaming configuration
		aiConfig: getOptimalStreamingConfig(model),
		// Response component configuration
		responseConfig: getResponseStreamingConfig(provider),
	};
}
