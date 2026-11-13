/**
 * Embedding Service for Project Documents (PRD, Proposal, etc.)
 *
 * This module handles embedding generated project documents (PRD, Proposal, etc.)
 * so they can be used as context for generating other documents
 * (User Stories, Tech Spec, Architecture, API Spec).
 *
 * Key Features:
 * - Embed on document completion/update
 * - Re-embed when content changes (using content hash)
 * - Replace old embeddings after successful re-embedding
 * - Uses same Qdrant collection as project contexts
 */

import { createHash } from "node:crypto";
import {
	clearDocumentEmbedding,
	getProjectRagSettings,
	markDocumentAsEmbedded,
	markDocumentAsEmbeddedIfVersionUnchanged,
	markProjectDocumentChunkingVersion,
} from "@repo/database";
import { logger } from "@repo/logs";
import { stripVisualSlots } from "@repo/utils/glossy/visual-slots";
import {
	type ChunkingStrategy,
	chunkProjectContent,
	chunkText,
	contentKindForDocumentType,
	detectContentType,
	isChunkProfile,
	isContentAwareChunkingActive,
	parseChunkProfilesConfig,
	CHUNKING_THRESHOLD as ROUTER_CHUNKING_THRESHOLD,
	type TextChunk,
} from "../chunking";
import { generateEmbedding, generateEmbeddings } from "../embedding";
import {
	deleteProjectContext,
	deleteProjectContextPoints,
	listProjectContextPointIds,
	storeProjectContext,
} from "../project-contexts/store";
import { replaceDocumentEmbedding } from "./replace";

/**
 * How many chunk texts to send in a single embeddings API call.
 *
 * OpenAI `text-embedding-3-small` accepts arrays up to 2048 inputs, but
 * smaller batches keep individual requests fast and bound the blast radius
 * of a transient failure (a batch that fails is retried as a whole, and we
 * don't want to lose 100 chunks of work on a flaky call).
 */
const EMBED_BATCH_SIZE = 25;

/**
 * How many Qdrant upserts to run in parallel per batch.
 *
 * Keeps a small parallelism window so a single activity attempt doesn't
 * saturate Qdrant or hit client-side connection limits, while still being
 * meaningfully faster than strict sequential upsert.
 */
const UPSERT_CONCURRENCY = 5;

/**
 * Provider configuration for document embeddings
 */
export interface DocumentEmbedProviderConfig {
	apiKey: string;
	provider?: string | null;
	baseUrl?: string | null;
}

export interface EmbedDocumentOptions {
	documentId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	documentType: string; // PRD, PROPOSAL, etc.
	title: string;
	apiKey: string | DocumentEmbedProviderConfig;
	/**
	 * The `ProjectDocument.version` observed by the caller at the start of
	 * embedding. When present, the final `markDocumentAsEmbedded` step is
	 * gated on the DB row still being at this version, which prevents a
	 * concurrent run (from a rapid-succession save) from being overwritten
	 * by a stale older run that is still running because its workflow was
	 * `TERMINATE_EXISTING`-d but its activity kept executing in background.
	 * See update-document.ts for the workflow dedupe policy this guards.
	 */
	expectedVersion?: number;
	/**
	 * Cancellation signal used to abort the embed loop early when the
	 * calling Temporal activity has been cancelled (e.g. because the
	 * containing workflow was `TERMINATE_EXISTING`-d by a newer save). The
	 * signal is checked at batch and upsert-window boundaries so a
	 * superseded run stops calling `storeProjectContext` within ~1 heartbeat
	 * interval of cancellation, instead of running to completion and racing
	 * the newer run's upserts on the same deterministic Qdrant point IDs.
	 */
	abortSignal?: AbortSignal;
	/** The document's chunking profile override (`ProjectDocument.chunkProfile`). */
	chunkProfile?: string | null;
}

export interface DocumentEmbedResult {
	success: boolean;
	/** This run was cancelled or lost the document version guard. */
	superseded?: boolean;
	qdrantId?: string;
	contentHash?: string;
	error?: string;
	chunksCreated?: number;
}

/**
 * Generate content hash for change detection.
 *
 * Hashes exactly what it is given: the decision pre-check shares it, and
 * `computeDocumentContentHash` in `@repo/database` must match it byte for
 * byte. The embed paths below pass it the slot-free body.
 */
export function generateContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").substring(0, 16);
}

/**
 * Normalize apiKey to full provider config
 */
