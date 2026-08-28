/**
 * Project Context Retrieval with RAG Settings
 *
 * This module handles retrieving relevant project contexts for document generation
 * using the project's configured RAG settings (topK, similarity threshold, reranking, etc.)
 *
 * Security Model:
 * - Access is verified at the API layer via hasProjectAccess()
 * - Qdrant filtering uses projectId (not userId) since access was already verified
 * - For org projects: any org member with project access can retrieve
 * - For personal projects: only the owner can retrieve
 */

import {
	db,
	getProjectRagSettings,
	getRetrievableContextById,
	getRetrievableConversationBundleById,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbedding } from "../embedding";
import { generateSparseVector } from "../embedding/sparse";
import { rerankContexts } from "../reranking";
import type { RerankerProviderType } from "../reranking/types";
import { searchSimilarProjectContexts } from "./store";
import { applyContextSummary } from "./summary-injection";

/**
 * Default cap on the number of distinct documents returned when `diversify` is
 * enabled. Bounds the injected context (no token/perf blow-up) while ensuring
 * several distinct documents surface instead of a single one.
 */
const DEFAULT_DIVERSE_MAX_CONTEXTS = 8;

/**
 * When diversifying, fetch this many candidate chunks (a generous, bounded
 * pool) before dedup-by-`contextId`, so chunks from multiple distinct documents
 * are present even when one document contributes many chunks. Sized to see past
 * a long, multi-chunk document (e.g. a meeting transcript of tens of chunks). A
 * single document with more chunks than this would still dominate — which is no
 * worse than the non-diversified default.
 */
const DIVERSE_CANDIDATE_CHUNKS = 120;

export interface ProjectContextRetrievalOptions {
	projectId: string;
	query: string;
	userId: string;
	organizationId?: string;
	/** Override topK from RAG settings */
	topK?: number;
	/** Override similarity threshold from RAG settings */
	similarityThreshold?: number;
	/** Only search specific context IDs */
	contextIds?: string[];
	/**
	 * Diversify results across distinct documents (opt-in; default `false`).
	 *
	 * The default path asks the vector store for `topK` *chunks* and dedupes by
	 * `contextId` afterwards. When one document is split into many chunks it can
	 * occupy every one of those `topK` slots, so dedup collapses the result to
	 * that single document and other relevant documents never surface — e.g. a
	 * long meeting transcript crowding out a PRD on an agent query.
	 *
	 * When `true`, the chunk candidate pool is over-fetched so chunks from
	 * multiple documents are present, deduped to distinct documents, and the top
	 * `maxContexts` of them are returned. Opt-in, so every existing caller's
	 * behaviour is unchanged.
	 */
	diversify?: boolean;
	/**
	 * Maximum distinct documents to return when `diversify` is `true`. Ignored
	 * otherwise. Defaults to {@link DEFAULT_DIVERSE_MAX_CONTEXTS}.
	 */
	maxContexts?: number;
}

export interface RetrievedContext {
	id: string;
	type: string;
	content: string;
	score: number;
	metadata?: Record<string, unknown>;
	filename?: string;
	sourceUrl?: string;
	sourceTitle?: string;
	/**
	 * User-declared type label + AI guidance (Fizzy #1888). Present only
	 * when the source carries them, so every downstream formatter renders
	 * unannotated contexts exactly as before.
	 */
	sourceType?: string;
	aiInstructions?: string;
}

/**
 * Map a stored context to its effective source-type label for LLM awareness.
 * Integrations are stored with `type: "INTEGRATION"` and a provider in metadata;
 * we surface a provider-specific label (TEAMS_CHAT, SLACK_CHANNEL,
 * NOTION_DOCUMENT, CONFLUENCE_DOCUMENT) so the model knows the source. Provider
 * matching is exact (note Notion/Confluence are lowercase, matching the stored
 * `metadata.provider`).
 */
export function resolveEffectiveContextType(
	type: string,
	meta: Record<string, unknown> | null | undefined,
): string {
	if (meta?.provider === "CODE_ANALYSIS") {
		return "CODE_ANALYSIS";
	}
	if (type === "INTEGRATION") {
		switch (meta?.provider) {
			case "MICROSOFT_TEAMS":
				return "TEAMS_CHAT";
			case "SLACK":
				return "SLACK_CHANNEL";
			case "notion":
				return "NOTION_DOCUMENT";
			case "confluence":
				return "CONFLUENCE_DOCUMENT";
		}
	}
	return type;
}

/**
 * Retrieve relevant project contexts using configured RAG settings
 *
 * This is the main entry point for RAG retrieval in document generation.
 * It uses the project's RAG settings (if configured) or sensible defaults.
 *
 * @param options - Retrieval options
 * @returns Array of relevant contexts with their content
 */
