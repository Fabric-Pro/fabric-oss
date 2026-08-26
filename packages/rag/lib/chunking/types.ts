/**
 * Types for text chunking
 *
 * Implements multiple chunking strategies based on best practices:
 * - Fixed-size: Simple character/token-based splitting
 * - Recursive: Hierarchical splitting by separators (paragraphs → sentences → words)
 * - Semantic: Embedding-based splitting at meaning boundaries
 * - Document-based: Structure-aware splitting (markdown headers, code blocks)
 *
 * @see https://weaviate.io/blog/chunking-strategies-for-rag
 * @see https://weaviate.io/blog/late-chunking
 */

/**
 * Chunking strategy types
 *
 * - FIXED: Fixed-size chunking with character/token limits
 * - RECURSIVE: Hierarchical splitting with priority separators
 * - SEMANTIC: Embedding-based natural boundary detection
 * - DOCUMENT: Structure-aware splitting (markdown, HTML, code)
 * - PARAGRAPH: Simple paragraph-based splitting (default)
 * - SENTENCE: Sentence-level granularity
 */
export type ChunkingStrategy =
	| "FIXED"
	| "RECURSIVE"
	| "SEMANTIC"
	| "DOCUMENT"
	| "PARAGRAPH"
	| "SENTENCE"
	| "CODE_AST";

/**
 * A chunk of text with metadata
 */
export interface TextChunk {
	/** Chunk content */
	content: string;
	/** Index of this chunk in the document */
	index: number;
	/** Token count estimate (1 token ≈ 4 chars) */
	tokenEstimate?: number;
	/** Metadata about the chunk */
	metadata: {
		/** Original document filename */
		filename: string;
		/** Page numbers (if available) */
		pageNumbers?: number[];
		/** Section title (if available) */
		section?: string;
		/** Heading hierarchy (for document-based chunking) */
		headings?: string[];
		/** Character offset in original document */
		startOffset: number;
		/** Character offset end in original document */
		endOffset: number;
		/** Chunking strategy used */
		strategy?: ChunkingStrategy;
	};
}

/**
 * Chunking options
 *
 * Best practices from research:
 * - Start with 512 tokens (≈2048 chars) for initial testing
 * - Use 50-100 token overlap (≈200-400 chars) to maintain context
 * - Choose strategy based on content type:
 *   - Unstructured narrative: RECURSIVE or SEMANTIC
 *   - Technical/academic: SEMANTIC
 *   - Structured docs (markdown): DOCUMENT
 *   - Code: DOCUMENT
 */
export interface ChunkingOptions {
	/** Chunking strategy to use (default: PARAGRAPH) */
	strategy?: ChunkingStrategy;
	/** Target chunk size in characters (default: 2048 chars ≈ 512 tokens) */
	chunkSize?: number;
	/** Overlap between chunks in characters (default: 200 chars ≈ 50 tokens) */
	chunkOverlap?: number;
	/** Primary separator for splitting (default: "\n\n") */
	separator?: string;
	/** For RECURSIVE: ordered list of separators to try */
	separators?: string[];
	/** For SEMANTIC: similarity threshold for boundary detection (0-1) */
	semanticThreshold?: number;
	/** For DOCUMENT: content type hint */
	contentType?: "markdown" | "html" | "code" | "text";
	/** Minimum chunk size (prevents tiny chunks) */
	minChunkSize?: number;
	/** Whether to preserve sentence boundaries */
	preserveSentences?: boolean;
}

/**
 * Content type detection result
 */
export interface ContentTypeInfo {
	type: "markdown" | "html" | "code" | "text";
	language?: string;
	hasHeaders: boolean;
	hasCodeBlocks: boolean;
	suggestedStrategy: ChunkingStrategy;
}

/**
 * Chunking result with statistics
 */
export interface ChunkingResult {
	chunks: TextChunk[];
	stats: {
		totalChunks: number;
		avgChunkSize: number;
		minChunkSize: number;
		maxChunkSize: number;
		totalTokensEstimate: number;
		strategy: ChunkingStrategy;
		processingTimeMs: number;
	};
}
