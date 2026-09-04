/**
 * Retrieve recent project contexts relevant to a specification document.
 *
 * Multi-query RAG: chunks the spec, embeds every chunk, fans out a vector
 * search per chunk, then merges results with Reciprocal Rank Fusion (RRF).
 * This gives topic-focused recall across a long spec — a single embedding of
 * the whole doc dilutes specificity.
 *
 * Used by the "Update using context" flow (stories + documents). Replaces
 * the earlier firehose approach that loaded up to 20 full transcripts into
 * the prompt and took ~2 minutes per call.
 */

import { getRAGProviderConfig } from "@repo/ai";
import {
	fetchCredentialsByIdInTenant,
	getRetrievableContextById,
	loadProjectDatabricksKnowledgeBinding,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isProjectDatabricksKnowledgeEnabled } from "@repo/utils/feature-flag";
import { chunkText } from "../chunking";
import { generateEmbeddings } from "../embedding";
import { generateSparseVector } from "../embedding/sparse";
import type { RetrievedContext } from "./retrieval";
import { searchSimilarProjectContexts } from "./store";
import { applyContextSummary } from "./summary-injection";

export interface RetrieveForSpecOptions {
	projectId: string;
	userId: string;
	organizationId?: string;
	/** The spec / feature doc the AI will be updating. Chunked into queries. */
	specMarkdown: string;
	/** Only contexts with createdAt >= baselineDate are returned. */
	baselineDate: Date;
	/** Max final chunks to return after fusion + filter. */
	topK?: number;
	/** Max spec chunks used as queries (caps embedding + search fan-out). */
	maxQueryChunks?: number;
	/** Per-query Qdrant hits before RRF merge. */
	perQueryTopK?: number;
	/** Minimum cosine similarity per query. */
	minSimilarity?: number;
	/**
	 * Exclude ProjectDocument-derived points from retrieval. Set by the Living
	 * Documents auto-refresh sweep so an unattended cycle only ever reads source
	 * artifacts — transcripts, features, code, human-authored contexts, chat —
	 * and never a document a previous cycle wrote. Defaults off: the interactive
	 * "Update using context" path is unchanged.
	 */
	excludeDocumentChunks?: boolean;
	/**
	 * Throw when retrieval cannot RUN (no embedding provider, embeddings came back
	 * empty) instead of degrading to an empty result.
	 *
	 * Degrading is right for a human: they see "no relevant context" and move on.
	 * It is wrong for an unattended, scheduled job, which cannot tell "this project
	 * has no context" from "the embedding service is down" — and would record the
	 * outage as a completed no-change cycle, advancing the cadence clock and
	 * silencing the document for a fortnight.
	 *
	 * Defaults off, so every existing caller keeps its current behavior.
	 */
	throwOnRetrievalError?: boolean;
}

/**
 * Retrieval could not run — the embedding provider is missing or the embedding
 * service returned nothing. Distinct from "retrieval ran and found nothing",
 * which is an ordinary empty result.
 */
export class RetrievalUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RetrievalUnavailableError";
	}
}

/**
 * RRF constant — 60 is the conventional value from the original paper and
 * what Qdrant uses internally for hybrid fusion. Keep the same here so
 * downstream reranking behaves consistently.
 */
const RRF_K = 60;

/**
 * Per-context content cap. Qdrant search matches at the chunk level, but the
 * chunk text is NOT stored in the Qdrant payload (it only feeds the sparse
 * vector — see `buildProjectPointVector` in store.ts). So when we fetch the
 * matched context from Postgres we get the ENTIRE source document. Without
 * this cap, one matched chunk in a long transcript would inject the whole
 * transcript into the LLM prompt, defeating the point of RAG.
 *
 * Long-term fix: store chunk text in the Qdrant payload and surface it via
 * `searchSimilarProjectContexts`. Until then, truncate here.
 */
const MAX_CONTEXT_CONTENT_CHARS = 3000;

/**
 * Synthetic type for Databricks Vector Search hits. Distinct from every
 * internal `ProjectContext.type` so downstream labeling can present this
 * material honestly as an external, undated corpus — never as an internal
 * Fabric artifact ("Project Document"), which the spec-editor prompt ranks
 * above other sources.
 */
export const EXTERNAL_INDEX_CONTEXT_TYPE = "EXTERNAL_INDEX";

