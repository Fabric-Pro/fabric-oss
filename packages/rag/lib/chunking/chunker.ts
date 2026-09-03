/**
 * Advanced Text Chunking Utilities
 *
 * Implements multiple chunking strategies for optimal RAG performance:
 * - Fixed: Simple character-based splitting
 * - Recursive: Hierarchical splitting with priority separators
 * - Document: Structure-aware splitting for markdown/code
 * - Paragraph: Default paragraph-based splitting
 * - Sentence: Fine-grained sentence-level splitting
 *
 * Best practices incorporated:
 * - 512 tokens (2048 chars) as baseline chunk size
 * - 50-100 token (200-400 char) overlap for context continuity
 * - Preserve sentence boundaries when possible
 * - Content-type aware strategy selection
 * - Accurate token counting using tiktoken
 *
 * @see https://weaviate.io/blog/chunking-strategies-for-rag
 */

import { logger } from "@repo/logs";
import { charsToTokensEstimate, countTokens } from "./tokenizer";
import type {
	ChunkingOptions,
	ChunkingResult,
	ContentTypeInfo,
	TextChunk,
} from "./types";

/**
 * Default chunking options optimized for RAG
 *
 * Based on research:
 * - 512 tokens ≈ 2048 chars is a good starting point
 * - 50-100 token overlap maintains context across chunks
 */
const DEFAULT_OPTIONS: Required<
	Omit<ChunkingOptions, "separators" | "semanticThreshold" | "contentType">
> = {
	strategy: "PARAGRAPH",
	chunkSize: 2048, // ≈512 tokens
	chunkOverlap: 200, // ≈50 tokens (10% overlap)
	separator: "\n\n",
	minChunkSize: 100, // Prevent tiny chunks
	preserveSentences: true,
};

/**
 * Separators for recursive chunking, in priority order
 * Tries to split at natural document boundaries
 */
const RECURSIVE_SEPARATORS = [
	"\n\n\n", // Triple newline (major section break)
	"\n\n", // Double newline (paragraph break)
	"\n", // Single newline
	". ", // Sentence boundary
	"! ", // Exclamation
	"? ", // Question
	"; ", // Semi-colon
	", ", // Comma
	" ", // Word boundary
	"", // Character-level (last resort)
];

/**
 * Markdown header pattern for document-based chunking
 */