function normalizeProviderConfig(
	apiKey: string | DocumentEmbedProviderConfig,
): DocumentEmbedProviderConfig {
	if (typeof apiKey === "string") {
		return { apiKey };
	}
	return apiKey;
}

/**
 * Threshold for chunking - content smaller than this is embedded as single chunk
 */
const CHUNKING_THRESHOLD = 2048;

/**
 * Map split method to chunking strategy
 */
function mapSplitMethodToStrategy(splitMethod: string): ChunkingStrategy {
	switch (splitMethod) {
		case "SENTENCE":
			return "SENTENCE";
		case "FIXED":
			return "FIXED";
		case "RECURSIVE":
			return "RECURSIVE";
		case "DOCUMENT":
			return "DOCUMENT";
		case "SEMANTIC":
			return "SEMANTIC";
		default:
			return "PARAGRAPH";
	}
}

/**
 * Embed a project document
 *
 * This function:
 * 1. Generates content hash for change detection
 * 2. Chunks content if needed based on project RAG settings
 * 3. Generates embeddings for each chunk
 * 4. Stores in Qdrant with document metadata
 * 5. Updates database with embedding status
 */
export async function embedProjectDocument(
	options: EmbedDocumentOptions,
): Promise<DocumentEmbedResult> {
	const {
		documentId,
		projectId,
		userId,
		organizationId,
		documentType,
		title,
		apiKey,
	} = options;
	// A Glossy visual slot is a placeholder marker, not prose: retrieval never
	// sees it, and the hash is the slot-free body's, so placing or removing a
	// slot leaves an otherwise unchanged document's embedding alone (KTD17).
	const content = stripVisualSlots(options.content);

	logger.info(
		`[DocumentEmbed] Embedding document ${documentId} (${documentType}) for project ${projectId}`,
	);

	try {
		// Skip if no content
		if (!content || content.trim().length === 0) {
			logger.warn(
				`[DocumentEmbed] Document ${documentId} has no content, skipping`,
			);
			return { success: true, chunksCreated: 0 };
		}

		// Generate content hash for change detection
		const contentHash = generateContentHash(content);

		// Normalize provider config
		const providerConfig = normalizeProviderConfig(apiKey);

		if (!providerConfig.apiKey) {
			throw new Error(
				"No AI provider configured. Please configure an AI provider in Settings.",
			);
		}

		// Get project's RAG settings
		const ragSettings = await getProjectRagSettings(projectId);

		// Use document-prefixed ID to avoid collision with project contexts.
		// This is the stable "base" id for the document, used as
		// `originalContextId` in payloads so delete-by-filter can wipe every
		// version at once.
		const embeddingContextId = `doc-${documentId}`;

		// Per-chunk contextIds are suffixed with the document version when
		// the caller provided one. The deterministic Qdrant point id is
		// hashed from the contextId, so two concurrent runs with different
		// `expectedVersion`s (a superseded old run and the new run that
		// TERMINATE_EXISTING-d it) write to completely different point ids
		// instead of racing on the same id. Any zombie points left by a
		// stale upsert are reaped by `projectDocumentEmbeddingSweepWorkflow`
		// which filters on `originalContextId` + `documentVersion < current`.
		const versionSuffix =
			options.expectedVersion != null
				? `-v${options.expectedVersion}`
				: "";

		// Content-type chunking (spec 2026-10-28): only with the project's
		// toggle and the flag on. The router cuts the document; storage is the
		// chunked path below. Off, nothing here changes.
		if (
			await isContentAwareChunkingActive({
				chunkByContentType: ragSettings.chunkByContentType,
				organizationId,
				chunkProfiles: parseChunkProfilesConfig(
					ragSettings.chunkProfiles,
				),
			})
		) {
			const routed = await chunkProjectContent({
				content,
				mimeType: "text/markdown",
				filename: options.title || documentId,
				chunkingThreshold: ROUTER_CHUNKING_THRESHOLD,
				chunkSize: ragSettings.chunkSize,
				chunkOverlap: ragSettings.chunkOverlap,
				textStrategy: documentTextStrategy(
					content,
					ragSettings.splitMethod,
				),
				chunkByContentType: ragSettings.chunkByContentType,
				organizationId,
				kind: contentKindForDocumentType(documentType),
				profileOverride: isChunkProfile(options.chunkProfile)
					? options.chunkProfile
					: null,
				chunkProfiles: parseChunkProfilesConfig(
					ragSettings.chunkProfiles,
				),
			});
			const result = await embedDocumentWithChunking(
				{ ...options, content },
				ragSettings,
				embeddingContextId,
				contentHash,
				{
					chunks: routed.chunks,
					payloads: routed.chunkPayloads,
					chunkingVersion: ragSettings.chunkingVersion,
				},
			);
			if (result.success && !result.superseded) {
				await recordDocumentChunkingVersion(
					documentId,
					ragSettings.chunkingVersion,
				);
			}
			return result;
		}

		// Determine if we need to chunk
		const needsChunking = content.length > CHUNKING_THRESHOLD;

		if (needsChunking) {
			return await embedDocumentWithChunking(
				{ ...options, content },
				ragSettings,
				embeddingContextId,
				contentHash,
			);
		}

		// Bail out before any work if the caller's activity has already been
		// cancelled (e.g. workflow TERMINATE_EXISTING). Saves a wasted round
		// trip to the embeddings API for a run that's known to be superseded.
		if (options.abortSignal?.aborted) {
			logger.warn(
				`[DocumentEmbed] Aborting single-chunk embedding for ${documentId} — activity was cancelled before start`,
			);
			return {
				success: false,
				superseded: true,
				error: "Embedding cancelled — superseded by a newer run",
				chunksCreated: 0,
			};
		}

		// Small content - embed as single chunk. Pass the abort signal so
		// the in-flight embedding API call can be cancelled if this run
		// is superseded before it completes.
		const embeddingResult = await generateEmbedding(
			content,
			{
				userId,
				organizationId,
				projectId,
				featureKey: "knowledge-index",
				tags: ["project-document", documentType.toLowerCase()],
			},
			providerConfig,
			options.abortSignal,
		);

		if (
			!embeddingResult ||
			!embeddingResult.embedding ||
			embeddingResult.embedding.length === 0
		) {
			throw new Error("Failed to generate embedding");
		}

		// Check cancellation AFTER the embedding API call but BEFORE the
		// Qdrant upsert. This is the critical guard for the single-chunk
		// path: if this run was cancelled while waiting on the embedding
		// response and a newer run has already landed in Qdrant, we must
		// not overwrite the newer deterministic point ID (`doc-${id}`) with
		// our stale embedding. The version guard later only protects the
		// DB row, not the Qdrant vector.
		if (options.abortSignal?.aborted) {
			logger.warn(
				`[DocumentEmbed] Aborting single-chunk embedding for ${documentId} after embedding generation — activity was cancelled, skipping Qdrant upsert to avoid overwriting a newer run's point`,
			);
			return {
				success: false,
				superseded: true,
				error: "Embedding cancelled — superseded by a newer run",
				chunksCreated: 0,
			};
		}

		// Store in Qdrant (using same collection as project contexts).
		// `contextId` is suffixed with the document version so stale and
		// fresh upserts land on different deterministic point ids.
		// `originalContextId` stays unversioned so delete-by-filter wipes
		// every version at once. `documentVersion` in the payload lets the
		// zombie-sweep workflow reap stragglers from superseded runs.
		const qdrantId = await storeProjectContext({
			contextId: `${embeddingContextId}${versionSuffix}`,
			projectId,
			userId,
			organizationId,
			content,
			embedding: embeddingResult.embedding,
			metadata: {
				type: `DOCUMENT_${documentType}`,
				sourceTitle: title,
				documentId,
				documentType,
				chunkIndex: 0,
				totalChunks: 1,
				originalContextId: embeddingContextId,
				documentVersion: options.expectedVersion,
			},
		});

		// Update database, gated on version if the caller provided one.
		// See `expectedVersion` on EmbedDocumentOptions for the rationale.
		if (options.expectedVersion != null) {
			const { updated } = await markDocumentAsEmbeddedIfVersionUnchanged(
				documentId,
				qdrantId,
				contentHash,
				options.expectedVersion,
			);
			if (!updated) {
				logger.warn(
					`[DocumentEmbed] Document ${documentId} version drifted from ${options.expectedVersion} during embedding — skipping mark; a newer run will own the final state`,
				);
				return {
					success: true,
					superseded: true,
					qdrantId,
					contentHash,
					chunksCreated: 1,
				};
			}
		} else {
			await markDocumentAsEmbedded(documentId, qdrantId, contentHash);
		}

		logger.info(
			`[DocumentEmbed] Successfully embedded document ${documentId} (single chunk)`,
		);

		return {
			success: true,
			qdrantId,
			contentHash,
			chunksCreated: 1,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[DocumentEmbed] Failed to embed document ${documentId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
			...(options.abortSignal?.aborted ? { superseded: true } : {}),
		};
	}
}

/**
 * Embed document with chunking for large content
 */
async function embedDocumentWithChunking(
	options: EmbedDocumentOptions,
	ragSettings: {
		chunkSize: number;
		chunkOverlap: number;
		splitMethod: string;
	},
	embeddingContextId: string,
	contentHash: string,
	/** Chunks already cut by content-type chunking; unset: chunked here. */
	precomputed?: {
		chunks: TextChunk[];
		payloads: Array<Record<string, unknown>>;
		chunkingVersion: number;
	},
): Promise<DocumentEmbedResult> {
	const {
		documentId,
		projectId,
		userId,
		organizationId,
		content,
		documentType,
		title,
	} = options;

	// NOTE: `apiKey`/`providerConfig` is no longer needed here — the batch
	// `generateEmbeddings` path uses `getAIEmbeddingModelWithMetadata` for
	// centralized provider resolution and marks the legacy provider arg as
	// deprecated. The single-chunk path in `embedProjectDocument` still uses
	// `generateEmbedding` with the legacy arg until that is migrated too.

	logger.info(
		`[DocumentEmbed] Chunking document (${content.length} chars) with strategy=${ragSettings.splitMethod}`,
	);

	let chunks: TextChunk[];
	if (precomputed) {
		chunks = precomputed.chunks;
	} else {
		// Detect content type
		const contentInfo = detectContentType(content);

		// Use DOCUMENT strategy for markdown content (PRD/Proposal are typically markdown)
		let strategy = mapSplitMethodToStrategy(ragSettings.splitMethod);
		if (contentInfo.type === "markdown" || contentInfo.type === "code") {
			strategy = "DOCUMENT";
		}

		// Chunk the content
		chunks = chunkText(content, title || documentId, {
			strategy,
			chunkSize: ragSettings.chunkSize,
			chunkOverlap: ragSettings.chunkOverlap,
			contentType: contentInfo.type,
		});
	}

	logger.info(
		`[DocumentEmbed] Created ${chunks.length} chunks for document ${documentId}`,
	);

	// Generate all vectors in batches before writing any points. Then store
	// chunks with bounded upsert parallelism. Strictly sequential embed + upsert
	// was taking up to 5 min for ~150-chunk docs and tripping the activity
	// timeout. Batching embeddings collapses N HTTP round-trips into N/25, and
	// parallel upserts hide Qdrant latency for the remaining work.
	let firstQdrantId: string | undefined;
	let successCount = 0;
	const errors: string[] = [];
	const chunkEmbeddings: number[][] = [];
	const writtenIds: string[] = [];
	let aborted = false;

	// Per-chunk contextIds are suffixed with the document version when the
	// caller provided one, so stale and fresh upserts from concurrent runs
	// land on different deterministic Qdrant point ids instead of racing.
	// See `versionSuffix` in embedProjectDocument for the full rationale.
	const versionSuffix =
		options.expectedVersion != null ? `-v${options.expectedVersion}` : "";
	const buildChunkContextId = (chunkIndex: number): string =>
		chunks.length > 1
			? `${embeddingContextId}${versionSuffix}-chunk-${chunkIndex}`
			: `${embeddingContextId}${versionSuffix}`;

	for (
		let batchStart = 0;
		batchStart < chunks.length;
		batchStart += EMBED_BATCH_SIZE
	) {
		// Bail out before starting a new batch if the caller's activity was
		// cancelled (e.g. workflow TERMINATE_EXISTING). Without this, a
		// superseded run would keep generating embeddings and racing the
		// newer run's Qdrant upserts on the same deterministic point IDs.
		if (options.abortSignal?.aborted) {
			aborted = true;
			logger.warn(
				`[DocumentEmbed] Aborting chunked embedding for ${documentId} — activity was cancelled mid-run (${successCount}/${chunks.length} chunks landed before cancellation)`,
			);
			break;
		}

		const batch = chunks.slice(batchStart, batchStart + EMBED_BATCH_SIZE);
		const batchTexts = batch.map((c) => c.content);

		let batchEmbeddings: number[][];
		try {
			const result = await generateEmbeddings(
				batchTexts,
				{
					userId,
					organizationId,
					projectId,
					featureKey: "knowledge-index",
					tags: ["project-document", documentType.toLowerCase()],
				},
				undefined,
				options.abortSignal,
			);
			batchEmbeddings = result.embeddings;
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[DocumentEmbed] Failed to generate embeddings for batch starting at chunk ${batch[0]?.index}: ${errorMsg}`,
			);
			return {
				success: false,
				error: errorMsg,
				...(options.abortSignal?.aborted ? { superseded: true } : {}),
			};
		}
		if (batchEmbeddings.length !== batch.length) {
			const error = `Embedding count mismatch: expected ${batch.length}, got ${batchEmbeddings.length}`;
			logger.error(`[DocumentEmbed] ${error}`);
			return { success: false, error };
		}
		for (const [offset, embedding] of batchEmbeddings.entries()) {
			if (!embedding || embedding.length === 0) {
				const error = `Chunk ${batch[offset].index}: Empty embedding result`;
				logger.error(`[DocumentEmbed] ${error}`);
				return { success: false, error };
			}
			chunkEmbeddings.push(embedding);
		}
	}
	if (options.abortSignal?.aborted) {
		return {
			success: false,
			superseded: true,
			error: "Embedding cancelled",
			chunksCreated: 0,
		};
	}
	// Preserve pre-existing ids during rollback, including same-version retries.
	// A write failure in a same-version run can leave overwritten chunks in
	// place with new text; the point-id-only API cannot restore them (Fizzy #3563).
	const previousIds = new Set(
		await listProjectContextPointIds(embeddingContextId, organizationId),
	);

	// Upsert chunks to Qdrant with bounded parallelism. Preserve order
	// so firstQdrantId maps to the first chunk (index 0) in a stable way.
	for (
		let windowStart = 0;
		windowStart < chunks.length;
		windowStart += UPSERT_CONCURRENCY
	) {
		// Check cancellation again at each upsert-window boundary so a
		// mid-batch cancellation doesn't end up upserting the remainder
		// of the batch after the heartbeat has surfaced the abort.
		if (options.abortSignal?.aborted) {
			aborted = true;
			logger.warn(
				`[DocumentEmbed] Aborting chunked embedding for ${documentId} mid-batch — activity was cancelled (${successCount}/${chunks.length} chunks landed before cancellation)`,
			);
			break;
		}

		const window = chunks.slice(
			windowStart,
			windowStart + UPSERT_CONCURRENCY,
		);
		const results = await Promise.all(
			window.map(async (chunk, offset) => {
				const embedding = chunkEmbeddings[windowStart + offset];
				if (!embedding || embedding.length === 0) {
					return {
						chunk,
						error: "Empty embedding result",
						qdrantId: undefined as string | undefined,
					};
				}
				try {
					const qdrantId = await storeProjectContext({
						contextId: buildChunkContextId(chunk.index),
						projectId,
						userId,
						organizationId,
						content: chunk.content,
						embedding,
						metadata: {
							type: `DOCUMENT_${documentType}`,
							sourceTitle: title,
							documentId,
							documentType,
							chunkIndex: chunk.index,
							totalChunks: chunks.length,
							headings: chunk.metadata.headings,
							section: chunk.metadata.section,
							originalContextId: embeddingContextId,
							documentVersion: options.expectedVersion,
							// The profile on content-type chunks; absent otherwise.
							...(precomputed
								? {
										...precomputed.payloads[chunk.index],
										chunkingVersion:
											precomputed.chunkingVersion,
									}
								: {}),
						},
					});
					return { chunk, error: undefined, qdrantId };
				} catch (error) {
					return {
						chunk,
						error:
							error instanceof Error
								? error.message
								: String(error),
						qdrantId: undefined,
					};
				}
			}),
		);

		for (const r of results) {
			if (r.error) {
				logger.error(
					`[DocumentEmbed] Failed to embed chunk ${r.chunk.index}: ${r.error}`,
				);
				errors.push(`Chunk ${r.chunk.index}: ${r.error}`);
				continue;
			}
			// Capture the first successful upsert in ascending chunk order
			// (batches and windows both iterate ascending). Matches the
			// legacy per-chunk loop's semantics: firstQdrantId is the
			// Qdrant point ID of the earliest chunk that successfully
			// landed, used by markDocumentAsEmbedded as the document's
			// anchor point reference.
			if (!firstQdrantId) {
				firstQdrantId = r.qdrantId;
			}
			successCount++;
			if (r.qdrantId) {
				writtenIds.push(r.qdrantId);
			}
		}
		if (errors.length > 0) {
			break;
		}
	}

	if (options.abortSignal?.aborted) {
		aborted = true;
	}
	if (aborted || errors.length > 0) {
		try {
			await deleteProjectContextPoints(
				writtenIds.filter((id) => !previousIds.has(id)),
				organizationId,
			);
		} catch (error) {
			logger.warn("[DocumentEmbed] Failed to roll back new points", {
				error,
			});
		}
		return {
			success: false,
			...(aborted ? { superseded: true } : {}),
			error: aborted ? "Embedding cancelled" : errors[0],
			chunksCreated: 0,
		};
	}
	if (successCount === 0) {
		return {
			success: false,
			error: `Failed to embed any chunks: ${errors[0] || "Unknown error"}`,
		};
	}

	// Update database, gated on version if the caller provided one.
	// See `expectedVersion` on EmbedDocumentOptions for the rationale.
	if (firstQdrantId) {
		if (options.expectedVersion != null) {
			const { updated } = await markDocumentAsEmbeddedIfVersionUnchanged(
				documentId,
				firstQdrantId,
				contentHash,
				options.expectedVersion,
			);
			if (!updated) {
				logger.warn(
					`[DocumentEmbed] Document ${documentId} version drifted from ${options.expectedVersion} during chunked embedding — skipping mark; a newer run will own the final state`,
				);
				return {
					success: true,
					superseded: true,
					qdrantId: firstQdrantId,
					contentHash,
					chunksCreated: successCount,
				};
			}
		} else {
			await markDocumentAsEmbedded(
				documentId,
				firstQdrantId,
				contentHash,
			);
		}
	}

	logger.info(
		`[DocumentEmbed] Successfully embedded document ${documentId}: ${successCount}/${chunks.length} chunks`,
	);

	return {
		success: true,
		qdrantId: firstQdrantId,
		contentHash,
		chunksCreated: successCount,
	};
}

/**
 * Re-embed a document after content update
 * Writes new embeddings before removing stale points
 */
export async function reembedProjectDocument(
	options: EmbedDocumentOptions,
	oldContentHash?: string,
): Promise<DocumentEmbedResult> {
	const { documentId } = options;

	// Check if content actually changed — on the slot-free body, the one
	// `embedProjectDocument` hashes and stores.
	const newContentHash = generateContentHash(
		stripVisualSlots(options.content),
	);
	if (oldContentHash && newContentHash === oldContentHash) {
		logger.info(
			`[DocumentEmbed] Document ${documentId} content unchanged, skipping re-embed`,
		);
		return { success: true, contentHash: oldContentHash, chunksCreated: 0 };
	}

	logger.info(`[DocumentEmbed] Re-embedding document ${documentId}`);

	try {
		return await replaceDocumentEmbedding(options, embedProjectDocument);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[DocumentEmbed] Failed to re-embed document ${documentId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
			...(options.abortSignal?.aborted ? { superseded: true } : {}),
		};
	}
}

/**
 * Remove embedding for a deleted document
 */
export async function removeDocumentEmbedding(
	documentId: string,
	organizationId?: string,
): Promise<void> {
	const embeddingContextId = `doc-${documentId}`;

	logger.info(
		`[DocumentEmbed] Removing embedding for document ${documentId}`,
	);

	try {
		await deleteProjectContext(embeddingContextId, organizationId);
		await clearDocumentEmbedding(documentId);
		logger.info(
			`[DocumentEmbed] Removed embedding for document ${documentId}`,
		);
	} catch (error) {
		logger.warn(
			`[DocumentEmbed] Failed to remove embedding for ${documentId}: ${error}`,
		);
	}
}

/** The fallback strategy the chunked path applies to a document. */
function documentTextStrategy(
	content: string,
	splitMethod: string,
): ChunkingStrategy {
	const contentInfo = detectContentType(content);
	return contentInfo.type === "markdown" || contentInfo.type === "code"
		? "DOCUMENT"
		: mapSplitMethodToStrategy(splitMethod);
}

/** Best-effort: a missed stamp only makes a later re-chunk redo this document. */
async function recordDocumentChunkingVersion(
	documentId: string,
	chunkingVersion: number,
): Promise<void> {
	if (chunkingVersion <= 0) {
		return;
	}
	try {
		await markProjectDocumentChunkingVersion(documentId, chunkingVersion);
	} catch (error) {
		logger.warn("[DocumentEmbed] Could not record the chunking version", {
			documentId,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}