export async function retrieveProjectContexts(
	options: ProjectContextRetrievalOptions,
): Promise<RetrievedContext[]> {
	const { projectId, query, userId, contextIds } = options;
	let organizationId = options.organizationId;

	logger.info(
		`[Retrieval] Starting context retrieval for project ${projectId}`,
	);

	try {
		// Resolve the tenant from the PROJECT when the caller didn't supply it
		// (e.g. the agent/orchestrator execution path can arrive with a null
		// organizationId). The project is the tenant boundary, so the embedding
		// provider must follow the project's org — otherwise resolution falls
		// back to the calling user's personal default provider (wrong tenant, and
		// possibly an unconfigured/expired provider). This is how org-project
		// RAG queries were silently dropping onto a personal Azure endpoint
		// instead of the org's configured embedding gateway.
		if (organizationId == null) {
			const project = await db.project.findUnique({
				where: { id: projectId },
				select: { organizationId: true },
			});
			organizationId = project?.organizationId ?? undefined;
		}

		// Every successful exit funnels through here: when Context Summarization
		// is on and a summary exists, the covered raw context is swapped for the
		// prepended summary block; otherwise the list passes through unchanged.
		const applySummary = (list: RetrievedContext[]) =>
			applyContextSummary(list, { projectId, userId, organizationId });

		// Get project's RAG settings (or defaults)
		const ragSettings = await getProjectRagSettings(projectId);

		// Use provided values or fall back to RAG settings
		const topK = options.topK ?? ragSettings.topK;
		const similarityThreshold =
			options.similarityThreshold ?? ragSettings.similarityThreshold;

		// Opt-in diversification (see ProjectContextRetrievalOptions.diversify):
		// over-fetch the chunk candidate pool so that, after dedup-by-contextId,
		// several distinct documents survive instead of one multi-chunk document
		// monopolising the top results. No effect when disabled (searchTopK == topK).
		const diversify = options.diversify === true;
		const maxContexts = options.maxContexts ?? DEFAULT_DIVERSE_MAX_CONTEXTS;
		const searchTopK = diversify
			? Math.max(topK, DIVERSE_CANDIDATE_CHUNKS)
			: topK;

		logger.info(
			`[Retrieval] Using settings: topK=${topK}, threshold=${similarityThreshold}${
				diversify
					? ` (diversify: candidateChunks=${searchTopK}, maxContexts=${maxContexts})`
					: ""
			}`,
		);

		// Generate embedding for the query
		const embeddingResult = await generateEmbedding(query, {
			userId,
			organizationId,
			projectId,
			tags: ["rag-query", "project-context"],
		});

		if (
			!embeddingResult ||
			!embeddingResult.embedding ||
			embeddingResult.embedding.length === 0
		) {
			logger.warn("[Retrieval] Failed to generate query embedding");
			return applySummary([]);
		}

		// Generate sparse vector for hybrid search
		const querySparseVector = generateSparseVector(query);

		// Search for similar contexts in Qdrant (hybrid: dense + sparse with RRF)
		// Note: We pass userId for logging but filtering is primarily by projectId
		// Access control is handled at the API layer
		const searchResults = await searchSimilarProjectContexts({
			projectId,
			userId,
			organizationId,
			queryEmbedding: embeddingResult.embedding,
			querySparseVector,
			topK: searchTopK,
			minSimilarity: similarityThreshold,
			contextIds,
		});

		if (searchResults.length === 0) {
			logger.info("[Retrieval] No similar contexts found");
			return applySummary([]);
		}

		logger.info(
			`[Retrieval] Found ${searchResults.length} similar contexts`,
		);

		// Deduplicate by contextId (multiple chunks from same context may appear)
		// while preserving Qdrant's relevance order, then fetch all rows in parallel.
		const orderedIds: string[] = [];
		const scoreById = new Map<string, number>();
		// Which of those ids belong to a captured conversation bundle rather
		// than to a context row. Carried from the point payload, because the id
		// alone cannot say which table holds it.
		const bundleIdById = new Map<string, string>();
		for (const result of searchResults) {
			if (scoreById.has(result.contextId)) {
				continue;
			}
			scoreById.set(result.contextId, result.score);
			if (result.conversationBundleId) {
				bundleIdById.set(result.contextId, result.conversationBundleId);
			}
			orderedIds.push(result.contextId);
		}

		// Vector store as an index of ids; the text always comes back from
		// Postgres. Three tables can hold it:
		//   - `ProjectContext` — the ordinary case.
		//   - `ProjectContextUrlPage` — per-page URL chunks are embedded with
		//     their own page id, which `getRetrievableContextById` falls back to.
		//   - `ProjectContextConversationBundle` — a monitored channel's captured
		//     messages (Fizzy #2228). The channel's own context row is a pointer
		//     with empty `content`, so resolving a bundle hit through the context
		//     path would return nothing to cite even when it "succeeded". Only
		//     the payload knows, hence the branch.
		const fetched = await Promise.all(
			orderedIds.map((id) => {
				const bundleId = bundleIdById.get(id);
				if (!bundleId) {
					return getRetrievableContextById(id);
				}
				return getRetrievableConversationBundleById({
					bundleId,
					projectId,
					tenant: { userId, organizationId },
				});
			}),
		);

		const contexts: RetrievedContext[] = [];
		for (let i = 0; i < orderedIds.length; i++) {
			const context = fetched[i];
			if (!context) {
				continue;
			}

			// Effective type labels for LLM awareness:
			// - Code analysis stored as TEXT → label as CODE_ANALYSIS
			// - Teams/Slack/Notion/Confluence integrations stored as INTEGRATION → label with provider
			const meta = context.metadata as Record<string, unknown> | null;
			const effectiveType = resolveEffectiveContextType(
				context.type,
				meta,
			);

			contexts.push({
				id: context.id,
				type: effectiveType,
				content: context.content,
				score: scoreById.get(orderedIds[i]) ?? 0,
				metadata: meta ?? undefined,
				filename: context.originalFilename || undefined,
				sourceUrl: context.sourceUrl || undefined,
				sourceTitle: context.sourceTitle || undefined,
				sourceType: context.sourceType ?? undefined,
				aiInstructions: context.aiInstructions ?? undefined,
			});
		}

		// Enrich code contexts with live repository role tags
		const enrichedContexts = await enrichContextsWithRoleTags(
			contexts,
			projectId,
		);

		// Diversified retrieval returns the top distinct documents directly — they
		// are already in hybrid-RRF relevance order, and the candidate over-fetch
		// + dedup above is what restored cross-document diversity. Reranking is
		// intentionally skipped on this path to keep the agent's hot path fast and
		// predictable (no extra rerank model call).
		if (diversify) {
			const diversified = enrichedContexts.slice(0, maxContexts);
			logger.info(
				`[Retrieval] Returning ${diversified.length} distinct contexts (diversified from ${enrichedContexts.length}) for project ${projectId}`,
			);
			return applySummary(diversified);
		}

		// Apply reranking if enabled in RAG settings
		if (ragSettings.enableReranking && enrichedContexts.length > 1) {
			// Use rerankTopK from settings (final count after reranking)
			// Fall back to 10 if not set (e.g., older settings without this field)
			const rerankTopK = (ragSettings as any).rerankTopK ?? 10;
			const rerankerProvider = (ragSettings as any).rerankerProvider as
				| RerankerProviderType
				| undefined;

			logger.info(
				`[Retrieval] Reranking ${enrichedContexts.length} contexts → top ${rerankTopK} with ${rerankerProvider || "cross-encoder"}`,
			);

			try {
				const { contexts: rerankedContexts, stats } =
					await rerankContexts({
						query,
						contexts: enrichedContexts,
						topK: rerankTopK,
						provider: rerankerProvider,
					});

				logger.info(
					`[Retrieval] Reranking complete: ${stats.inputCount} → ${stats.outputCount} in ${stats.latencyMs}ms (provider: ${stats.provider})`,
				);

				return applySummary(rerankedContexts);
			} catch (error) {
				logger.warn(
					`[Retrieval] Reranking failed, returning original results: ${error}`,
				);
				// Fall through to return original contexts
			}
		}

		logger.info(
			`[Retrieval] Returning ${enrichedContexts.length} contexts for project ${projectId}`,
		);

		return applySummary(enrichedContexts);
	} catch (error) {
		logger.error(`[Retrieval] Failed to retrieve contexts: ${error}`);
		throw new Error(
			`Failed to retrieve project contexts: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Format retrieved contexts for injection into LLM prompts
 *
 * @param contexts - Retrieved contexts
 * @returns Formatted string for prompt injection
 */
export function formatContextsForPrompt(contexts: RetrievedContext[]): string {
	if (contexts.length === 0) {
		return "";
	}
	const formattedContexts = contexts.map((ctx, index) => {
		const source =
			ctx.filename ||
			ctx.sourceTitle ||
			ctx.sourceUrl ||
			`Context ${index + 1}`;
		const roleTag = ctx.metadata?.roleTag as string | undefined;
		const tagPrefix = roleTag ? `${roleTag}: ` : "";
		// User-declared type label (Fizzy #1888) leads the parenthetical so
		// the model reads the source's ROLE before its system type. The
		// system type stays for downstream type-aware behaviour.
		const typePart = ctx.sourceType
			? `${ctx.sourceType}, ${ctx.type}`
			: ctx.type;
		// AI guidance renders as a quoted directive directly under the
		// header — adjacent to the content it governs, visually distinct
		// from it. Absent when unset, so headers stay byte-identical.
		const guidance = ctx.aiInstructions
			? `\n> Source guidance: ${ctx.aiInstructions}`
			: "";
		return `--- ${tagPrefix}${source} (${typePart}, relevance: ${(ctx.score * 100).toFixed(1)}%) ---${guidance}\n${ctx.content}`;
	});

	return `
<project_context>
The following context was retrieved from the project's knowledge base. Use this information to inform your response:

${formattedContexts.join("\n\n")}
</project_context>
`.trim();
}

/**
 * Per-item metadata header for callers that render retrieved contexts with
 * their own templates instead of {@link formatContextsForPrompt} (Fizzy
 * #1888) — direct-chat RAG, weave delegations, editor-side document
 * generation, unified search. Returns "" when the context carries no
 * label/guidance so those templates stay byte-identical for unannotated
 * sources.
 */
export function contextMetaHeader(ctx: {
	sourceType?: string | null;
	aiInstructions?: string | null;
	metadata?: Record<string, unknown> | null;
}): string {
	const role =
		typeof ctx.metadata?.roleTag === "string" &&
		ctx.metadata.roleTag.trim().length > 0
			? ctx.metadata.roleTag.trim()
			: null;

	const lines = [
		role ? `[Repository role: ${role}]` : null,
		ctx.sourceType ? `[Source type: ${ctx.sourceType}]` : null,
		ctx.aiInstructions ? `[Source guidance: ${ctx.aiInstructions}]` : null,
	].filter((line): line is string => line !== null);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export interface RoleTagMaps {
	byIntegrationId: Map<string, string>;
	byRepoKey: Map<string, string>;
}

/**
 * Resolve the role tag for a single chunk candidate from precomputed role tag maps.
 */
export function resolveRoleTag(
	maps: RoleTagMaps,
	target: {
		repositoryIntegrationId?: string | null;
		repo?: string | null;
	},
): string | undefined {
	if (target.repositoryIntegrationId) {
		const tag = maps.byIntegrationId.get(target.repositoryIntegrationId);
		if (tag) {
			return tag;
		}
	}
	if (target.repo) {
		return maps.byRepoKey.get(target.repo.toLowerCase());
	}
	return undefined;
}

/**
 * Fetch repository integrations for a project and build lookup maps for role tags.
 * Includes all connections regardless of temporary health status so attribution remains stable.
 */
export async function getProjectRoleTagMaps(
	projectId: string,
): Promise<RoleTagMaps> {
	const repoIntegrations = await db.projectRepositoryIntegration.findMany({
		where: { projectId },
		select: {
			id: true,
			repositoryOwner: true,
			repositoryName: true,
			roleTag: true,
		},
	});

	const byIntegrationId = new Map<string, string>();
	const byRepoKey = new Map<string, string>();
	for (const integ of repoIntegrations) {
		if (integ.roleTag) {
			byIntegrationId.set(integ.id, integ.roleTag);
			const repoKey = `${integ.repositoryOwner.toLowerCase()}/${integ.repositoryName.toLowerCase()}`;
			byRepoKey.set(repoKey, integ.roleTag);
		}
	}

	return { byIntegrationId, byRepoKey };
}

/**
 * Enrich retrieved contexts with live repository role tags (scoped by projectId).
 *
 * Live database lookup (byIntegrationId primary, byRepoKey fallback) takes
 * precedence over static metadata snapshots. Non-code searches skip DB lookups ($0 overhead).
 */
export async function enrichContextsWithRoleTags(
	contexts: RetrievedContext[],
	projectId: string,
): Promise<RetrievedContext[]> {
	if (contexts.length === 0) {
		return contexts;
	}

	// Defer querying repo integrations until we confirm candidate chunks include code resources.
	// NON-code searches (PRDs, transcripts, notes) skip this query to avoid unnecessary DB lookups.
	const hasCodeContexts = contexts.some((ctx) => {
		const meta = ctx.metadata as Record<string, unknown> | null;
		return (
			ctx.type === "CODE_FILE" ||
			ctx.type === "CODE_FILE_SUMMARY" ||
			meta?.provider === "CODE_ANALYSIS" ||
			Boolean(meta?.repositoryIntegrationId || meta?.repo)
		);
	});

	if (!hasCodeContexts) {
		return contexts;
	}

	const roleTagMaps = await getProjectRoleTagMaps(projectId);

	return contexts.map((ctx) => {
		const meta = (ctx.metadata as Record<string, unknown> | null) ?? {};
		const resolvedRoleTag = resolveRoleTag(roleTagMaps, {
			repositoryIntegrationId: meta.repositoryIntegrationId as
				| string
				| undefined,
			repo: meta.repo as string | undefined,
		});

		if (!resolvedRoleTag) {
			return ctx;
		}

		return {
			...ctx,
			metadata: {
				...meta,
				roleTag: resolvedRoleTag,
			},
		};
	});
}
