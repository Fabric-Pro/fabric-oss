/**
 * Automatic Embedding Service for Project Contexts
 *
 * This module provides automatic embedding generation and updates for project contexts.
 * It ensures that embeddings are created/updated whenever context content changes.
 *
 * Key Features:
 * - Automatic embedding on context creation
 * - Re-embedding on content updates
 * - Cleanup of stale embeddings on deletion
 * - Batch processing for efficiency
 * - Uses project's RAG settings for chunking configuration
 * - Smart chunking based on content size and type
 *
 * Chunking Strategy (based on research):
 * - Small content (<2048 chars): Single embedding
 * - Large content: Chunk using project's configured strategy
 * - Default: 512 tokens with 50 token overlap
 *
 * @see https://weaviate.io/blog/chunking-strategies-for-rag
 */

import {
	getDefaultRagSettings,
	getOrganizationRagSettings,
	getProjectRagSettings,
	markContextAsEmbedded,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	type ChunkingStrategy,
	type ContentRoute,
	chunkDescribedOpenApiSpec,
	chunkText,
	detectContentType,
	enrichChunksWithTenantContext,
	routeContentForChunking,
	type TextChunk,
} from "../chunking";
// The modules, not the `../company-contexts` barrel, which also carries
// retrieval and the model resolver.
import {
	COMPANY_EMBEDDING_RESOLUTION,
	companyEmbeddingIdentity,
} from "../company-contexts/resolution";
import { storeCompanyContextPoints } from "../company-contexts/store";
import { generateEmbedding, generateEmbeddings } from "../embedding";
import { deleteProjectContext, storeProjectContext } from "./store";

/**
 * Provider configuration for embeddings
 */
export interface EmbedProviderConfig {
	apiKey: string;
	provider?: string | null;
	baseUrl?: string | null;
}

export interface EmbedContextOptions {
	contextId: string;
	projectId: string;
	userId: string;
	organizationId?: string;
	content: string;
	type: string;
	/** API key string (legacy) or full provider config */
	apiKey: string | EmbedProviderConfig;
	metadata?: {
		filename?: string;
		/** Declared so spec detection can skip non-JSON/YAML content cheaply. */
		mimeType?: string;
		sourceUrl?: string;
		sourceTitle?: string;
		[key: string]: unknown;
	};
	/**
	 * Skip the post-embed `markContextAsEmbedded` DB update. Default false
	 * (legacy behaviour). Set to true when the caller owns its own row in a
	 * sibling table — e.g. URL Context Sources child pages live in
	 * `ProjectContextUrlPage` and the calling activity does its own
	 * `projectContextUrlPage.update(...)` afterwards. Without this opt-out,
	 * embedProjectContext tries `projectContext.update({ id: pageId })` and
	 * throws because the row is in the wrong table.
	 */
	skipDbUpdate?: boolean;
}

/**
 * Normalize apiKey to full provider config
 */
function normalizeProviderConfig(
	apiKey: string | EmbedProviderConfig,
): EmbedProviderConfig {
	if (typeof apiKey === "string") {
		return { apiKey };
	}
	return apiKey;
}

export interface EmbedResult {
	success: boolean;
	qdrantId?: string;
	error?: string;
	chunksCreated?: number;
}

/**
 * Threshold for chunking - content smaller than this is embedded as single chunk
 * 2048 chars ≈ 512 tokens - the recommended baseline chunk size
 */
const CHUNKING_THRESHOLD = 2048;

/**
 * Map database ChunkSplitMethod to chunking strategy
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
 * Where a company source's points go (Fizzy #2719); see `embedCompanyContext`.
 */
export interface CompanyEmbedTarget {
	organizationId: string;
	/** The `CompanyContextSource` the text belongs to: every point's `originalContextId`. */
	sourceId: string;
	/** The source's type (`FILE` | `TEXT` | `LINK`): every point's `contextType`. */
	contextType: string;
	/** The source id, when the text is a crawled page's; omitted otherwise. */
	parentContextId?: string | null;
}

/**
 * Options for `embedCompanyContext`. `contextId` is the row the text came
 * from: the source itself, or a crawled page of it. There is no project, and
 * the organization is the target's.
 *
 * There is no key either: the embedding call resolves the organization's own
 * embedding provider (`COMPANY_EMBEDDING_RESOLUTION`) and fails when it has
 * none, so a key resolved another way — the default provider, or an acting
 * member's personal one — never decides whether a company source is indexed.
 */
