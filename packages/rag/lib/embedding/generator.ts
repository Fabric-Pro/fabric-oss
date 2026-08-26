/**
 * Embedding generation using Vercel AI SDK
 *
 * Configuration:
 * - Users/organizations configure AI providers in Settings → AI Providers
 * - API keys are stored in cloud_provider_config / user_cloud_provider_config tables
 * - Embedding model is configurable via AI Models preferences (Settings → AI Models)
 * - Uses EMBEDDING task type from dynamic model selection
 *
 * Architecture:
 * - Uses centralized `getAIEmbeddingModelWithMetadata` from @repo/ai
 * - This handles all provider resolution, API key decryption, and model creation
 * - Supports both direct providers (OpenAI) and gateways (OpenRouter, Vercel Gateway)
 */

import {
	getAIEmbeddingModelWithMetadata,
	logEmbeddingUsageAsync,
} from "@repo/ai";
import { logger } from "@repo/logs";
import { embed, embedMany } from "ai";
// From the module rather than the `../chunking` barrel — that barrel re-exports
// code which imports back into this one.
import {
	countTokens,
	countTokensBatch,
	splitByTokens,
} from "../chunking/tokenizer";
import type {
	BatchEmbeddingResult,
	EmbeddingResult,
	TenantContext,
} from "./types";

// Default dimensions for unknown models
const EMBEDDING_DIMENSIONS = 1536;
const COST_PER_MILLION_TOKENS = 0.02; // $0.02 per 1M tokens

// The endpoint rejects a request whose inputs exceed 300k tokens in total, or
// 2048 array entries. Callers hand us whatever they have — a project's entire
// backlog, a repository's worth of chunks — so unbatched, a large enough input
// fails the whole call, and a caller that reads one failure as "nothing could
// be evaluated" degrades far past what the input warranted. 250k leaves room
// for the provider counting tokens slightly differently than tiktoken does.
// Exported so tests track the real ceilings instead of a drifting copy.
export const MAX_TOKENS_PER_REQUEST = 250_000;
export const MAX_INPUTS_PER_REQUEST = 2048;
// The per-input ceiling, matching what `ai-model-catalog.ts` records as the
// context window for all three models this file prices. An input above it is
// SPLIT and its pieces recombined (see `combineChunkEmbeddings`), never
// truncated: truncation silently discards text the caller believed was
// embedded, and for duplicate detection that is actively harmful — two long
// stories sharing an opening would truncate to near-identical vectors and read
// as duplicates of each other.
export const MAX_TOKENS_PER_INPUT = 8191;

/**
 * Combine the embeddings of one input's chunks into a single vector.
 *
 * Weighted by each chunk's token count, then scaled back to unit length —
 * the approach OpenAI documents for inputs longer than a model's context
 * window. Weighting matters because a trailing 200-token chunk otherwise
 * pulls the result as hard as the 8000-token chunk before it; normalising
 * matters because callers compare these with cosine similarity, which assumes
 * unit vectors.
 */
function combineChunkEmbeddings(
	vectors: number[][],
	weights: number[],
): number[] {
	if (vectors.length === 1) {
		return vectors[0];
	}
	const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
	const combined = new Array<number>(vectors[0].length).fill(0);
	vectors.forEach((vector, index) => {
		const share =
			totalWeight > 0 ? weights[index] / totalWeight : 1 / vectors.length;
		for (let d = 0; d < combined.length; d++) {
			combined[d] += vector[d] * share;
		}
	});
	const norm = Math.sqrt(
		combined.reduce((sum, value) => sum + value * value, 0),
	);
	return norm > 0 ? combined.map((value) => value / norm) : combined;
}

/**
 * Embedding model configuration for different models
 * Maps model names to their dimensions and cost
 */
const EMBEDDING_MODEL_CONFIG: Record<
	string,
	{ dimensions: number; costPerMillion: number }
> = {
	"text-embedding-3-small": { dimensions: 1536, costPerMillion: 0.02 },
	"text-embedding-3-large": { dimensions: 3072, costPerMillion: 0.13 },
	"text-embedding-ada-002": { dimensions: 1536, costPerMillion: 0.1 },
};

