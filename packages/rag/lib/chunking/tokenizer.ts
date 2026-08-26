/**
 * Tokenizer module for accurate token counting
 *
 * Uses tiktoken (OpenAI's tokenizer) for accurate token counting.
 * This is especially important for:
 * - Ensuring chunks fit within embedding model limits
 * - Accurate cost estimation
 * - Consistent chunking across different content types
 *
 * Supports lazy initialization to avoid loading the tokenizer
 * until it's actually needed.
 */

import { logger } from "@repo/logs";
import { getEncoding, type Tiktoken } from "js-tiktoken";

/**
 * Supported tokenizer encodings
 * - cl100k_base: Used by GPT-4, GPT-3.5-turbo, text-embedding-3-*
 * - o200k_base: Used by GPT-4o, GPT-4o-mini
 */
export type TokenizerEncoding = "cl100k_base" | "o200k_base";

/**
 * Default encoding for text-embedding-3-small/large models
 */
const DEFAULT_ENCODING: TokenizerEncoding = "cl100k_base";

/**
 * Cached tokenizer instances (lazy initialized)
 */
const encoderCache = new Map<TokenizerEncoding, Tiktoken>();

/**
 * Get or create a tokenizer for the specified encoding
 * Uses lazy initialization and caching for performance
 */
function getTokenizer(
	encoding: TokenizerEncoding = DEFAULT_ENCODING,
): Tiktoken {
	let encoder = encoderCache.get(encoding);

	if (!encoder) {
		logger.debug(`[Tokenizer] Initializing ${encoding} encoder`);
		encoder = getEncoding(encoding);
		encoderCache.set(encoding, encoder);
	}

	return encoder;
}

/**
 * Count tokens in text using tiktoken
 *
 * @param text - Text to count tokens for
 * @param encoding - Tokenizer encoding to use (default: cl100k_base for embeddings)
 * @returns Exact token count
 */
export function countTokens(
	text: string,
	encoding: TokenizerEncoding = DEFAULT_ENCODING,
): number {
	if (!text || text.length === 0) {
		return 0;
	}

	const encoder = getTokenizer(encoding);
	return encoder.encode(text).length;
}

/**
 * Count tokens for multiple texts efficiently
 *
 * @param texts - Array of texts to count tokens for
 * @param encoding - Tokenizer encoding to use
 * @returns Array of token counts
 */
export function countTokensBatch(
	texts: string[],
	encoding: TokenizerEncoding = DEFAULT_ENCODING,
): number[] {
	const encoder = getTokenizer(encoding);
	return texts.map((text) => (text ? encoder.encode(text).length : 0));
}

/**
 * Convert token count to approximate character count
 * Based on OpenAI's rule of thumb: 1 token ≈ 4 characters for English
 *
 * @param tokens - Number of tokens
 * @returns Approximate character count
 */
export function tokensToChars(tokens: number): number {
	return tokens * 4;
}

/**
 * Convert character count to approximate token count
 * This is a fast estimate without using the tokenizer
 *
 * @param chars - Number of characters
 * @returns Approximate token count
 */
export function charsToTokensEstimate(chars: number): number {
	return Math.ceil(chars / 4);
}

/**
 * Truncate text to a maximum number of tokens
 *
 * @param text - Text to truncate
 * @param maxTokens - Maximum number of tokens
 * @param encoding - Tokenizer encoding to use
 * @returns Truncated text
 */
export function truncateToTokens(
	text: string,
	maxTokens: number,
	encoding: TokenizerEncoding = DEFAULT_ENCODING,
): string {
	if (!text || maxTokens <= 0) {
		return "";
	}

	const encoder = getTokenizer(encoding);
	const tokens = encoder.encode(text);

	if (tokens.length <= maxTokens) {
		return text;
	}

	const truncatedTokens = tokens.slice(0, maxTokens);
	return encoder.decode(truncatedTokens);
}

/**
 * Split text into chunks of approximately maxTokens each
 * with specified overlap
 *
 * @param text - Text to split
 * @param maxTokens - Maximum tokens per chunk
 * @param overlapTokens - Number of overlapping tokens between chunks
 * @param encoding - Tokenizer encoding to use
 * @returns Array of text chunks
 */
export function splitByTokens(
	text: string,
	maxTokens: number,
	overlapTokens = 0,
	encoding: TokenizerEncoding = DEFAULT_ENCODING,
): string[] {
	if (!text || maxTokens <= 0) {
		return [];
	}

	const encoder = getTokenizer(encoding);
	const tokens = encoder.encode(text);

	if (tokens.length <= maxTokens) {
		return [text];
	}

	const chunks: string[] = [];
	let start = 0;

	while (start < tokens.length) {
		const end = Math.min(start + maxTokens, tokens.length);
		const chunkTokens = tokens.slice(start, end);
		chunks.push(encoder.decode(chunkTokens));

		// Move forward with overlap
		start = end - overlapTokens;
		if (start >= tokens.length || end === tokens.length) {
			break;
		}
	}

	return chunks;
}