export type EmbedCompanyContextOptions = Omit<
	EmbedContextOptions,
	"projectId" | "organizationId" | "skipDbUpdate" | "apiKey"
> & {
	company: CompanyEmbedTarget;
};

/** What `embedCompanyContext` did. */
export interface CompanyEmbedResult extends EmbedResult {
	/**
	 * On success, the identity of the model that produced the points, which
	 * every point carries. The caller marks its row with this one, not with
	 * an identity it resolved before the embed: the organization may have
	 * switched models in between.
	 */
	embeddingModel?: string;
}

/**
 * Whose context is being embedded. It decides where the chunk settings come
 * from and where the points go: a project context reads its project's RAG
 * settings and writes the project collection; a company source reads its
 * organization's settings and writes the company collection.
 */
type EmbedOwner =
	| { kind: "project"; projectId: string }
	| ({ kind: "company" } & CompanyEmbedTarget);

/**
 * The embed options apart from the project, which the owner carries. The key
 * is a project embed's; a company embed has none (see
 * `EmbedCompanyContextOptions`).
 */
type EmbedContextBody = Omit<EmbedContextOptions, "projectId" | "apiKey"> & {
	apiKey?: EmbedContextOptions["apiKey"];
};

/** Chunk settings in the shape the project RAG settings have. */
export interface ContextChunkSettings {
	chunkSize: number;
	chunkOverlap: number;
	/** A `ChunkSplitMethod`; null leaves the choice to the content. */
	splitMethod: string | null;
	/** `splitMethod` as a chunking strategy; undefined when it is null. */
	strategy: ChunkingStrategy | undefined;
}

/**
 * Chunk settings for an organization's company context: its
 * `OrganizationRagSettings`, each unset field falling back to `defaults`, and
 * those to the system defaults the organization settings override. Project
 * RAG settings are keyed by project, so they never apply to a company source.
 *
 * A caller whose pipeline has defaults of its own passes them, so a company
 * source is chunked exactly like the matching project content until the
 * organization sets something.
 */
export async function getCompanyChunkSettings(
	organizationId: string,
	defaults?: {
		chunkSize: number;
		chunkOverlap: number;
		splitMethod: string | null;
	},
): Promise<ContextChunkSettings> {
	if (!organizationId) {
		throw new Error("getCompanyChunkSettings requires an organizationId");
	}
	const fallback = defaults ?? getDefaultRagSettings();
	const settings = await getOrganizationRagSettings(organizationId);
	const splitMethod = settings?.splitMethod ?? fallback.splitMethod;
	return {
		chunkSize: settings?.chunkSize ?? fallback.chunkSize,
		chunkOverlap: settings?.chunkOverlap ?? fallback.chunkOverlap,
		splitMethod,
		strategy: splitMethod
			? mapSplitMethodToStrategy(splitMethod)
			: undefined,
	};
}

/** One chunk of a company embed. */
interface CompanyChunk {
	/** What is embedded: the chunk with its document context, when enriched. */
	embedText: string;
	/** What the point stores, and retrieval hands the prompt. */
	content: string;
	chunkIndex: number;
}

/**
 * Embed a company source's chunks and write them to the company collection
 * (Fizzy #2719).
 *
 * One embedding call for all the chunks resolves the model once, so every
 * point carries the same identity, and it is the identity of the model that
 * call actually used. It is returned for the caller to mark its row with.
 * One batched store writes the points.
 *
 * All or nothing: a source is ready only once it is marked embedded, so a
 * missing embedding or a failed write fails the whole embed for the caller to
 * record and retry. Point ids are deterministic, so a retry replaces what
 * this pass wrote.
 */