/**
 * Provider configuration for embedding
 * @deprecated Use tenant context instead - the centralized function handles API keys
 */
export interface EmbeddingProviderConfig {
	apiKey: string;
	provider?: string | null;
	baseUrl?: string | null;
}

/**
 * Get the dimensions for an embedding model
 * @param modelName - The model name
 * @returns The dimensions for the model
 */
function getEmbeddingDimensions(modelName: string): number {
	// Extract base model name if it has a provider prefix
	const baseName = modelName.includes("/")
		? (modelName.split("/").pop() ?? modelName)
		: modelName;
	return EMBEDDING_MODEL_CONFIG[baseName]?.dimensions ?? EMBEDDING_DIMENSIONS;
}

/**
 * Get the cost per million tokens for an embedding model
 * @param modelName - The model name
 * @returns The cost per million tokens
 */
function getEmbeddingCostPerMillion(modelName: string): number {
	// Extract base model name if it has a provider prefix
	const baseName = modelName.includes("/")
		? (modelName.split("/").pop() ?? modelName)
		: modelName;
	return (
		EMBEDDING_MODEL_CONFIG[baseName]?.costPerMillion ??
		COST_PER_MILLION_TOKENS
	);
}

/**
 * Generate embedding for a single text
 *
 * Uses centralized `getAIEmbeddingModelWithMetadata` which handles all
 * provider resolution, API key decryption, and model creation.
 *
 * @param text - Text to embed
 * @param tenantContext - Tenant context for usage tracking and model resolution
 * @param _providerConfig - DEPRECATED: Kept for backward compatibility, ignored
 * @param abortSignal - Optional AbortSignal plumbed through to the AI SDK
 *                      `embed()` call so an in-flight embedding request can be
 *                      cancelled when the calling Temporal activity is aborted
 * @returns Embedding result
 */
