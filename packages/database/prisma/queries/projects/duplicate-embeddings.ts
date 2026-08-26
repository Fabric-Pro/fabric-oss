/**
 * Database queries for the incremental duplicate-scan embedding cache.
 *
 * `StoryDuplicateEmbedding` stores one cached title+description vector per story,
 * tagged with the content hash and embedding model it was produced with. The
 * manual scan reads the cache, re-embeds only stories whose detection text or
 * embedding model changed, reuses the cached vectors for the rest, and writes
 * the freshly-embedded rows back.
 *
 * Tenant isolation: like the sibling duplicate-link helpers, these are always
 * reached through a procedure that has already validated project access, and
 * every query is scoped by `projectId` (no direct row-level security on story
 * child-tables).
 */

import { randomUUID } from "node:crypto";
import { db } from "../../client";

/** A cached embedding row in the shape the scan consumes (embedding decoded to
 * a number[] from its stored JSON). */
export type CachedStoryEmbedding = {
	storyId: string;
	contentHash: string;
	model: string;
	embedding: number[];
};

/** The staleness-check projection of a cache row — everything except the
 * vector itself. */
export type CachedStoryEmbeddingMetadata = Omit<
	CachedStoryEmbedding,
	"embedding"
>;

/** Cache metadata only (storyId + contentHash + model — NO vectors) for a
 * project. The scan computes staleness from this cheap projection first; the
 * heavy `embedding` JSON columns are only loaded (via
 * {@link listStoryDuplicateEmbeddings}) when at least one story actually needs
 * re-comparison, so a no-change re-scan never pulls the vectors at all. */
export async function listStoryDuplicateEmbeddingMetadata(
	projectId: string,
): Promise<CachedStoryEmbeddingMetadata[]> {
	return db.storyDuplicateEmbedding.findMany({
		where: { projectId },
		select: {
			storyId: true,
			contentHash: true,
			model: true,
		},
	});
}

/** All cached embeddings for a project, vectors included. The `embedding` JSON
 * column is decoded to `number[]` for cosine comparison; rows for stories no
 * longer active are simply never matched against the current active set and
 * left untouched. */
export async function listStoryDuplicateEmbeddings(
	projectId: string,
): Promise<CachedStoryEmbedding[]> {
	const rows = await db.storyDuplicateEmbedding.findMany({
		where: { projectId },
		select: {
			storyId: true,
			contentHash: true,
			model: true,
			embedding: true,
		},
	});
	return rows.map((row) => ({
		storyId: row.storyId,
		contentHash: row.contentHash,
		model: row.model,
		embedding: row.embedding as number[],
	}));
}

/** Upsert the freshly-embedded rows (keyed by the unique `storyId`) as ONE
 * set-based statement so the cache for a scan's stale set lands atomically
 * AND in a single round trip — the per-row upsert transaction this replaced
 * cost one database round trip per row (~2s for a 200-row backfill on a
 * remote Postgres). Only called for stories that were actually re-embedded
 * this run; a no-op for an empty set. */
export async function upsertStoryDuplicateEmbeddings(
	projectId: string,
	rows: CachedStoryEmbedding[],
): Promise<void> {
	if (rows.length === 0) {
		return;
	}
	const payload = JSON.stringify(
		rows.map((row) => ({
			id: randomUUID(),
			storyId: row.storyId,
			contentHash: row.contentHash,
			model: row.model,
			// Embedding travels as a JSON TEXT and is cast to jsonb in the
			// statement — jsonb_to_recordset can't decode a nested array
			// field directly.
			embedding: JSON.stringify(row.embedding),
		})),
	);
	await db.$executeRaw`
		INSERT INTO "story_duplicate_embedding"
			("id", "storyId", "projectId", "contentHash", "model", "embedding", "createdAt", "updatedAt")
		SELECT x.id, x."storyId", ${projectId}, x."contentHash", x."model", x.embedding::jsonb, now(), now()
		FROM jsonb_to_recordset(${payload}::jsonb)
			AS x(id text, "storyId" text, "contentHash" text, "model" text, embedding text)
		ON CONFLICT ("storyId") DO UPDATE SET
			"projectId" = ${projectId},
			"contentHash" = EXCLUDED."contentHash",
			"model" = EXCLUDED."model",
			"embedding" = EXCLUDED."embedding",
			"updatedAt" = now();
	`;
}

/** Stamp the project's last successful duplicate-scan time (telemetry/UX only;
 * does not affect detection). */
export async function setProjectLastDuplicateScanAt(
	projectId: string,
	when: Date,
): Promise<void> {
	await db.project.update({
		where: { id: projectId },
		data: { lastDuplicateScanAt: when },
	});
}
