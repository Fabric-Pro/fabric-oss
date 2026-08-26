/**
 * AST-Aware Code Chunker
 *
 * Uses the code-chunk package (tree-sitter based) to chunk source code
 * at semantic boundaries (functions, classes, methods) rather than
 * arbitrary character limits.
 *
 * Each chunk includes rich context: scope chain, imports, siblings,
 * and entity signatures. The contextualizedText field is optimized
 * for embedding models to capture semantic relationships.
 *
 * Supported languages: TypeScript, JavaScript, Python, Rust, Go, Java
 */

import { logger } from "@repo/logs";
import type { TextChunk } from "./types";

/**
 * Supported file extensions for AST-aware chunking.
 * Falls back to text-based chunking for unsupported extensions.
 */
const SUPPORTED_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".rs",
	".go",
	".java",
]);

/**
 * Check if a file can be chunked with AST-aware chunking.
 */
export function isAstChunkable(filepath: string): boolean {
	const ext = filepath.slice(filepath.lastIndexOf(".")).toLowerCase();
	return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Result of AST-aware chunking for a single file.
 * Extends TextChunk with code-specific metadata.
 */
export interface CodeChunk extends TextChunk {
	/** Contextualized text optimized for embedding (includes scope, imports, etc.) */
	contextualizedContent: string;
	/** Code-specific metadata */
	codeMetadata: {
		language: string;
		filePath: string;
		/** Entities defined in this chunk */
		entities: Array<{
			name: string;
			type: string;
			signature?: string;
			docstring?: string | null;
		}>;
		/** Primary symbol name (first entity in chunk) */
		symbolName?: string;
		/** Primary symbol type */
		symbolType?: string;
		/** Scope chain (e.g., ["MyClass", "processData"]) */
		scopeChain: string[];
		/** Import dependencies */
		imports: Array<{ name: string; source: string }>;
	};
}

/**
 * Options for AST-aware code chunking.
 */
export interface CodeChunkOptions {
	/** Maximum chunk size in bytes (default: 1500) */
	maxChunkSize?: number;
	/** Context mode: none, minimal, or full (default: full) */
	contextMode?: "none" | "minimal" | "full";
	/** Sibling detail level (default: signatures) */
	siblingDetail?: "none" | "names" | "signatures";
	/** Number of lines to overlap between chunks (default: 2) */
	overlapLines?: number;
}

const DEFAULT_CODE_CHUNK_OPTIONS: Required<CodeChunkOptions> = {
	maxChunkSize: 1500,
	contextMode: "full",
	siblingDetail: "signatures",
	overlapLines: 2,
};

/**
 * Chunk a single source file using AST-aware chunking.
 *
 * Returns CodeChunk[] with both raw text and contextualized text
 * suitable for embedding.
 */
/**
 * Map a code-chunk Chunk to our CodeChunk type.
 */
function mapToCodeChunk(c: any, filepath: string, index: number): CodeChunk {
	const primaryEntity = c.context.entities?.[0];
	const scopeChain = c.context.scope?.map((s: any) => s.name) ?? [];

	return {
		content: c.text,
		contextualizedContent: c.contextualizedText,
		index,
		tokenEstimate: Math.ceil(c.text.length / 4),
		metadata: {
			filename: filepath,
			startOffset: c.byteRange.start,
			endOffset: c.byteRange.end,
			strategy: "CODE_AST",
		},
		codeMetadata: {
			language: c.context.language ?? "unknown",
			filePath: filepath,
			entities: (c.context.entities ?? []).map((e: any) => ({
				name: e.name,
				type: e.type,
				signature: e.signature,
				docstring: e.docstring,
			})),
			symbolName: primaryEntity?.name,
			symbolType: primaryEntity?.type,
			scopeChain,
			imports: (c.context.imports ?? []).map((i: any) => ({
				name: i.name,
				source: i.source,
			})),
		},
	};
}

export async function chunkCodeFile(
	filepath: string,
	sourceCode: string,
	options: CodeChunkOptions = {},
): Promise<CodeChunk[]> {
	const opts = { ...DEFAULT_CODE_CHUNK_OPTIONS, ...options };

	const { chunk: codeChunk } = await import("code-chunk");

	const startTime = Date.now();

	try {
		const chunks = await codeChunk(filepath, sourceCode, {
			maxChunkSize: opts.maxChunkSize,
			contextMode: opts.contextMode,
			siblingDetail: opts.siblingDetail,
			overlapLines: opts.overlapLines,
		});

		const result = chunks.map((c, index) =>
			mapToCodeChunk(c, filepath, index),
		);

		const elapsed = Date.now() - startTime;
		logger.info(
			`[CodeChunker] Chunked ${filepath}: ${result.length} chunks in ${elapsed}ms`,
		);

		return result;
	} catch (error) {
		logger.warn(
			`[CodeChunker] Failed to chunk ${filepath}: ${error instanceof Error ? error.message : error}`,
		);
		return [];
	}
}

/**
 * Chunk multiple files in batch using AST-aware chunking.
 * Handles unsupported languages gracefully (skips them).
 */
export async function chunkCodeBatch(
	files: Array<{ filepath: string; code: string }>,
	options: CodeChunkOptions = {},
): Promise<Map<string, CodeChunk[]>> {
	const opts = { ...DEFAULT_CODE_CHUNK_OPTIONS, ...options };
	const results = new Map<string, CodeChunk[]>();

	const { chunkBatch } = await import("code-chunk");

	const startTime = Date.now();
	const batchInput = files.map((f) => ({
		filepath: f.filepath,
		code: f.code,
	}));

	try {
		const batchResults = await chunkBatch(batchInput, {
			maxChunkSize: opts.maxChunkSize,
			contextMode: opts.contextMode,
			siblingDetail: opts.siblingDetail,
			overlapLines: opts.overlapLines,
			concurrency: 10,
		});

		for (const result of batchResults) {
			if (result.error) {
				logger.warn(
					`[CodeChunker] Batch: skipped ${result.filepath}: ${result.error.message}`,
				);
				results.set(result.filepath, []);
				continue;
			}

			results.set(
				result.filepath,
				result.chunks.map((c, index) =>
					mapToCodeChunk(c, result.filepath, index),
				),
			);
		}

		const elapsed = Date.now() - startTime;
		const totalChunks = Array.from(results.values()).reduce(
			(sum, c) => sum + c.length,
			0,
		);
		logger.info(
			`[CodeChunker] Batch: ${files.length} files -> ${totalChunks} chunks in ${elapsed}ms`,
		);
	} catch (error) {
		logger.error(
			`[CodeChunker] Batch chunking failed: ${error instanceof Error ? error.message : error}`,
		);
	}

	return results;
}

/**
 * Apply contextual retrieval enhancement: prepend file-level context
 * to chunk text before embedding. This improves retrieval quality for
 * similar-looking code across different files.
 */
export function applyContextualRetrieval(
	chunkText: string,
	filePath: string,
	repoName: string,
	fileSummary?: string,
): string {
	const modulePath = inferModulePath(filePath);
	const summaryLine = fileSummary
		? `${filePath} handles: ${fileSummary}`
		: `${filePath} is part of the ${modulePath} module`;

	return `This code is from ${filePath} in the ${repoName} repository.\n${summaryLine}.\n---\n${chunkText}`;
}

/**
 * Infer a module path from a file path for contextual retrieval.
 */
function inferModulePath(filePath: string): string {
	const parts = filePath.split("/");
	// Return up to 3 directory levels: "packages/rag/lib"
	const relevantParts = parts.slice(0, Math.min(parts.length - 1, 3));
	return relevantParts.join("/") || "root";
}