export async function generateEmbedding(
	text: string,
	tenantContext: TenantContext | undefined,
	_providerConfig?: EmbeddingProviderConfig | string,
	abortSignal?: AbortSignal,
): Promise<EmbeddingResult> {
	// Tenant context is required for model resolution
	if (!tenantContext?.userId) {
		throw new Error(
			"Tenant context with userId is required for embedding generation. " +
				"Configure an embedding model in Settings → AI Models.",
		);
	}

	// Use centralized single entry point for embedding model access
	const {
		model: embeddingModel,
		metadata,
		trackUsage,
	} = await getAIEmbeddingModelWithMetadata({
		userId: tenantContext.userId,
		organizationId: tenantContext.organizationId,
	});

	logger.info("[EmbeddingGenerator] Resolved embedding model", {
		modelName: metadata.modelString,
		modelProvider: metadata.provider,
		selectionSource: metadata.selectionSource,
	});

	// Track usage (fire-and-forget)
	trackUsage();

	const dimensions = getEmbeddingDimensions(metadata.modelString);

	// Extract base model name for logging
	const baseModelName = metadata.modelString.includes("/")
		? (metadata.modelString.split("/").pop() ?? metadata.modelString)
		: metadata.modelString;

	logger.info("[EmbeddingGenerator] Generating embedding", {
		textLength: text.length,
		modelName: baseModelName,
		selectionSource: metadata.selectionSource,
	});

	try {
		const embeddingStart = Date.now();
		const { embedding, usage } = await embed({
			model: embeddingModel,
			value: text,
			providerOptions: {
				openai: {
					dimensions,
				},
			},
			abortSignal,
		});

		logger.info(
			`[EmbeddingGenerator] Generated embedding: ${embedding.length} dimensions, ${usage.tokens} tokens, model: ${baseModelName}`,
		);
		logEmbeddingUsageAsync({
			context: {
				userId: tenantContext.userId,
				organizationId: tenantContext.organizationId,
			},
			metadata,
			usageTokens: usage.tokens,
			latencyMs: Date.now() - embeddingStart,
			projectId: tenantContext.projectId,
		});

		return {
			embedding,
			model: baseModelName,
			tokens: usage.tokens,
		};
	} catch (error) {
		logger.error("[EmbeddingGenerator] Failed to generate embedding", {
			error: error instanceof Error ? error.message : error,
			modelName: baseModelName,
		});

		throw new Error(
			`Embedding generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Split texts into request-sized batches, bounded by both the per-request token
 * ceiling and the per-request input count.
 *
 * Order is preserved and nothing is dropped: concatenating the batches gives
 * back the input, which is what lets callers index the returned embeddings
 * positionally against the texts they passed in. Exported for tests — the
 * boundary is the whole point of this function, and it is worth asserting
 * directly rather than only through a mocked provider.
 *
 * Each text carries its own token count rather than the two arriving as two
 * positionally-aligned arrays. A short `tokenCounts` would have read as
 * `undefined` here, making `currentTokens + tokens` NaN and every token-ceiling
 * comparison false — the ceiling would stop being enforced silently, which is
 * the exact failure this function exists to prevent.
 *
 * @param counted - Texts with their token counts, already bounded to the
 *                  per-input cap
 */
export function planEmbeddingBatches(
	counted: { text: string; tokens: number }[],
): string[][] {
	const batches: string[][] = [];
	let current: string[] = [];
	let currentTokens = 0;

	counted.forEach(({ text, tokens }) => {
		// Close the batch before adding, never after — a batch is only ever
		// flushed while it already holds something, so a single text larger
		// than the ceiling still gets its own request instead of an empty one.
		if (
			current.length > 0 &&
			(current.length >= MAX_INPUTS_PER_REQUEST ||
				currentTokens + tokens > MAX_TOKENS_PER_REQUEST)
		) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		current.push(text);
		currentTokens += tokens;
	});

	if (current.length > 0) {
		batches.push(current);
	}

	return batches;
}

/**
 * Generate embeddings for multiple texts in batch
 * More efficient than calling generateEmbedding multiple times
 *
 * Uses centralized `getAIEmbeddingModelWithMetadata` which handles all
 * provider resolution, API key decryption, and model creation.
 *
 * Splits the input across as many provider requests as the token and input
 * ceilings require, and returns one result covering all of them — so a caller
 * with a large input gets embeddings rather than an exception.
 *
 * @param texts - Array of texts to embed
 * @param tenantContext - Tenant context for usage tracking and model resolution
 * @param _providerConfig - DEPRECATED: Kept for backward compatibility, ignored
 * @param abortSignal - Optional AbortSignal plumbed through to the AI SDK
 *                      `embedMany()` call so an in-flight batch can be
 *                      cancelled when the calling Temporal activity is aborted
 * @param onBatch - Called after each provider request completes. A large input
 *                  is now several sequential round-trips rather than one, so a
 *                  caller running inside a Temporal activity must be able to
 *                  heartbeat between them or a long run trips its heartbeat
 *                  timeout. Kept a plain callback because this package must not
 *                  depend on `@temporalio/activity`.
 * @returns Batch embedding result
 */
export async function generateEmbeddings(
	texts: string[],
	tenantContext: TenantContext | undefined,
	_providerConfig?: EmbeddingProviderConfig | string,
	abortSignal?: AbortSignal,
	onBatch?: (completed: number, total: number) => void,
): Promise<BatchEmbeddingResult> {
	// Tenant context is required for model resolution
	if (!tenantContext?.userId) {
		throw new Error(
			"Tenant context with userId is required for batch embedding generation. " +
				"Configure an embedding model in Settings → AI Models.",
		);
	}

	// Use centralized single entry point for embedding model access
	const {
		model: embeddingModel,
		metadata,
		trackUsage,
	} = await getAIEmbeddingModelWithMetadata({
		userId: tenantContext.userId,
		organizationId: tenantContext.organizationId,
	});

	// Track usage (fire-and-forget)
	trackUsage();

	const dimensions = getEmbeddingDimensions(metadata.modelString);
	const costPerMillion = getEmbeddingCostPerMillion(metadata.modelString);

	// Extract base model name for logging
	const baseModelName = metadata.modelString.includes("/")
		? (metadata.modelString.split("/").pop() ?? metadata.modelString)
		: metadata.modelString;

	// Count before batching rather than estimating from string length: the
	// inputs here are backlog text and source code, where a character-based
	// estimate drifts far enough to put a batch back over the ceiling.
	const rawTokenCounts = countTokensBatch(texts);
	// One entry per provider input. An input within the ceiling contributes a
	// single piece; an oversized one contributes several, all tagged with the
	// index they must fold back into, so the returned array still has exactly
	// one embedding per text no matter how the input was split.
	const pieces: { text: string; tokens: number; owner: number }[] = [];
	texts.forEach((text, index) => {
		const tokens = rawTokenCounts[index];
		if (tokens <= MAX_TOKENS_PER_INPUT) {
			pieces.push({ text, tokens, owner: index });
			return;
		}
		for (const part of splitByTokens(text, MAX_TOKENS_PER_INPUT)) {
			pieces.push({
				text: part,
				tokens: countTokens(part),
				owner: index,
			});
		}
	});
	const batches = planEmbeddingBatches(pieces);
	const splitCount = rawTokenCounts.filter(
		(count) => count > MAX_TOKENS_PER_INPUT,
	).length;

	if (splitCount > 0) {
		logger.info(
			"[EmbeddingGenerator] Split oversized inputs and combined their chunks",
			{
				splitCount,
				providerInputs: pieces.length,
				maxTokensPerInput: MAX_TOKENS_PER_INPUT,
			},
		);
	}

	logger.info("[EmbeddingGenerator] Generating batch embeddings", {
		textCount: texts.length,
		batchCount: batches.length,
		modelName: baseModelName,
		selectionSource: metadata.selectionSource,
	});

	try {
		const embeddingStart = Date.now();
		const pieceEmbeddings: number[][] = [];
		let totalTokens = 0;

		// Sequential on purpose. A large input is only a handful of requests,
		// and firing them concurrently is what draws the provider rate limit —
		// the same all-or-nothing failure arriving from the other direction.
		for (const [index, batch] of batches.entries()) {
			const result = await embedMany({
				model: embeddingModel,
				values: batch,
				providerOptions: {
					openai: {
						dimensions,
					},
				},
				abortSignal,
			});
			pieceEmbeddings.push(...result.embeddings);
			totalTokens += result.usage.tokens;
			onBatch?.(index + 1, batches.length);
		}

		// Fold the pieces back onto the inputs that produced them. Anything that
		// was not split owns exactly one piece and passes through untouched.
		const embeddings: number[][] = texts.map(() => []);
		let cursor = 0;
		while (cursor < pieces.length) {
			const owner = pieces[cursor].owner;
			let end = cursor;
			while (end < pieces.length && pieces[end].owner === owner) {
				end++;
			}
			embeddings[owner] = combineChunkEmbeddings(
				pieceEmbeddings.slice(cursor, end),
				pieces.slice(cursor, end).map((piece) => piece.tokens),
			);
			cursor = end;
		}

		const cost = (totalTokens / 1_000_000) * costPerMillion;

		logger.info(
			`[EmbeddingGenerator] Generated ${embeddings.length} embeddings from ${pieces.length} input(s) across ${batches.length} request(s): ${totalTokens} tokens, $${cost.toFixed(4)} cost, model: ${baseModelName}`,
		);
		logEmbeddingUsageAsync({
			context: {
				userId: tenantContext.userId,
				organizationId: tenantContext.organizationId,
			},
			metadata,
			usageTokens: totalTokens,
			latencyMs: Date.now() - embeddingStart,
			projectId: tenantContext.projectId,
		});

		return {
			embeddings,
			model: baseModelName,
			totalTokens,
			cost,
		};
	} catch (error) {
		logger.error(
			"[EmbeddingGenerator] Failed to generate batch embeddings",
			{
				error: error instanceof Error ? error.message : error,
				modelName: baseModelName,
			},
		);
		throw new Error(
			`Batch embedding generation failed: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}