async function embedCompanyChunks(
	owner: Extract<EmbedOwner, { kind: "company" }>,
	options: EmbedContextBody,
	chunks: readonly CompanyChunk[],
): Promise<CompanyEmbedResult> {
	const { contextId, userId, organizationId, type, metadata } = options;

	const result = await generateEmbeddings(
		chunks.map((chunk) => chunk.embedText),
		{
			userId,
			organizationId,
			tags: ["company-context", type.toLowerCase()],
			...COMPANY_EMBEDDING_RESOLUTION,
		},
	);
	const embedded = result.embeddings.filter(
		(embedding) => embedding && embedding.length > 0,
	).length;
	if (
		result.embeddings.length !== chunks.length ||
		embedded < chunks.length
	) {
		return {
			success: false,
			error: `Failed to embed ${chunks.length - embedded}/${chunks.length} chunks: empty embedding result`,
		};
	}
	const embeddingModel = companyEmbeddingIdentity(result);

	const ids = await storeCompanyContextPoints(
		chunks.map((chunk, index) => ({
			organizationId: owner.organizationId,
			sourceId: owner.sourceId,
			contextId,
			parentContextId: owner.parentContextId ?? null,
			contextType: owner.contextType,
			embeddingModel,
			sourceUrl: metadata?.sourceUrl ?? null,
			sourceTitle: metadata?.sourceTitle ?? null,
			content: chunk.content,
			embedding: result.embeddings[index],
			chunkIndex: chunk.chunkIndex,
		})),
	);

	logger.info(
		`[AutoEmbed] Successfully embedded company context ${contextId}: ${ids.length} chunk(s) with ${embeddingModel}`,
	);
	return {
		success: true,
		qdrantId: ids[0],
		chunksCreated: ids.length,
		embeddingModel,
	};
}

/**
 * Embed a company context source, or a crawled page of one (Fizzy #2719).
 *
 * The same chunking as `embedProjectContext`, with the organization's chunk
 * settings, embedded with the organization's model into the organization's
 * company collection. It never writes a row: the caller records the embed on
 * its own row, with the model identity the result names.
 */
export async function embedCompanyContext(
	options: EmbedCompanyContextOptions,
): Promise<CompanyEmbedResult> {
	const { company, ...body } = options;
	return embedContext(
		{ ...body, organizationId: company.organizationId, skipDbUpdate: true },
		{ kind: "company", ...company },
	);
}

/**
 * Embed a single project context
 *
 * This function:
 * 1. Determines if content needs chunking based on size
 * 2. Chunks the content based on project RAG settings (if needed)
 * 3. Generates embeddings for each chunk
 * 4. Stores embeddings in Qdrant with proper isolation
 * 5. Updates the database with embedding status
 *
 * Chunking Strategy:
 * - Small content (<2048 chars): Single embedding for efficiency
 * - Large content: Chunk using project's configured strategy
 * - Auto-detect content type for optimal chunking
 *
 * @param options - Embed options
 * @returns Embed result
 */
export async function embedProjectContext(
	options: EmbedContextOptions,
): Promise<EmbedResult> {
	return embedContext(options, {
		kind: "project",
		projectId: options.projectId,
	});
}

