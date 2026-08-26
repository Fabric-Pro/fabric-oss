import { createHash } from "node:crypto";
import { ORPCError } from "@orpc/client";
import { resolveModelWithProvider } from "@repo/ai";
import {
	baseModelName,
	cosineSimilarity,
	detectionTextForStory,
	getProjectTenantId,
	hashDetectionText,
	hasProjectAccess,
	listSearchableStories,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";
import { z } from "zod";
import { RATE_LIMIT_PRESETS } from "../../../../lib/rate-limit";
import {
	enforceAiRateLimit,
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Roadmap AI search (Fizzy #1937): rank the project's work items against a
 * natural-language query by EMBEDDING similarity rather than keyword presence.
 *
 * The interactive contract mirrors `scanDuplicatesProcedure`, minus the LLM
 * verifier:
 *   - tenant auth (STORY_READ + project access) — searching is a read;
 *   - the shared `StoryDuplicateEmbedding` cache is consulted via
 *     `detectionTextForStory` / `hashDetectionText`, so this feature never
 *     invalidates vectors computed for duplicate detection or action-item
 *     routing, and re-embeds only stories whose detection text changed;
 *   - stale embeddings are generated inline (capped per request — an oversized
 *     backlog degrades to partial coverage; the cap slices most-recently-
 *     updated first, and the overflow is reported in the response's
 *     `coverage.skipped` plus server logs, not surfaced as UI chrome);
 *   - the query itself rides in the SAME batched `generateEmbeddings` call, so
 *     a warm-cache search costs exactly one provider request;
 *   - results below the similarity floor are noise for text-embedding-class
 *     models and are dropped; what survives is capped and sorted descending;
 *   - scores are returned for ordering and server-side logging only — the UI
 *     deliberately does not render raw cosine values.
 */

/** Cosine floor for returning a match. Below ~0.25 on text-embedding-class
 * models the score is indistinguishable from unrelated content. */
const MIN_SIMILARITY = 0.25;
/** Hard cap on returned matches — a broad query over a large backlog should
 * surface the best 50, not drown the roadmap. */
const MAX_RESULTS = 50;
/** Cap on inline back-fill embedding per request, bounding latency: a cold
 * backlog warms across successive searches instead of blocking one. */
const MAX_INLINE_EMBEDS = 200;

const EMBEDDING_UNAVAILABLE_MESSAGE =
	"Could not generate embeddings. Ensure an embedding model is configured in Settings → AI Models.";

/**
 * Short-lived per-project vector corpus. Ranking compares the query against
 * EVERY story vector, so without this each request drags the project's whole
 * embedding column out of Postgres (~32 KB of JSON per 1536-dim row — about
 * 160 MB parsed per search on a 5k-story backlog), on every debounced
 * keystroke.
 *
 * Keyed by a fingerprint of what the staleness pass ALREADY computes — the
 * resolved model plus every story id and its CURRENT content hash — so any
 * text edit, added or removed story, or model switch misses the cache and
 * reloads; the TTL only bounds how long an unused project's vectors linger.
 * Serverless instances are reused across requests, which is what makes this
 * effective at all.
 */
const CORPUS_CACHE_TTL_MS = 30_000;
const CORPUS_CACHE_MAX_PROJECTS = 4;
const corpusCache = new Map<
	string,
	{ fingerprint: string; expiresAt: number; vectors: Map<string, number[]> }
>();

function loadCorpusFromCache(
	projectId: string,
	fingerprint: string,
): Map<string, number[]> | null {
	const hit = corpusCache.get(projectId);
	if (hit && hit.fingerprint === fingerprint && hit.expiresAt > Date.now()) {
		return hit.vectors;
	}
	return null;
}

function storeCorpusInCache(
	projectId: string,
	fingerprint: string,
	vectors: Map<string, number[]>,
): void {
	if (corpusCache.size >= CORPUS_CACHE_MAX_PROJECTS) {
		const now = Date.now();
		for (const [key, entry] of corpusCache) {
			if (entry.expiresAt <= now) {
				corpusCache.delete(key);
			}
		}
		while (corpusCache.size >= CORPUS_CACHE_MAX_PROJECTS) {
			const oldest = corpusCache.keys().next().value;
			if (oldest === undefined) break;
			corpusCache.delete(oldest);
		}
	}
	corpusCache.set(projectId, {
		fingerprint,
		expiresAt: Date.now() + CORPUS_CACHE_TTL_MS,
		vectors,
	});
}

export const semanticSearchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	// A search spends provider money (query embedding, plus up to
	// MAX_INLINE_EMBEDS back-fill texts on a cold backlog), and read-only
	// members can reach it — cap request rate per user like the other AI-cost
	// endpoints do.
	.use(async ({ context, next, path }) => {
		// A typing session legitimately produces one request per debounced
		// pause (each distinct query is its own cache key), so this surface
		// gets the wider aiSearch budget — a warm-path call embeds only the
		// query, far cheaper than the LLM calls the 20/min `ai` preset sizes.
		await enforceAiRateLimit(
			context.user.id,
			path,
			RATE_LIMIT_PRESETS.aiSearch,
		);
		return await next();
	})
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/semantic-search",
		tags: ["Projects", "Stories"],
		summary: "Semantic search over roadmap work items",
		description:
			"Rank the project's non-declined work items (including hidden/closed) against a natural-language query using embedding similarity. Reuses the shared story embedding cache; stale entries are re-embedded inline within a per-request cap.",
	})
	.input(
		z.object({
			projectId: z.string(),
			// `.trim()` runs BEFORE `min(1)`, so a whitespace-only query never
			// reaches the embedder.
			query: z.string().trim().min(1).max(512),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		// The tenant is derived from the ACCESS-CHECKED project row, never from
		// `input.organizationId`: that field arrives caller-controlled, and
		// model/credit resolution looks its tenant up by bare organization id —
		// trusting the input would let a caller spend another org's provider
		// key or quota. hasProjectAccess's third parameter is dead by design
		// (access is decided by ownership/membership rows alone), so passing
		// the input there guards nothing.
		const projectTenant = await getProjectTenantId(input.projectId);
		const canAccess =
			projectTenant !== null &&
			(await hasProjectAccess(input.projectId, user.id));
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}
		const organizationId = projectTenant?.organizationId ?? undefined;

		const query = input.query.trim();
		const stories = await listSearchableStories(input.projectId);
		const withText = stories
			.map((s) => ({ id: s.id, text: detectionTextForStory(s) }))
			.filter((s) => s.text.length > 0);

		let currentModel: string;
		try {
			const resolved = await resolveModelWithProvider("EMBEDDING", {
				userId: user.id,
				organizationId: organizationId ?? undefined,
			});
			currentModel = baseModelName(resolved.modelString);
		} catch (err) {
			logger.error(
				"[Semantic Search] embedding model resolution failed",
				{
					projectId: input.projectId,
					err: err instanceof Error ? err.message : String(err),
				},
			);
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: EMBEDDING_UNAVAILABLE_MESSAGE,
			});
		}

		// Staleness mirrors runDuplicateScanCore: a story needs re-embedding
		// when it has no cache row, its detection text changed, or the resolved
		// embedding model differs from the one the cached vector came from
		// (never cosine across vectors from different models).
		const currentHashById = new Map(
			withText.map((s) => [s.id, hashDetectionText(s.text)]),
		);
		const cacheMeta = await listStoryDuplicateEmbeddingMetadata(
			input.projectId,
		);
		const cacheMetaByStoryId = new Map(
			cacheMeta.map((r) => [r.storyId, r]),
		);
		const staleItems = withText.filter((s) => {
			const cached = cacheMetaByStoryId.get(s.id);
			return (
				!cached ||
				cached.contentHash !== currentHashById.get(s.id) ||
				cached.model !== currentModel
			);
		});
		const staleIdSet = new Set(staleItems.map((s) => s.id));
		const embedItems = staleItems.slice(0, MAX_INLINE_EMBEDS);
		const skippedStale = staleItems.length - embedItems.length;

		const embeddingByStoryId = new Map<string, number[]>();
		if (staleIdSet.size < withText.length) {
			const fingerprintParts = [...currentHashById.entries()]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([id, hash]) => `${id}:${hash}`);
			const fingerprint = createHash("sha256")
				.update(`${currentModel}|${fingerprintParts.join(",")}`)
				.digest("hex");
			let vectors = loadCorpusFromCache(input.projectId, fingerprint);
			if (!vectors) {
				vectors = new Map<string, number[]>();
				const cacheRows = await listStoryDuplicateEmbeddings(
					input.projectId,
				);
				for (const row of cacheRows) {
					// Load only NON-stale rows — a stale row's vector describes
					// the story's PREVIOUS text and would silently misrank it.
					if (!staleIdSet.has(row.storyId)) {
						vectors.set(row.storyId, row.embedding);
					}
				}
				storeCorpusInCache(input.projectId, fingerprint, vectors);
			}
			// Copy, never hand out the cached map: the caller mutates its view
			// with fresh vectors, and those must not leak into the cache ahead
			// of their upsert.
			for (const [storyId, vector] of vectors) {
				embeddingByStoryId.set(storyId, vector);
			}
		}

		// One batched provider request: the query first, then the stale story
		// texts behind it (positional indexing throughout).
		const texts = [query, ...embedItems.map((s) => s.text)];
		let embeddings: number[][];
		let model: string;
		try {
			const batch = await generateEmbeddings(texts, {
				userId: user.id,
				organizationId: organizationId ?? undefined,
				projectId: input.projectId,
			});
			embeddings = batch.embeddings;
			model = batch.model;
		} catch (err) {
			logger.error("[Semantic Search] embedding failed", {
				projectId: input.projectId,
				texts: texts.length,
				err: err instanceof Error ? err.message : String(err),
			});
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: EMBEDDING_UNAVAILABLE_MESSAGE,
			});
		}

		const queryVector = embeddings[0];
		if (queryVector && embedItems.length > 0) {
			const freshCacheRows = embedItems.map((s, i) => ({
				storyId: s.id,
				contentHash: currentHashById.get(s.id) ?? "",
				model,
				embedding: embeddings[i + 1],
			}));
			try {
				await upsertStoryDuplicateEmbeddings(
					input.projectId,
					freshCacheRows,
				);
			} catch (err) {
				// Cache write failure must not fail the search — the next one
				// simply re-embeds these items (same policy as the dup scan).
				logger.warn(
					"[Semantic Search] embedding cache write failed — continuing",
					{
						projectId: input.projectId,
						rows: freshCacheRows.length,
						err: err instanceof Error ? err.message : String(err),
					},
				);
			}
			embedItems.forEach((s, i) => {
				const vector = embeddings[i + 1];
				if (vector) {
					embeddingByStoryId.set(s.id, vector);
				}
			});
		}

		const scored: Array<{ storyId: string; score: number }> = [];
		if (queryVector) {
			for (const s of withText) {
				const vector = embeddingByStoryId.get(s.id);
				if (!vector) {
					continue;
				}
				const score = cosineSimilarity(queryVector, vector);
				if (score >= MIN_SIMILARITY) {
					scored.push({ storyId: s.id, score });
				}
			}
		}
		scored.sort(
			(a, b) => b.score - a.score || a.storyId.localeCompare(b.storyId),
		);

		logger.info("[Semantic Search] ranked project work items", {
			projectId: input.projectId,
			queryLength: query.length,
			totalSearchable: withText.length,
			freshlyEmbedded: embedItems.length,
			fromCache: withText.length - staleItems.length,
			skippedOverCap: skippedStale,
			matchesAboveFloor: scored.length,
			truncated: Math.max(0, scored.length - MAX_RESULTS),
			topScore: scored[0]?.score ?? null,
		});

		return {
			results: scored.slice(0, MAX_RESULTS),
			coverage: {
				total: withText.length,
				embedded: embedItems.length,
				cached: withText.length - staleItems.length,
				skipped: skippedStale,
			},
		};
	});
