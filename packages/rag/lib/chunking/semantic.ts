/**
 * Semantic Chunking Implementation
 *
 * Groups semantically similar content together before splitting.
 * Uses embeddings to detect natural topic boundaries.
 *
 * @see https://weaviate.io/blog/chunking-strategies-for-rag
 */

import { logger } from "@repo/logs";
import { generateEmbeddings } from "../embedding";
import { countTokens } from "./tokenizer";
import type { TextChunk } from "./types";

/** Options for semantic chunking */
export interface SemanticChunkingOptions {
	maxChunkSize?: number;
	similarityThreshold?: number;
	minChunkSize?: number;
	baseUnit?: "sentence" | "paragraph";
	/** Required - AI Gateway API key from user/org config */
	apiKey: string;
	tenantContext?: { userId?: string; organizationId?: string };
}

const DEFAULT_OPTIONS = {
	maxChunkSize: 2048,
	similarityThreshold: 0.5,
	minChunkSize: 100,
	baseUnit: "sentence" as const,
};

/** Calculate cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error("Vectors must have the same length");
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}

function splitIntoSentences(text: string): string[] {
	const sentences: string[] = [];
	const regex = /[^.!?]*[.!?]+\s*/g;
	let match: RegExpExecArray | null;
	while (
		// biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration idiom
		(match = regex.exec(text)) !== null
	) {
		const s = match[0].trim();
		if (s.length > 0) {
			sentences.push(s);
		}
	}
	const lastIdx = regex.lastIndex || 0;
	if (lastIdx < text.length) {
		const rem = text.slice(lastIdx).trim();
		if (rem.length > 0) {
			sentences.push(rem);
		}
	}
	if (sentences.length === 0 && text.trim().length > 0) {
		sentences.push(text.trim());
	}
	return sentences;
}

function splitIntoParagraphs(text: string): string[] {
	return text
		.split(/\n\n+/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
}

function findBreakpoints(similarities: number[], threshold: number): number[] {
	const bp: number[] = [];
	for (let i = 0; i < similarities.length; i++) {
		if (similarities[i] < threshold) {
			bp.push(i + 1);
		}
	}
	return bp;
}

function groupIntoChunks(
	units: string[],
	breakpoints: number[],
	maxSize: number,
	minSize: number,
): string[][] {
	const chunks: string[][] = [];
	let current: string[] = [];
	let size = 0;
	let bpIdx = 0;
	for (let i = 0; i < units.length; i++) {
		const unit = units[i];
		const isBp = bpIdx < breakpoints.length && breakpoints[bpIdx] === i;
		const shouldBreak =
			isBp || (size + unit.length > maxSize && size >= minSize);
		if (shouldBreak && current.length > 0) {
			chunks.push(current);
			current = [];
			size = 0;
		}
		if (isBp) {
			bpIdx++;
		}
		current.push(unit);
		size += unit.length;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

/** Perform semantic chunking on text */
export async function chunkSemantic(
	text: string,
	filename: string,
	options: SemanticChunkingOptions,
): Promise<TextChunk[]> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const startTime = Date.now();

	logger.info("[SemanticChunker] Starting", {
		textLength: text.length,
		baseUnit: opts.baseUnit,
		maxChunkSize: opts.maxChunkSize,
		similarityThreshold: opts.similarityThreshold,
	});

	const units =
		opts.baseUnit === "paragraph"
			? splitIntoParagraphs(text)
			: splitIntoSentences(text);
	logger.info(
		`[SemanticChunker] Split into ${units.length} ${opts.baseUnit}s`,
	);

	if (units.length <= 1) {
		return [
			{
				content: text.trim(),
				index: 0,
				tokenEstimate: countTokens(text),
				metadata: {
					filename,
					startOffset: 0,
					endOffset: text.length,
					strategy: "SEMANTIC",
				},
			},
		];
	}

	logger.info("[SemanticChunker] Generating embeddings...");
	const { embeddings } = await generateEmbeddings(
		units,
		opts.tenantContext,
		opts.apiKey,
	);

	const similarities: number[] = [];
	for (let i = 0; i < embeddings.length - 1; i++) {
		similarities.push(cosineSimilarity(embeddings[i], embeddings[i + 1]));
	}

	logger.info("[SemanticChunker] Similarities", {
		min: Math.min(...similarities).toFixed(3),
		max: Math.max(...similarities).toFixed(3),
		avg: (
			similarities.reduce((a, b) => a + b, 0) / similarities.length
		).toFixed(3),
	});

	const breakpoints = findBreakpoints(similarities, opts.similarityThreshold);
	const grouped = groupIntoChunks(
		units,
		breakpoints,
		opts.maxChunkSize,
		opts.minChunkSize,
	);

	const chunks: TextChunk[] = [];
	let offset = 0;
	for (let i = 0; i < grouped.length; i++) {
		const content = grouped[i].join(" ");
		const start = text.indexOf(grouped[i][0], offset);
		chunks.push({
			content,
			index: i,
			tokenEstimate: countTokens(content),
			metadata: {
				filename,
				startOffset: start >= 0 ? start : offset,
				endOffset: start + content.length,
				strategy: "SEMANTIC",
			},
		});
		offset = start + content.length;
	}

	logger.info("[SemanticChunker] Done", {
		totalChunks: chunks.length,
		processingTimeMs: Date.now() - startTime,
	});
	return chunks;
}

/** Synchronous fallback when embeddings are not available */
export function chunkSemanticFallback(
	text: string,
	filename: string,
	options: Omit<SemanticChunkingOptions, "apiKey" | "tenantContext"> = {},
): TextChunk[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	logger.info("[SemanticChunker] Using fallback (no embeddings)");

	const paragraphs = splitIntoParagraphs(text);
	const chunks: TextChunk[] = [];
	let currentChunk: string[] = [];
	let currentSize = 0;
	let currentOffset = 0;

	for (const para of paragraphs) {
		if (
			currentSize + para.length > opts.maxChunkSize &&
			currentSize >= opts.minChunkSize
		) {
			const content = currentChunk.join("\n\n");
			const start = text.indexOf(currentChunk[0], currentOffset);
			chunks.push({
				content,
				index: chunks.length,
				tokenEstimate: countTokens(content),
				metadata: {
					filename,
					startOffset: start >= 0 ? start : currentOffset,
					endOffset: start + content.length,
					strategy: "SEMANTIC",
				},
			});
			currentOffset = start + content.length;
			currentChunk = [];
			currentSize = 0;
		}
		currentChunk.push(para);
		currentSize += para.length;
	}

	if (currentChunk.length > 0) {
		const content = currentChunk.join("\n\n");
		const start = text.indexOf(currentChunk[0], currentOffset);
		chunks.push({
			content,
			index: chunks.length,
			tokenEstimate: countTokens(content),
			metadata: {
				filename,
				startOffset: start >= 0 ? start : currentOffset,
				endOffset: start + content.length,
				strategy: "SEMANTIC",
			},
		});
	}

	return chunks;
}
