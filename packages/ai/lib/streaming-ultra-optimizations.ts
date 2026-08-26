/**
 * Enhanced Streaming Configuration for AI Response Components
 *
 * This module provides advanced streaming optimizations that address
 * paragraph-level buffering issues in AI responses.
 *
 * The Problem:
 * When AI generates multi-paragraph responses, users often see:
 * 1. Complete paragraph 1
 * 2. Long pause
 * 3. Paragraphs 2-3 appear suddenly
 *
 * Root Causes:
 * - Markdown parsers waiting for complete paragraph blocks
 * - React component re-rendering on paragraph completion
 * - Streamdown's incomplete markdown handling
 * - Text processing pipeline buffering
 *
 * Solutions:
 * - Ultra-aggressive streaming with minimal delays
 * - Character-level chunking for paragraph boundaries
 * - Disable paragraph-level buffering
 * - Optimize for continuous text flow
 */

import { smoothStream } from "ai";

/**
 * Ultra-fast streaming configuration for Groq
 * Addresses paragraph buffering by using character-level chunking
 * and minimal delays at paragraph boundaries
 */
export const GROQ_ULTRA_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		// Reduce delay to absolute minimum (0.5ms) for near-instant streaming
		delayInMs: 0.5,
		// Use character-level chunking to prevent paragraph buffering
		// This ensures tokens flow continuously across paragraph boundaries
		chunking: /\S/m, // Match any non-whitespace character
	}),
};

/**
 * Standard ultra-fast configuration for other high-speed providers
 */
export const ULTRA_FAST_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		delayInMs: 0.5,
		chunking: /\S/m, // Character-level chunking
	}),
};

/**
 * Conversational streaming with minimal paragraph delays
 */
export const CONVERSATIONAL_ULTRA_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		delayInMs: 1,
		chunking: /\S/m, // Character-level for smooth conversation flow
	}),
};

/**
 * Get ultra-fast streaming configuration based on model
 */
export function getUltraFastStreamingConfig(model: string) {
	const provider = model.split("/")[0].toLowerCase();

	switch (provider) {
		case "groq":
			return GROQ_ULTRA_STREAMING_CONFIG;
		case "ollama":
		case "local":
			return ULTRA_FAST_STREAMING_CONFIG;
		default:
			return CONVERSATIONAL_ULTRA_STREAMING_CONFIG;
	}
}

/**
 * Get streaming configuration optimized for continuous text flow
 * Prevents paragraph-level buffering
 */
export function getContinuousStreamingConfig(
	taskType: "chat" | "generation" | "tool" | "reasoning",
) {
	switch (taskType) {
		case "chat":
		case "generation":
			return GROQ_ULTRA_STREAMING_CONFIG;
		default:
			return CONVERSATIONAL_ULTRA_STREAMING_CONFIG;
	}
}

/**
 * Legacy configurations for backward compatibility
 */
export const GROQ_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		delayInMs: 1,
		chunking: "word",
	}),
};

export const STANDARD_STREAMING_CONFIG = {
	experimental_transform: smoothStream({
		delayInMs: 10,
		chunking: "word",
	}),
};

/**
 * Get optimal streaming configuration for any model
 * Now includes ultra-fast options for paragraph-level streaming
 */
export function getOptimalStreamingConfig(model: string) {
	const provider = model.split("/")[0].toLowerCase();

	switch (provider) {
		case "groq":
			// Use ultra-fast configuration for Groq to prevent paragraph buffering
			return GROQ_ULTRA_STREAMING_CONFIG;
		case "openai":
		case "anthropic":
		case "deepseek":
			return CONVERSATIONAL_ULTRA_STREAMING_CONFIG;
		case "ollama":
		case "local":
			return ULTRA_FAST_STREAMING_CONFIG;
		default:
			return CONVERSATIONAL_ULTRA_STREAMING_CONFIG;
	}
}