/**
 * Fan-out cap for the Databricks branch: query only the FIRST N spec chunks
 * (leading chunks carry the title/overview and are the most representative)
 * instead of one remote call per spec chunk. Without this, a single
 * invocation could issue up to maxQueryChunks (12) × MAX_QUERY_INDEXES (16)
 * remote searches.
 */
const MAX_DATABRICKS_QUERY_CHUNKS = 3;

/** Per-query result count for the Databricks branch (mirrors perQueryTopK). */
const DATABRICKS_PER_QUERY_RESULTS = 8;

/**
 * Rank-based cut: keep only the best N hits of each sub-query's result page.
 * This is the PRIMARY per-query relevance guard. Databricks has no relevance
 * floor of any kind (it always returns `num_results` rows), and its HYBRID
 * search returns RRF-fused scores that cluster tightly (rank 1 ≈ 0.033,
 * rank 8 ≈ 0.028), so score-ratio thresholds barely discriminate — rank is
 * the signal that survives that scale.
 */
const DATABRICKS_PER_QUERY_KEEP = 4;

/**
 * Relative relevance floor — DEFENSE-IN-DEPTH ONLY, not a primary guard.
 * Against the production HYBRID path's tightly-clustered RRF-fused scores a
 * 0.5× cut essentially never fires; the rank cut above and the per-source
 * quota below do the real anti-boilerplate work. The floor still catches
 * degenerate spreads on score scales where ratios ARE meaningful (e.g. a
 * workspace/index configuration returning raw similarity scores). Relative,
 * not absolute — raw scores are not comparable across embedding models.
 * Non-positive and non-finite scores are dropped outright before either
 * guard: they carry no relevance signal at all.
 */
const DATABRICKS_RELATIVE_SCORE_FLOOR = 0.5;

/**
 * Cap on the Databricks share of the final merged topK (per-source quota).
 * RRF is rank-based: a generic boilerplate chunk recurring across several
 * sub-queries accumulates one contribution PER query and can out-rank a
 * strong Qdrant hit that matched once. The quota bounds the damage: external
 * hits compete on score for at most ⌊topK/3⌋ slots.
 */
const DATABRICKS_SHARE_DIVISOR = 3;

/**
 * Wall-clock budget for the whole Databricks branch. A slow or unresponsive
 * customer workspace must not stall "Update using context" — this flow
 * already has a documented history of ~100s latency without such a bound.
 */
const DATABRICKS_BRANCH_TIMEOUT_MS = 15_000;

interface DatabricksBranchResult {
	/** Quota-capped, RRF-scored external contexts, ready to merge. */
	results: RetrievedContext[];
	/** True when the project has an enabled binding we tried to query. */
	attempted: boolean;
	/**
	 * True when the whole source failed: credentials resolved to null, every
	 * sub-query rejected, or the branch timed out. Feeds the
	 * `throwOnRetrievalError` whole-source-outage check.
	 */
	allFailed: boolean;
}

const EMPTY_DATABRICKS_RESULT: DatabricksBranchResult = {
	results: [],
	attempted: false,
	allFailed: false,
};

/**
 * Query the project's bound Databricks Vector Search indexes with the
 * leading spec chunks and fold the hits into RRF space.
 *
 * Keys are namespaced (`databricks:{integrationId}:{indexName}:{id}`) —
 * Databricks ids are each index's own primary-key values (often small
 * integers) which can collide across indexes and, worse, with a real
 * `ProjectContext.id` that would then be hydrated from Postgres incorrectly.
 *
 * The `@repo/integrations/databricks-vector-search` import is dynamic on
 * purpose: it drags in `@repo/databricks`'s CJS/tsx interop workaround,
 * which must stay out of `@repo/rag`'s static import graph (it feeds the
 * Next.js server bundle).
 */