/** The embed both owners share; `owner` decides settings and destination. */
async function embedContext(
	options: EmbedContextBody,
	owner: EmbedOwner,
): Promise<CompanyEmbedResult> {
	const {
		contextId,
		userId,
		organizationId,
		content,
		type,
		apiKey,
		metadata,
		skipDbUpdate = false,
	} = options;
	const projectId = owner.kind === "project" ? owner.projectId : undefined;

	logger.info(
		owner.kind === "project"
			? `[AutoEmbed] Embedding context ${contextId} for project ${projectId}`
			: `[AutoEmbed] Embedding company context ${contextId} for organization ${owner.organizationId}`,
	);

	try {
		// Skip if no content
		if (!content || content.trim().length === 0) {
			logger.warn(
				`[AutoEmbed] Context ${contextId} has no content, skipping`,
			);
			return { success: true, chunksCreated: 0 };
		}

		// A project embed checks the key it was handed. A company embed has
		// none: its embedding call resolves the organization's own provider,
		// and fails when there is none.
		const providerConfig =
			owner.kind === "project"
				? normalizeProviderConfig(apiKey ?? "")
				: undefined;
		if (providerConfig && !providerConfig.apiKey) {
			throw new Error(
				"No AI provider configured. Please configure an AI provider in Settings → AI Providers.",
			);
		}

		// Chunking configuration: the project's RAG settings, or for a company
		// source its organization's.
		const ragSettings =
			owner.kind === "company"
				? await getCompanyChunkSettings(owner.organizationId)
				: await getProjectRagSettings(owner.projectId);

		// Determine if we need to chunk.
		//
		// A spec goes down the chunking path regardless of size. The size test
		// alone sent a spec under 2048 chars to the single-blob path below, where
		// routing is never consulted — so the same small spec came out
		// endpoint-chunked through `chunkProjectContent` and as one undifferentiated
		// vector through here, with no error either way. That is the exact
		// same-file-two-results bug the shared router exists to remove.
		const specRoute = await routeContentForChunking({
			content,
			mimeType: metadata?.mimeType || "",
			filename: metadata?.filename || contextId,
		});
		const needsChunking =
			specRoute.kind !== "text" || content.length > CHUNKING_THRESHOLD;

		if (needsChunking) {
			// Route computed once and handed down — it carries the parsed
			// document, so nothing below re-parses the spec.
			return await embedWithChunking(
				options,
				owner,
				ragSettings,
				specRoute,
			);
		}

		// Small content - embed as single chunk
		if (owner.kind === "company") {
			return await embedCompanyChunks(owner, options, [
				{ embedText: content, content, chunkIndex: 0 },
			]);
		}
		const embeddingResult = await generateEmbedding(
			content,
			{
				userId,
				organizationId,
				projectId,
				tags: ["project-context", type.toLowerCase()],
			},
			providerConfig,
		);

		if (
			!embeddingResult ||
			!embeddingResult.embedding ||
			embeddingResult.embedding.length === 0
		) {
			throw new Error("Failed to generate embedding");
		}

		// Store in Qdrant
		// IMPORTANT: Always set originalContextId so filter-based deletion works consistently
		const qdrantId = await storeProjectContext({
			contextId,
			projectId: owner.projectId,
			userId,
			organizationId,
			content,
			embedding: embeddingResult.embedding,
			metadata: {
				type,
				filename: metadata?.filename,
				sourceUrl: metadata?.sourceUrl,
				sourceTitle: metadata?.sourceTitle,
				provider: metadata?.provider,
				chunkIndex: 0,
				totalChunks: 1,
				// originalContextId enables filter-based deletion
				originalContextId: contextId,
				// Captured conversation bundles (Fizzy #2228) are embedded under
				// their OWN row id, in a table the retrieval refetch does not
				// otherwise look in. Forwarding these two is what lets a hit say
				// "this is a bundle, here is its id" — without them the caller's
				// metadata stops here and the point is unresolvable.
				conversationBundleId: metadata?.conversationBundleId,
				parentContextId: metadata?.parentContextId,
			},
		});

		// Update database with embedding status.
		// Skipped when the caller owns its own row in a sibling table (see
		// EmbedContextOptions.skipDbUpdate). URL Context Sources child pages
		// live in ProjectContextUrlPage, not ProjectContext, so embedding
		// them with skipDbUpdate=true avoids `projectContext.update({ id:
		// pageId })` failing with "No record was found for an update".
		if (!skipDbUpdate) {
			await markContextAsEmbedded(contextId, qdrantId);
		}

		logger.info(
			`[AutoEmbed] Successfully embedded context ${contextId} (single chunk)`,
		);

		return {
			success: true,
			qdrantId,
			chunksCreated: 1,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[AutoEmbed] Failed to embed context ${contextId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Embed content with chunking
 * Used for large content that needs to be split into multiple chunks
 */
async function embedWithChunking(
	options: EmbedContextBody,
	owner: EmbedOwner,
	ragSettings: {
		chunkSize: number;
		chunkOverlap: number;
		// Null only from company settings without a text default, which
		// the text path never asks for; the mapping's default applies.
		splitMethod: string | null;
	},
	specRoute: ContentRoute,
): Promise<CompanyEmbedResult> {
	const {
		contextId,
		userId,
		organizationId,
		content,
		type,
		apiKey,
		metadata,
		skipDbUpdate = false,
	} = options;
	const projectId = owner.kind === "project" ? owner.projectId : undefined;

	logger.info(
		`[AutoEmbed] Chunking content (${content.length} chars) with strategy=${ragSettings.splitMethod}, size=${ragSettings.chunkSize}`,
	);

	// An OpenAPI spec is chunked by endpoint here too. This is the third of the
	// three chunking implementations that existed before Fizzy #2236 — the one
	// driven by the project's RAG settings rather than by MIME — and a re-embed
	// arriving here without the spec route would quietly replace endpoint chunks
	// with character windows. The route arrives already computed, carrying the
	// parsed document with it.

	// A malformed spec must not be quietly indexed as prose here either. The
	// upload path fails the row for this; failing the embed keeps the two paths
	// telling the same story instead of one accepting what the other rejected.
	if (specRoute.kind === "malformed-openapi") {
		const reason = `This file looks like an OpenAPI/Swagger document but could not be read: ${specRoute.reason}`;
		logger.warn(`[AutoEmbed] ${reason}`);
		return { success: false, error: reason };
	}

	let chunks: TextChunk[];
	let specPayloads: Array<Record<string, unknown>> = [];

	if (specRoute.kind === "openapi") {
		const specChunks = chunkDescribedOpenApiSpec(
			specRoute.description,
			metadata?.filename || contextId,
		);
		chunks = specChunks;
		specPayloads = specChunks.map((chunk) => ({
			specTitle: chunk.specMetadata.specTitle,
			specVersion: chunk.specMetadata.specVersion,
			specChunkKind: chunk.specMetadata.kind,
			httpMethod: chunk.specMetadata.httpMethod ?? null,
			path: chunk.specMetadata.path ?? null,
			operationId: chunk.specMetadata.operationId ?? null,
			operationTags: chunk.specMetadata.operationTags ?? null,
		}));
		logger.info(
			`[AutoEmbed] OpenAPI spec detected — ${specChunks.length} endpoint/model chunks`,
		);
	} else {
		// Detect content type for optimal chunking
		const contentInfo = detectContentType(content);

		// Map database split method to chunking strategy
		// For markdown/code content, prefer DOCUMENT strategy regardless of settings
		let strategy = mapSplitMethodToStrategy(ragSettings.splitMethod ?? "");
		if (contentInfo.type === "markdown" || contentInfo.type === "code") {
			strategy = "DOCUMENT";
			logger.info(
				`[AutoEmbed] Using DOCUMENT strategy for ${contentInfo.type} content`,
			);
		}

		// Chunk the content
		chunks = chunkText(content, metadata?.filename || contextId, {
			strategy,
			chunkSize: ragSettings.chunkSize,
			chunkOverlap: ragSettings.chunkOverlap,
			contentType: contentInfo.type,
		});
	}
	const enrichedChunks = await enrichChunksWithTenantContext(chunks, {
		documentContent: content,
		documentTitle: metadata?.filename || contextId,
		userId,
		organizationId,
		projectId,
	});

	logger.info(
		`[AutoEmbed] Created ${enrichedChunks.length} chunks for context ${contextId}`,
	);

	if (owner.kind === "company") {
		return embedCompanyChunks(
			owner,
			options,
			enrichedChunks.map((chunk) => ({
				embedText: chunk.enrichedContent,
				content: chunk.originalContent,
				chunkIndex: chunk.index,
			})),
		);
	}

	// Normalize provider config
	const providerConfig = normalizeProviderConfig(apiKey ?? "");

	// Generate embeddings and store each chunk
	let firstQdrantId: string | undefined;
	let successCount = 0;
	const errors: string[] = [];

	for (const chunk of enrichedChunks) {
		try {
			const embeddingResult = await generateEmbedding(
				chunk.enrichedContent,
				{
					userId,
					organizationId,
					projectId,
					tags: [
						"project-context",
						type.toLowerCase(),
						`chunk-${chunk.index}`,
					],
				},
				providerConfig,
			);

			if (
				!embeddingResult ||
				!embeddingResult.embedding ||
				embeddingResult.embedding.length === 0
			) {
				logger.warn(
					`[AutoEmbed] Failed to generate embedding for chunk ${chunk.index}`,
				);
				errors.push(`Chunk ${chunk.index}: Empty embedding result`);
				continue;
			}

			// Use contextId-chunkIndex as unique ID for each chunk
			const chunkContextId =
				enrichedChunks.length > 1
					? `${contextId}-chunk-${chunk.index}`
					: contextId;

			// IMPORTANT: Always set originalContextId so filter-based deletion
			// can find and delete ALL chunks for a context (fixes orphaned chunk issue)
			const qdrantId = await storeProjectContext({
				contextId: chunkContextId,
				projectId: owner.projectId,
				userId,
				organizationId,
				content: chunk.originalContent,
				embedding: embeddingResult.embedding,
				metadata: {
					type: specRoute.kind === "openapi" ? "API_SPEC" : type,
					filename: metadata?.filename,
					sourceUrl: metadata?.sourceUrl,
					sourceTitle: metadata?.sourceTitle,
					provider: metadata?.provider,
					// Endpoint/model identity on spec chunks; empty otherwise.
					...(specPayloads[chunk.index] ?? {}),
					chunkIndex: chunk.index,
					totalChunks: enrichedChunks.length,
					headings: chunk.metadata.headings,
					section: chunk.metadata.section,
					// originalContextId enables filter-based deletion of all chunks
					originalContextId: contextId,
					// See the single-chunk path: a long captured conversation
					// chunks like anything else, and every one of its chunks has
					// to resolve back to the bundle row.
					conversationBundleId: metadata?.conversationBundleId,
					parentContextId: metadata?.parentContextId,
				},
			});

			if (!firstQdrantId) {
				firstQdrantId = qdrantId;
			}
			successCount++;
		} catch (error) {
			const errorMsg =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[AutoEmbed] Failed to embed chunk ${chunk.index}: ${errorMsg}`,
			);
			errors.push(`Chunk ${chunk.index}: ${errorMsg}`);
		}
	}

	if (successCount === 0) {
		const errorDetail = errors.length > 0 ? `: ${errors[0]}` : "";
		return {
			success: false,
			error: `Failed to embed any chunks${errorDetail}`,
		};
	}

	// Update database with embedding status (use first chunk's ID).
	// See `skipDbUpdate` doc in EmbedContextOptions.
	if (firstQdrantId && !skipDbUpdate) {
		await markContextAsEmbedded(contextId, firstQdrantId);
	}

	logger.info(
		`[AutoEmbed] Successfully embedded context ${contextId}: ${successCount}/${enrichedChunks.length} chunks`,
	);

	return {
		success: true,
		qdrantId: firstQdrantId,
		chunksCreated: successCount,
	};
}

/**
 * Re-embed a context after content update
 *
 * This removes the old embedding and creates a new one.
 *
 * @param options - Embed options with new content
 * @returns Embed result
 */
export async function reembedProjectContext(
	options: EmbedContextOptions,
): Promise<EmbedResult> {
	const { contextId, organizationId } = options;

	logger.info(`[AutoEmbed] Re-embedding context ${contextId}`);

	try {
		// Delete old embedding (ignore errors if it doesn't exist)
		try {
			await deleteProjectContext(contextId, organizationId);
		} catch {
			logger.debug(
				`[AutoEmbed] No existing embedding to delete for ${contextId}`,
			);
		}

		// Create new embedding
		return await embedProjectContext(options);
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : "Unknown error";
		logger.error(
			`[AutoEmbed] Failed to re-embed context ${contextId}: ${errorMessage}`,
		);

		return {
			success: false,
			error: errorMessage,
		};
	}
}

/**
 * Remove embedding for a deleted context
 *
 * @param contextId - ID of the deleted context
 * @param organizationId - Organization ID for routing to correct collection
 */
export async function removeContextEmbedding(
	contextId: string,
	organizationId?: string,
): Promise<void> {
	logger.info(`[AutoEmbed] Removing embedding for context ${contextId}`);

	try {
		await deleteProjectContext(contextId, organizationId);
		logger.info(`[AutoEmbed] Removed embedding for context ${contextId}`);
	} catch (error) {
		// Log but don't throw - context is already deleted
		logger.warn(
			`[AutoEmbed] Failed to remove embedding for ${contextId}: ${error}`,
		);
	}
}

/**
 * Batch embed multiple contexts
 *
 * @param contexts - Array of contexts to embed
 * @returns Array of embed results
 */
export async function batchEmbedContexts(
	contexts: EmbedContextOptions[],
): Promise<EmbedResult[]> {
	logger.info(`[AutoEmbed] Batch embedding ${contexts.length} contexts`);

	const results: EmbedResult[] = [];

	// Process in batches to avoid overwhelming the embedding API
	const batchSize = 5;

	for (let i = 0; i < contexts.length; i += batchSize) {
		const batch = contexts.slice(i, i + batchSize);

		const batchResults = await Promise.all(
			batch.map((ctx) => embedProjectContext(ctx)),
		);

		results.push(...batchResults);
	}

	const successCount = results.filter((r) => r.success).length;
	logger.info(
		`[AutoEmbed] Batch complete: ${successCount}/${contexts.length} succeeded`,
	);

	return results;
}