const MARKDOWN_HEADER_REGEX = /^(#{1,6})\s+(.+)$/gm;

/**
 * Bounded prefix length for the per-line ATX header match in
 * {@link chunkMarkdown} and the content-type sniff in
 * {@link detectContentType}. A real markdown header or content-type signal
 * never needs anywhere near this many characters to show itself.
 * Bounded span: js/polynomial-redos
 */
const MAX_HEADER_LINE_CHARS = 2000;
const MAX_CONTENT_TYPE_SNIFF_CHARS = 5000;

/**
 * Sentence boundary pattern
 */
const _SENTENCE_REGEX = /[.!?]+[\s]+|[.!?]+$/g;

/**
 * Main chunking function - routes to appropriate strategy
 */
export function chunkText(
	text: string,
	filename: string,
	options: ChunkingOptions = {},
): TextChunk[] {
	const startTime = Date.now();
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const strategy = opts.strategy || "PARAGRAPH";

	logger.info(
		`[Chunker] Chunking ${text.length} chars with strategy=${strategy}, size=${opts.chunkSize}, overlap=${opts.chunkOverlap}`,
	);

	let chunks: TextChunk[];

	switch (strategy) {
		case "FIXED":
			chunks = chunkFixed(text, filename, opts);
			break;
		case "RECURSIVE":
			chunks = chunkRecursive(text, filename, opts);
			break;
		case "DOCUMENT":
			chunks = chunkDocument(text, filename, opts);
			break;
		case "SENTENCE":
			chunks = chunkSentence(text, filename, opts);
			break;
		default:
			chunks = chunkParagraph(text, filename, opts);
			break;
	}

	// Safety net: never drop non-empty content. The strategy functions discard
	// chunks below `minChunkSize` ("prevent tiny chunks"), but that filter must
	// not eliminate a document whose ENTIRE extracted text is shorter than the
	// floor — e.g. an image OCR'd/vision-extracted to a few words, or a very
	// short note. Without this, such an attachment stores 0 chunks and the model
	// reports it "can't see" the file. Emit the whole text as a single chunk.
	if (chunks.length === 0) {
		const content = text.trim();
		if (content.length > 0) {
			chunks = [
				{
					content,
					index: 0,
					metadata: {
						filename,
						startOffset: 0,
						endOffset: content.length,
					},
				},
			];
		}
	}

	// Add token estimates and strategy to metadata
	chunks = chunks.map((chunk) => ({
		...chunk,
		tokenEstimate: estimateTokenCount(chunk.content),
		metadata: {
			...chunk.metadata,
			strategy,
		},
	}));

	const processingTime = Date.now() - startTime;
	logger.info(
		`[Chunker] Created ${chunks.length} chunks in ${processingTime}ms`,
	);

	return chunks;
}

/**
 * Enhanced chunking with statistics
 */
export function chunkTextWithStats(
	text: string,
	filename: string,
	options: ChunkingOptions = {},
): ChunkingResult {
	const startTime = Date.now();
	const chunks = chunkText(text, filename, options);
	const processingTimeMs = Date.now() - startTime;

	const chunkSizes = chunks.map((c) => c.content.length);

	return {
		chunks,
		stats: {
			totalChunks: chunks.length,
			avgChunkSize:
				chunkSizes.length > 0
					? Math.round(
							chunkSizes.reduce((a, b) => a + b, 0) /
								chunkSizes.length,
						)
					: 0,
			minChunkSize: chunkSizes.length > 0 ? Math.min(...chunkSizes) : 0,
			maxChunkSize: chunkSizes.length > 0 ? Math.max(...chunkSizes) : 0,
			totalTokensEstimate: chunks.reduce(
				(sum, c) => sum + (c.tokenEstimate || 0),
				0,
			),
			strategy: options.strategy || "PARAGRAPH",
			processingTimeMs,
		},
	};
}

/**
 * Fixed-size chunking
 * Simple character-based splitting with overlap
 */
function chunkFixed(
	text: string,
	filename: string,
	opts: Required<
		Omit<
			ChunkingOptions,
			"separators" | "semanticThreshold" | "contentType"
		>
	>,
): TextChunk[] {
	const { chunkSize, chunkOverlap, minChunkSize, preserveSentences } = opts;
	const chunks: TextChunk[] = [];
	let offset = 0;
	let index = 0;

	while (offset < text.length) {
		let end = Math.min(offset + chunkSize, text.length);

		// Try to end at a sentence boundary if preserveSentences is enabled
		if (preserveSentences && end < text.length) {
			const searchStart = Math.max(offset + chunkSize - 200, offset);
			const searchEnd = Math.min(offset + chunkSize + 100, text.length);
			const searchText = text.slice(searchStart, searchEnd);

			// Find last sentence boundary in search window
			const sentenceEnd = findLastSentenceBoundary(searchText);
			if (sentenceEnd > 0) {
				end = searchStart + sentenceEnd;
			}
		}

		const content = text.slice(offset, end).trim();

		if (content.length >= minChunkSize) {
			chunks.push({
				content,
				index: index++,
				metadata: {
					filename,
					startOffset: offset,
					endOffset: end,
				},
			});
		}

		// Move offset with overlap, ensuring we always advance
		const nextOffset = end - chunkOverlap;
		offset = nextOffset > offset ? nextOffset : offset + 1;
		if (end >= text.length) {
			break;
		}
	}

	return chunks;
}

/**
 * Recursive chunking
 * Hierarchically splits using priority separators
 */
function chunkRecursive(
	text: string,
	filename: string,
	opts: Required<
		Omit<
			ChunkingOptions,
			"separators" | "semanticThreshold" | "contentType"
		>
	> & { separators?: string[] },
): TextChunk[] {
	const { chunkSize, chunkOverlap, minChunkSize } = opts;
	const separators = opts.separators || RECURSIVE_SEPARATORS;

	function splitRecursively(
		text: string,
		separatorIndex: number,
		startOffset: number,
	): { content: string; startOffset: number; endOffset: number }[] {
		// Base case: text fits in chunk size
		if (text.length <= chunkSize) {
			return [
				{
					content: text,
					startOffset,
					endOffset: startOffset + text.length,
				},
			];
		}

		// No more separators to try
		if (separatorIndex >= separators.length) {
			// Force split at chunkSize
			const results: {
				content: string;
				startOffset: number;
				endOffset: number;
			}[] = [];
			let offset = 0;
			while (offset < text.length) {
				const end = Math.min(offset + chunkSize, text.length);
				results.push({
					content: text.slice(offset, end),
					startOffset: startOffset + offset,
					endOffset: startOffset + end,
				});
				// Ensure we always advance by at least 1 character to prevent infinite loop
				const nextOffset = end - chunkOverlap;
				offset = nextOffset > offset ? nextOffset : offset + 1;
				if (end >= text.length) {
					break;
				}
			}
			return results;
		}

		const separator = separators[separatorIndex];

		// Empty separator means character-level split
		if (separator === "") {
			return splitRecursively(text, separatorIndex + 1, startOffset);
		}

		const parts = text.split(separator);

		// If separator doesn't help, try next one
		if (parts.length === 1) {
			return splitRecursively(text, separatorIndex + 1, startOffset);
		}

		// Merge small parts and recursively split large ones
		const results: {
			content: string;
			startOffset: number;
			endOffset: number;
		}[] = [];
		let currentChunk = "";
		let currentOffset = startOffset;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const separator_to_add = i < parts.length - 1 ? separator : "";

			if (
				currentChunk.length + part.length + separator_to_add.length <=
				chunkSize
			) {
				currentChunk += part + separator_to_add;
			} else {
				// Save current chunk if not empty
				if (currentChunk.trim().length >= minChunkSize) {
					results.push({
						content: currentChunk.trim(),
						startOffset: currentOffset,
						endOffset: currentOffset + currentChunk.length,
					});
				}

				// If this part alone is too large, recursively split it
				if (part.length > chunkSize) {
					const subResults = splitRecursively(
						part,
						separatorIndex + 1,
						currentOffset + currentChunk.length,
					);
					results.push(...subResults);
					currentChunk = "";
					currentOffset =
						currentOffset + currentChunk.length + part.length;
				} else {
					// Apply overlap
					const overlapText = currentChunk.slice(-chunkOverlap);
					currentOffset += currentChunk.length - overlapText.length;
					currentChunk = overlapText + part + separator_to_add;
				}
			}
		}

		// Add remaining chunk
		if (currentChunk.trim().length >= minChunkSize) {
			results.push({
				content: currentChunk.trim(),
				startOffset: currentOffset,
				endOffset: currentOffset + currentChunk.length,
			});
		}

		return results;
	}

	const rawChunks = splitRecursively(text, 0, 0);

	return rawChunks.map((chunk, index) => ({
		content: chunk.content,
		index,
		metadata: {
			filename,
			startOffset: chunk.startOffset,
			endOffset: chunk.endOffset,
		},
	}));
}