async function retrieveDatabricksContexts(options: {
	projectId: string;
	userId: string;
	organizationId?: string;
	queryTexts: string[];
	topK: number;
	/**
	 * Owned by the CALLER (retrieveRelevantContextsForSpec), which aborts it
	 * on every exit path — including early returns/throws that happen while
	 * this branch is still in flight (e.g. embedding failure) — so the
	 * underlying Databricks HTTP requests never keep running server-side
	 * after the caller has already responded. The branch's own wall-clock
	 * timer below aborts the same controller.
	 */
	abortController: AbortController;
}): Promise<DatabricksBranchResult> {
	const {
		projectId,
		userId,
		organizationId,
		queryTexts,
		topK,
		abortController,
	} = options;

	// Per-source quota: Databricks competes for at most ⌊topK/3⌋ of the
	// final slots, ranked by its own RRF score. Honored EXACTLY — at
	// topK 1–2 the quota is 0, no external hit could ever enter the list,
	// so the branch (binding load included) is skipped outright.
	const quota = Math.floor(topK / DATABRICKS_SHARE_DIVISOR);
	if (quota <= 0) {
		return EMPTY_DATABRICKS_RESULT;
	}

	const binding = await loadProjectDatabricksKnowledgeBinding({
		projectId,
		userId,
		organizationId,
	});
	if (!binding) {
		return EMPTY_DATABRICKS_RESULT;
	}

	const run = async (
		signal: AbortSignal,
	): Promise<DatabricksBranchResult> => {
		// Credentials resolve against the CALLER's tenant on every call. A
		// project-scoped guest or cross-tenant caller gets null — a silent
		// no-op, not a fallback to the project owner's tenant (which would
		// turn a project share into a grant on the org's whole corpus).
		const credentials = await fetchCredentialsByIdInTenant(
			binding.integrationId,
			userId,
			organizationId,
		);
		if (!credentials) {
			logger.warn(
				`[SpecRetrieval] Databricks binding present but credentials unavailable for project ${projectId}`,
			);
			return { results: [], attempted: true, allFailed: true };
		}

		const { queryDatabricksVectorIndexes } = await import(
			"@repo/integrations/databricks-vector-search"
		);

		const queries = queryTexts.slice(0, MAX_DATABRICKS_QUERY_CHUNKS);
		const settled = await Promise.allSettled(
			queries.map((query) =>
				queryDatabricksVectorIndexes(credentials, {
					indexNames: binding.indexNames,
					query,
					numResults: DATABRICKS_PER_QUERY_RESULTS,
					signal,
				}),
			),
		);

		const rrfScores = new Map<string, number>();
		const hitsByKey = new Map<
			string,
			{ indexName: string; externalId: string; content: string }
		>();
		const failures = new Set<string>();
		const skippedIndexes = new Set<string>();
		let succeeded = 0;
		for (const result of settled) {
			if (result.status !== "fulfilled") {
				logger.warn(
					`[SpecRetrieval] Databricks sub-query failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
				);
				continue;
			}
			succeeded++;
			for (const failure of result.value.failures) {
				failures.add(failure);
			}
			for (const skipped of result.value.skippedIndexes) {
				skippedIndexes.add(skipped);
			}
			// Drop score-less garbage outright, then apply the rank cut
			// (primary guard) and the relative floor (defense-in-depth) —
			// see the constant docs above. Hits arrive sorted by score desc.
			const hits = result.value.chunks.filter(
				(hit) => Number.isFinite(hit.score) && hit.score > 0,
			);
			const kept = hits.slice(0, DATABRICKS_PER_QUERY_KEEP);
			const topScore = kept[0]?.score ?? 0;
			const floored = kept.filter(
				(hit) =>
					hit.score >= topScore * DATABRICKS_RELATIVE_SCORE_FLOOR,
			);
			floored.forEach((hit, rank) => {
				const key = `databricks:${binding.integrationId}:${hit.indexName}:${hit.id}`;
				rrfScores.set(
					key,
					(rrfScores.get(key) ?? 0) + 1 / (RRF_K + rank),
				);
				if (!hitsByKey.has(key)) {
					hitsByKey.set(key, {
						indexName: hit.indexName,
						externalId: hit.id,
						content: hit.content,
					});
				}
			});
		}

		// Partial degradation is invisible to the end user on this path (the
		// tool-calling path surfaces these in its summary) — log it so a
		// half-broken binding is diagnosable.
		if (failures.size > 0) {
			logger.warn(
				`[SpecRetrieval] Databricks per-index failures for project ${projectId}: ${[...failures].join("; ")}`,
			);
		}
		if (skippedIndexes.size > 0) {
			logger.warn(
				`[SpecRetrieval] Databricks indexes beyond the query limit were not searched for project ${projectId}: ${[...skippedIndexes].join(", ")}`,
			);
		}

		if (succeeded === 0) {
			return { results: [], attempted: true, allFailed: true };
		}

		const results: RetrievedContext[] = [...rrfScores.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, quota)
			.map(([key, score]) => {
				const hit = hitsByKey.get(key);
				const content = hit?.content ?? "";
				return {
					id: key,
					type: EXTERNAL_INDEX_CONTEXT_TYPE,
					// Same content budget as the Postgres branch — an index
					// can return an entire unchunked document in `content`.
					content:
						content.length > MAX_CONTEXT_CONTENT_CHARS
							? `${content.slice(0, MAX_CONTEXT_CONTENT_CHARS)}...`
							: content,
					score,
					metadata: {
						isExternalIndex: true,
						integrationId: binding.integrationId,
						indexName: hit?.indexName,
						externalId: hit?.externalId,
					},
					sourceTitle: `Databricks: ${hit?.indexName ?? "vector index"}`,
				};
			});

		return { results, attempted: true, allFailed: false };
	};

	// Wall-clock budget with REAL cancellation: when the timer fires, the
	// AbortController tears down the underlying Databricks HTTP requests
	// (search POSTs, backoff waits, this caller's token/metadata waits) —
	// not just this caller's promise. Without the abort, repeated
	// slow-workspace calls would accumulate orphaned in-flight requests.
	const timeoutSentinel = Symbol("databricks-timeout");
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof timeoutSentinel>((resolve) => {
		timer = setTimeout(() => {
			abortController.abort(
				new Error(
					`Databricks branch timed out after ${DATABRICKS_BRANCH_TIMEOUT_MS}ms`,
				),
			);
			resolve(timeoutSentinel);
		}, DATABRICKS_BRANCH_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		const raced = await Promise.race([
			run(abortController.signal),
			timeout,
		]);
		if (raced === timeoutSentinel) {
			logger.warn(
				`[SpecRetrieval] Databricks branch timed out after ${DATABRICKS_BRANCH_TIMEOUT_MS}ms for project ${projectId}`,
			);
			return { results: [], attempted: true, allFailed: true };
		}
		return raced;
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export async function retrieveRelevantContextsForSpec(
	options: RetrieveForSpecOptions,
): Promise<RetrievedContext[]> {
	const {
		projectId,
		userId,
		organizationId,
		specMarkdown,
		baselineDate,
		topK: rawTopK = 15,
		maxQueryChunks = 12,
		perQueryTopK = 8,
		minSimilarity = 0.3,
		excludeDocumentChunks = false,
		throwOnRetrievalError = false,
	} = options;
	// Defensive normalization: `topK` reaches this function from a public API
	// surface (v1 knowledge search validates too, but this function must not
	// rely on every caller doing so) — a non-finite or non-positive value
	// would distort the slice/quota math downstream.
	const topK =
		Number.isFinite(rawTopK) && rawTopK >= 1 ? Math.floor(rawTopK) : 15;

	// Every exit funnels through here so the compressed project-history summary
	// is offered as background alongside the recent-since-baseline deltas (when
	// the flag is on and a summary exists). Pass-through otherwise.
	const applySummary = (list: RetrievedContext[]) =>
		applyContextSummary(list, { projectId, userId, organizationId });

	const trimmedSpec = specMarkdown.trim();
	if (!trimmedSpec) {
		return applySummary([]);
	}

	// TENANT entry point, deliberately, for a helper that genuinely serves both
	// sides: an oRPC procedure and the v1 REST route call it with a person
	// waiting, and `update-with-context-core` calls it from a workflow. The
	// human/unattended split is already carried by `throwOnRetrievalError`
	// below rather than by which key is resolved, and a keyless tenant should
	// see "no context found" here, not context retrieved on the platform's key.
	let providerConfig: Awaited<ReturnType<typeof getRAGProviderConfig>>;
	try {
		providerConfig = await getRAGProviderConfig({ userId, organizationId });
	} catch (error) {
		logger.warn(
			`[SpecRetrieval] No embedding provider for project ${projectId}: ${error instanceof Error ? error.message : error}`,
		);
		// Retrieval could not RUN. For a human that degrades to "no context found";
		// for an unattended job it must be an error, or the outage is recorded as a
		// completed no-change cycle.
		if (throwOnRetrievalError) {
			throw new RetrievalUnavailableError(
				`No embedding provider for project ${projectId}`,
			);
		}
		return applySummary([]);
	}

	// Chunk the spec using the document-aware strategy so markdown headings
	// produce topic-focused queries instead of mid-sentence splits.
	const chunks = chunkText(trimmedSpec, "spec.md", {
		strategy: "DOCUMENT",
		chunkSize: 1024,
		chunkOverlap: 100,
	}).slice(0, maxQueryChunks);
	if (chunks.length === 0) {
		return applySummary([]);
	}

	const queryTexts = chunks.map((c) => c.content);

	// Databricks branch — runs in parallel with embedding + Qdrant fan-out.
	//
	// Gates, in order:
	// 1. Kill switch: flag off ⇒ retrieval is byte-for-byte unchanged for
	//    every bound project (the only rollback lever once this ships).
	// 2. `excludeDocumentChunks` (the unattended Living Documents sweep) ⇒
	//    skipped ENTIRELY. Databricks hits carry no timestamp, so they can't
	//    honor the sweep's baseline/source-only contract — and nothing stops
	//    a customer's index from containing Fabric-exported documents, which
	//    would reopen exactly the feedback loop that option exists to prevent.
	const databricksEnabled =
		!excludeDocumentChunks && isProjectDatabricksKnowledgeEnabled();
	// Owned here, aborted in the `finally` below on EVERY exit path — an
	// early return/throw (e.g. embedding failure) must tear down the branch's
	// in-flight Databricks HTTP requests, not leave them running server-side
	// for up to the branch timeout after the caller already got its answer.
	const databricksAbort = new AbortController();
	const databricksPromise: Promise<DatabricksBranchResult> = databricksEnabled
		? retrieveDatabricksContexts({
				projectId,
				userId,
				organizationId,
				queryTexts,
				topK,
				abortController: databricksAbort,
			}).catch((error) => {
				logger.warn(
					`[SpecRetrieval] Databricks branch failed: ${error instanceof Error ? error.message : error}`,
				);
				// Unknown failure before/while querying — treat as a
				// whole-source outage so `throwOnRetrievalError` callers can
				// tell it apart from "no relevant external context".
				return { results: [], attempted: true, allFailed: true };
			})
		: Promise.resolve(EMPTY_DATABRICKS_RESULT);

	try {
		const embeddingResult = await generateEmbeddings(
			queryTexts,
			{
				userId,
				organizationId,
				projectId,
				tags: ["rag-query", "spec-update"],
			},
			providerConfig,
		);
		const embeddings = embeddingResult.embeddings ?? [];
		if (embeddings.length === 0) {
			logger.warn(
				"[SpecRetrieval] Batch embedding returned empty result",
			);
			if (throwOnRetrievalError) {
				throw new RetrievalUnavailableError(
					`Embedding service returned no vectors for project ${projectId}`,
				);
			}
			return applySummary([]);
		}

		// Fan out searches in parallel, one per spec chunk. Each search returns
		// its own ranked list; we RRF-merge them below.
		const searches = await Promise.allSettled(
			embeddings.map((emb, i) =>
				searchSimilarProjectContexts({
					projectId,
					userId,
					organizationId,
					queryEmbedding: emb,
					querySparseVector: generateSparseVector(
						queryTexts[i] ?? "",
					),
					topK: perQueryTopK,
					minSimilarity,
					excludeDocumentChunks,
				}),
			),
		);

		const rrfScores = new Map<string, number>();
		// Track the best-scoring matched chunk text per contextId so the final
		// result can return the actual relevant passage (not the leading 3 KB of
		// the parent document). Only populated for chunks whose Qdrant payload
		// carries `content` (points stored after storeProjectContext started
		// including it). Legacy points fall through to the Postgres truncation.
		const bestChunkByContext = new Map<
			string,
			{ content: string; score: number }
		>();
		for (const result of searches) {
			if (result.status !== "fulfilled") {
				logger.warn(
					`[SpecRetrieval] Sub-search failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`,
				);
				continue;
			}
			result.value.forEach((hit, rank) => {
				const prev = rrfScores.get(hit.contextId) ?? 0;
				rrfScores.set(hit.contextId, prev + 1 / (RRF_K + rank));
				if (hit.content) {
					const prevBest = bestChunkByContext.get(hit.contextId);
					if (!prevBest || hit.score > prevBest.score) {
						bestChunkByContext.set(hit.contextId, {
							content: hit.content,
							score: hit.score,
						});
					}
				}
			});
		}

		// Await the external branch before assembling results. Sources are
		// PARTITIONED before hydration: the Postgres hydration loop below relies
		// on positional alignment between `rankedContextIds[i]` and `fetched[i]`,
		// so Databricks entries (which have no Postgres row) never enter it —
		// they were populated directly from the search response.
		const databricks = await databricksPromise;
		if (
			throwOnRetrievalError &&
			databricks.attempted &&
			databricks.allFailed
		) {
			// A failed Qdrant sub-query is 1 of ~12 and degrades gracefully; a
			// Databricks credential/host failure fails identically across every
			// query for the binding — the whole-source-outage case this flag
			// exists to catch. Best-effort degrade remains correct for
			// interactive callers (flag off).
			throw new RetrievalUnavailableError(
				`Databricks knowledge source unavailable for project ${projectId}`,
			);
		}

		if (rrfScores.size === 0 && databricks.results.length === 0) {
			return applySummary([]);
		}

		const results: RetrievedContext[] = [];
		if (rrfScores.size > 0) {
			// Fetch the top-N × 3 before filtering so baseline-date filtering can't
			// starve the final list when many recent contexts rank mid-pack.
			const rankedContextIds = [...rrfScores.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, topK * 3)
				.map(([contextId]) => contextId);

			// Use `getRetrievableContextById` (not `getContextById`) so URL-page
			// chunks resolve. Per-page chunks are embedded with their own
			// `ProjectContextUrlPage.id` as the Qdrant `contextId`; the helper
			// falls back to that table when the id isn't a `ProjectContext`.
			const fetched = await Promise.all(
				rankedContextIds.map((id) => getRetrievableContextById(id)),
			);

			for (let i = 0; i < fetched.length; i++) {
				const ctx = fetched[i];
				if (!ctx) {
					continue;
				}
				if (ctx.createdAt < baselineDate) {
					continue;
				}
				// Skip integration pointer rows — those are fetched live by
				// fetchLiveIntegrationContext and have empty content here.
				if (ctx.type === "INTEGRATION") {
					continue;
				}

				const meta = ctx.metadata as Record<string, unknown> | null;
				// Prefer the matched chunk text when the Qdrant payload carried it.
				// Falls back to leading-N chars of the parent document for legacy
				// points (pre-dating the payload change) — imperfect but bounded.
				const matchedChunk = bestChunkByContext.get(ctx.id)?.content;
				const content =
					matchedChunk ??
					(ctx.content.length > MAX_CONTEXT_CONTENT_CHARS
						? `${ctx.content.slice(0, MAX_CONTEXT_CONTENT_CHARS)}...`
						: ctx.content);
				results.push({
					id: ctx.id,
					type: ctx.type,
					content,
					score: rrfScores.get(rankedContextIds[i]) ?? 0,
					metadata: meta ?? undefined,
					filename: ctx.originalFilename || undefined,
					sourceUrl: ctx.sourceUrl || undefined,
					sourceTitle: ctx.sourceTitle || undefined,
					sourceType: ctx.sourceType ?? undefined,
					aiInstructions: ctx.aiInstructions ?? undefined,
				});

				if (results.length >= topK) {
					break;
				}
			}
		}

		// Merge the two sources by RRF score. The Databricks list is already
		// quota-capped (⌊topK/3⌋), so external hits can displace at most that
		// many internal ones — and only when they out-score them.
		const merged =
			databricks.results.length > 0
				? [...results, ...databricks.results]
						.sort((a, b) => b.score - a.score)
						.slice(0, topK)
				: results;

		logger.info(
			`[SpecRetrieval] project=${projectId} spec_chunks=${chunks.length} candidates=${rrfScores.size} databricks=${databricks.results.length} returned=${merged.length}`,
		);

		return applySummary(merged);
	} finally {
		// Every exit — the normal merge, an early return, or a throw — tears
		// down whatever the Databricks branch still has in flight. After the
		// branch has been awaited and settled this is a no-op.
		databricksAbort.abort(new Error("spec retrieval finished"));
	}
}
