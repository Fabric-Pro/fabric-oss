/**
 * Story vectors from the shared `StoryDuplicateEmbedding` cache, embedding
 * only what it does not cover.
 *
 * For the matchers that compare outside text against the backlog — meeting
 * action items, recurring errors — rather than stories against each other.
 * They read the duplicate scanner's cache and write their misses back to it,
 * so every feature warms the others instead of each paying to embed the
 * backlog. The duplicate scanner itself keeps its own loop: it defers the
 * write-back until it knows which of its pairs verified.
 *
 * A vector is reused only when its content hash and its embedding model both
 * match, so nothing is ever compared across two embedding models.
 */
import { resolveModelWithProvider } from "@repo/ai";
import {
	baseModelName,
	hashDetectionText,
	listStoryDuplicateEmbeddingMetadata,
	listStoryDuplicateEmbeddings,
	upsertStoryDuplicateEmbeddings,
} from "@repo/database";
import { logger } from "@repo/logs";
import { generateEmbeddings } from "@repo/rag";

export interface StoryVectorsParams {
	projectId: string;
	userId: string;
	organizationId: string | null;
	/** Each story's detection text (`detectionTextForStory`), never blank. */
	stories: ReadonlyArray<{ id: string; text: string }>;
	/** Background-job tag for the embedding's usage rows. */
	jobType?: NonNullable<Parameters<typeof generateEmbeddings>[1]>["jobType"];
	logPrefix: string;
}

export interface StoryVectors {
	/** Vector per story id. */
	vectors: Map<string, number[]>;
	/** How many of them this call embedded rather than read from the cache. */
	embedded: number;
}

/**
 * THROWS when the embedding model cannot be resolved or the embedding call
 * fails: no vectors is an environment problem, and the caller decides whether
 * that fails its run.
 */
export async function loadStoryVectors(
	params: StoryVectorsParams,
): Promise<StoryVectors> {
	const { projectId, userId, organizationId, stories, logPrefix } = params;
	const vectors = new Map<string, number[]>();
	if (stories.length === 0) {
		return { vectors, embedded: 0 };
	}

	let currentModel: string;
	try {
		const resolved = await resolveModelWithProvider("EMBEDDING", {
			userId,
			organizationId: organizationId ?? undefined,
		});
		currentModel = baseModelName(resolved.modelString);
	} catch (err) {
		logger.error(`${logPrefix} embedding model resolution failed`, {
			projectId,
			err: err instanceof Error ? err.message : String(err),
		});
		throw err;
	}

	const hashById = new Map(
		stories.map((s) => [s.id, hashDetectionText(s.text)]),
	);
	const cacheMeta = await listStoryDuplicateEmbeddingMetadata(projectId);
	const cacheMetaByStoryId = new Map(cacheMeta.map((r) => [r.storyId, r]));
	const staleStories = stories.filter((s) => {
		const cached = cacheMetaByStoryId.get(s.id);
		return (
			!cached ||
			cached.contentHash !== hashById.get(s.id) ||
			cached.model !== currentModel
		);
	});
	const staleIds = new Set(staleStories.map((s) => s.id));
	const wantedIds = new Set(stories.map((s) => s.id));

	if (staleIds.size < stories.length) {
		for (const row of await listStoryDuplicateEmbeddings(projectId)) {
			if (wantedIds.has(row.storyId) && !staleIds.has(row.storyId)) {
				vectors.set(row.storyId, row.embedding);
			}
		}
	}

	if (staleStories.length > 0) {
		const { embeddings, model } = await generateEmbeddings(
			staleStories.map((s) => s.text),
			{
				userId,
				organizationId: organizationId ?? undefined,
				projectId,
				featureKey: "knowledge-search",
				...(params.jobType ? { jobType: params.jobType } : {}),
			},
		);
		staleStories.forEach((s, i) => {
			vectors.set(s.id, embeddings[i]);
		});
		// Best-effort: a cache write failure must not fail a run whose
		// matching work already succeeded — the next run simply re-embeds.
		try {
			await upsertStoryDuplicateEmbeddings(
				projectId,
				staleStories.map((s, i) => ({
					storyId: s.id,
					contentHash: hashById.get(s.id) ?? "",
					model,
					embedding: embeddings[i],
				})),
			);
		} catch (err) {
			logger.warn(
				`${logPrefix} embedding cache write failed — continuing`,
				{
					projectId,
					rows: staleStories.length,
					err: err instanceof Error ? err.message : String(err),
				},
			);
		}
	}
	return { vectors, embedded: staleStories.length };
}