/**
 * Document-based chunking
 * Splits by document structure (headers, sections)
 */
function chunkDocument(
	text: string,
	filename: string,
	opts: Required<
		Omit<
			ChunkingOptions,
			"separators" | "semanticThreshold" | "contentType"
		>
	> & { contentType?: string },
): TextChunk[] {
	const { chunkSize, chunkOverlap, minChunkSize } = opts;
	const contentType = opts.contentType || detectContentType(text).type;

	if (contentType === "markdown") {
		return chunkMarkdown(text, filename, {
			chunkSize,
			chunkOverlap,
			minChunkSize,
		});
	}

	// For other content types, fall back to recursive chunking
	return chunkRecursive(text, filename, opts);
}

/**
 * Markdown-aware chunking
 * Preserves header hierarchy and keeps related content together
 */
function chunkMarkdown(
	text: string,
	filename: string,
	opts: { chunkSize: number; chunkOverlap: number; minChunkSize: number },
): TextChunk[] {
	const { chunkSize, minChunkSize } = opts;
	const chunks: TextChunk[] = [];
	const lines = text.split("\n");

	let currentChunk = "";
	let currentHeadings: string[] = [];
	let currentOffset = 0;
	let chunkStartOffset = 0;
	let index = 0;

	for (const line of lines) {
		const headerMatch = line
			.slice(0, MAX_HEADER_LINE_CHARS)
			.match(/^(#{1,6})\s+(.+)$/);

		if (headerMatch) {
			const level = headerMatch[1].length;
			const title = headerMatch[2];

			// Save current chunk before starting new section
			if (currentChunk.trim().length >= minChunkSize) {
				chunks.push({
					content: currentChunk.trim(),
					index: index++,
					metadata: {
						filename,
						headings: [...currentHeadings],
						startOffset: chunkStartOffset,
						endOffset: currentOffset,
					},
				});
			}

			// Update heading hierarchy
			currentHeadings = currentHeadings.slice(0, level - 1);
			currentHeadings.push(title);

			// Start new chunk with header context
			currentChunk = `${line}\n`;
			chunkStartOffset = currentOffset;
		} else {
			// Check if adding this line would exceed chunk size
			if (
				currentChunk.length + line.length + 1 > chunkSize &&
				currentChunk.trim().length >= minChunkSize
			) {
				chunks.push({
					content: currentChunk.trim(),
					index: index++,
					metadata: {
						filename,
						headings: [...currentHeadings],
						startOffset: chunkStartOffset,
						endOffset: currentOffset,
					},
				});
				currentChunk = "";
				chunkStartOffset = currentOffset;
			}

			currentChunk += `${line}\n`;
		}

		currentOffset += line.length + 1;
	}

	// Add final chunk
	if (currentChunk.trim().length >= minChunkSize) {
		chunks.push({
			content: currentChunk.trim(),
			index: index++,
			metadata: {
				filename,
				headings: [...currentHeadings],
				startOffset: chunkStartOffset,
				endOffset: currentOffset,
			},
		});
	}

	return chunks;
}

/**
 * Paragraph-based chunking (default)
 * Splits on double newlines, respects chunk size limits
 */
function chunkParagraph(
	text: string,
	filename: string,
	opts: Required<
		Omit<
			ChunkingOptions,
			"separators" | "semanticThreshold" | "contentType"
		>
	>,
): TextChunk[] {
	const { chunkSize, chunkOverlap, separator, minChunkSize } = opts;

	// Split text by separator first
	const paragraphs = text.split(separator).filter((p) => p.trim().length > 0);

	const chunks: TextChunk[] = [];
	let currentChunk = "";
	let currentOffset = 0;
	let chunkIndex = 0;

	for (const paragraph of paragraphs) {
		const trimmedParagraph = paragraph.trim();

		// If adding this paragraph would exceed chunk size, save current chunk
		if (
			currentChunk.length > 0 &&
			currentChunk.length + trimmedParagraph.length > chunkSize
		) {
			if (currentChunk.trim().length >= minChunkSize) {
				chunks.push({
					content: currentChunk.trim(),
					index: chunkIndex++,
					metadata: {
						filename,
						startOffset: currentOffset,
						endOffset: currentOffset + currentChunk.length,
					},
				});
			}

			// Start new chunk with overlap
			const overlapText = currentChunk.slice(-chunkOverlap);
			currentOffset += currentChunk.length - overlapText.length;
			currentChunk = overlapText;
		}

		// Add paragraph to current chunk
		if (currentChunk.length > 0) {
			currentChunk += `\n\n${trimmedParagraph}`;
		} else {
			currentChunk = trimmedParagraph;
		}
	}

	// Add final chunk if not empty
	if (currentChunk.trim().length >= minChunkSize) {
		chunks.push({
			content: currentChunk.trim(),
			index: chunkIndex,
			metadata: {
				filename,
				startOffset: currentOffset,
				endOffset: currentOffset + currentChunk.length,
			},
		});
	}

	return chunks;
}

/**
 * Sentence-level chunking
 * Fine-grained splitting at sentence boundaries
 */
function chunkSentence(
	text: string,
	filename: string,
	opts: Required<
		Omit<
			ChunkingOptions,
			"separators" | "semanticThreshold" | "contentType"
		>
	>,
): TextChunk[] {
	const { chunkSize, chunkOverlap, minChunkSize } = opts;

	// Split into sentences
	const sentences = splitIntoSentences(text);
	const chunks: TextChunk[] = [];
	let currentChunk = "";
	let currentOffset = 0;
	let chunkStartOffset = 0;
	let index = 0;

	for (const sentence of sentences) {
		if (
			currentChunk.length + sentence.length > chunkSize &&
			currentChunk.length > 0
		) {
			if (currentChunk.trim().length >= minChunkSize) {
				chunks.push({
					content: currentChunk.trim(),
					index: index++,
					metadata: {
						filename,
						startOffset: chunkStartOffset,
						endOffset: currentOffset,
					},
				});
			}

			// Apply overlap by keeping last portion
			const overlapText = currentChunk.slice(-chunkOverlap);
			chunkStartOffset = currentOffset - overlapText.length;
			currentChunk = overlapText;
		}

		currentChunk += sentence;
		currentOffset += sentence.length;
	}

	// Add final chunk
	if (currentChunk.trim().length >= minChunkSize) {
		chunks.push({
			content: currentChunk.trim(),
			index: index++,
			metadata: {
				filename,
				startOffset: chunkStartOffset,
				endOffset: currentOffset,
			},
		});
	}

	return chunks;
}

/**
 * Split text into sentences
 */
function splitIntoSentences(text: string): string[] {
	const sentences: string[] = [];
	let lastEnd = 0;

	// The `|[.!?]+$` alternative was redundant: JS `$` (no `m` flag) only
	// matches the absolute end of `text`, and the `lastEnd < text.length`
	// fallback below already emits whatever trails the final matched
	// separator — including a final punctuation run with no trailing
	// whitespace. Dropping it removes the dollar-anchor backtracking blowup
	// without changing which sentences are produced.
	//
	// `[.!?](?![.!?])` matches only the LAST character of a punctuation run
	// instead of the whole run. The end of the match — the only thing used
	// below — is identical, because `\s+` still consumes the same trailing
	// whitespace; what goes away is the `[.!?]+` span the engine re-scanned
	// from every position inside a long punctuation run ("!!!!!…" with no
	// whitespace after it was quadratic in its length).
	// Bounded span: js/polynomial-redos
	const regex = /[.!?](?![.!?])\s+/g;
	let match: RegExpExecArray | null;

	while (
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
		(match = regex.exec(text)) !== null
	) {
		sentences.push(text.slice(lastEnd, match.index + match[0].length));
		lastEnd = match.index + match[0].length;
	}

	// Add remaining text
	if (lastEnd < text.length) {
		sentences.push(text.slice(lastEnd));
	}

	return sentences;
}

/**
 * Find the last sentence boundary in text
 */
function findLastSentenceBoundary(text: string): number {
	const matches = [...text.matchAll(/[.!?]+[\s]+/g)];
	if (matches.length === 0) {
		return -1;
	}
	const lastMatch = matches[matches.length - 1];
	// biome-ignore lint/style/noNonNullAssertion: regex match index is always defined on a successful match
	return lastMatch.index! + lastMatch[0].length;
}

/**
 * Detect content type from text
 */
export function detectContentType(text: string): ContentTypeInfo {
	// Bounded span: js/polynomial-redos — detectContentType only needs to
	// sniff a prefix of unbounded user-uploaded document text; every regex
	// below runs against this bounded prefix instead of the full text.
	const sniffText = text.slice(0, MAX_CONTENT_TYPE_SNIFF_CHARS);
	const hasMarkdownHeaders = MARKDOWN_HEADER_REGEX.test(sniffText);
	const hasCodeBlocks = /```[\s\S]*?```/g.test(sniffText);
	const hasHtmlTags = /<[a-z][\s\S]*?>/i.test(sniffText);

	// Detect programming language patterns
	const hasImports = /^(import|from|require|using|#include)/m.test(sniffText);
	const hasFunctions = /^(function|def|fn|func|public|private|class)/m.test(
		sniffText,
	);

	if (hasMarkdownHeaders || hasCodeBlocks) {
		return {
			type: "markdown",
			hasHeaders: hasMarkdownHeaders,
			hasCodeBlocks,
			suggestedStrategy: "DOCUMENT",
		};
	}

	if (hasHtmlTags) {
		return {
			type: "html",
			hasHeaders: /<h[1-6]/i.test(sniffText),
			hasCodeBlocks: /<pre|<code/i.test(sniffText),
			suggestedStrategy: "DOCUMENT",
		};
	}

	if (hasImports || hasFunctions) {
		return {
			type: "code",
			hasHeaders: false,
			hasCodeBlocks: true,
			suggestedStrategy: "DOCUMENT",
		};
	}

	return {
		type: "text",
		hasHeaders: false,
		hasCodeBlocks: false,
		suggestedStrategy: "RECURSIVE",
	};
}

/**
 * Get accurate token count for text using tiktoken
 *
 * Uses OpenAI's cl100k_base encoding (used by text-embedding-3-small/large)
 * for accurate token counting. Falls back to estimation if tokenizer fails.
 *
 * @param text - Text to count tokens for
 * @param useAccurate - Whether to use accurate counting (default: true)
 * @returns Token count
 */
export function estimateTokenCount(text: string, useAccurate = true): number {
	if (!text || text.length === 0) {
		return 0;
	}

	if (useAccurate) {
		try {
			return countTokens(text);
		} catch (error) {
			logger.warn(
				"[Chunker] Failed to count tokens accurately, using estimation",
				{ error },
			);
			return charsToTokensEstimate(text.length);
		}
	}

	return charsToTokensEstimate(text.length);
}

// Re-export tokensToChars from tokenizer for backwards compatibility
export { tokensToChars } from "./tokenizer";

/**
 * Get recommended chunking options based on content type
 */
export function getRecommendedOptions(text: string): ChunkingOptions {
	const contentInfo = detectContentType(text);

	return {
		strategy: contentInfo.suggestedStrategy,
		chunkSize: 2048, // 512 tokens
		chunkOverlap: 200, // 50 tokens
		contentType: contentInfo.type,
		preserveSentences: contentInfo.type === "text",
	};
}
