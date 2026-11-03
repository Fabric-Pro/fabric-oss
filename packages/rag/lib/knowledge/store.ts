/**
 * Vector store for the project knowledge hub (specs/2026-10-21-ai-artifacts-hub).
 *
 * Knowledge entries live in their own Qdrant collection, not in
 * project-contexts: their payload carries the topic, type, author and time,
 * so semantic search can filter on them, and the context retrieval paths that
 * read project-contexts keep their current behaviour.
 *
 * One point per entry (title + body embedded together). Point ids are derived
 * from the entry id, so a retried embed overwrites instead of duplicating.
 */

import { createHash } from "node:crypto";
import { logger } from "@repo/logs";
import { DISTANCE_METRIC, qdrantClient, VECTOR_SIZE } from "../vector-store";

export const KNOWLEDGE_COLLECTION_NAME =
	process.env.QDRANT_KNOWLEDGE_COLLECTION_NAME || "project-knowledge";

let collectionReady: Promise<void> | null = null;

/** Creates the collection and its payload indexes once per process. */
export function ensureKnowledgeCollection(): Promise<void> {
	if (!collectionReady) {
		collectionReady = createCollectionIfMissing().catch((error) => {
			collectionReady = null;
			throw error;
		});
	}
	return collectionReady;
}

async function createCollectionIfMissing(): Promise<void> {
	const { collections } = await qdrantClient.getCollections();
	if (collections.some((c) => c.name === KNOWLEDGE_COLLECTION_NAME)) {
		return;
	}
	await qdrantClient.createCollection(KNOWLEDGE_COLLECTION_NAME, {
		vectors: { size: VECTOR_SIZE, distance: DISTANCE_METRIC },
	});
	for (const field of [
		"projectId",
		"organizationId",
		"topicId",
		"typeKey",
		"authorUserId",
	]) {
		await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION_NAME, {
			field_name: field,
			field_schema: "keyword",
		});
	}
	await qdrantClient.createPayloadIndex(KNOWLEDGE_COLLECTION_NAME, {
		field_name: "createdAtMs",
		field_schema: "integer",
	});
	logger.info(
		`[Knowledge] Created Qdrant collection ${KNOWLEDGE_COLLECTION_NAME}`,
	);
}

/** A stable UUID for an entry id (Qdrant point ids must be UUIDs or integers). */
export function knowledgePointId(entryId: string): string {
	const hex = createHash("sha256")
		.update(`knowledge:${entryId}`)
		.digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type KnowledgeVectorPayload = {
	entryId: string;
	projectId: string;
	organizationId: string | null;
	topicId: string;
	topicKey: string;
	topicTitle: string;
	typeKey: string;
	authorUserId: string;
	role: string | null;
	title: string;
	/** The embedded text, returned as the search snippet. */
	text: string;
	createdAtMs: number;
};

export async function upsertKnowledgeVector(
	vector: number[],
	payload: KnowledgeVectorPayload,
): Promise<string> {
	await ensureKnowledgeCollection();
	const id = knowledgePointId(payload.entryId);
	await qdrantClient.upsert(KNOWLEDGE_COLLECTION_NAME, {
		wait: true,
		points: [{ id, vector, payload }],
	});
	return id;
}

export type KnowledgeVectorFilter = {
	projectId: string;
	topicId?: string;
	typeKeys?: string[];
	authorUserId?: string;
	sinceMs?: number;
	untilMs?: number;
};

export type KnowledgeVectorHit = KnowledgeVectorPayload & { score: number };

export async function searchKnowledgeVectors(
	vector: number[],
	filter: KnowledgeVectorFilter,
	limit = 10,
): Promise<KnowledgeVectorHit[]> {
	await ensureKnowledgeCollection();
	const must: Record<string, unknown>[] = [
		{ key: "projectId", match: { value: filter.projectId } },
	];
	if (filter.topicId) {
		must.push({ key: "topicId", match: { value: filter.topicId } });
	}
	if (filter.typeKeys?.length) {
		must.push({ key: "typeKey", match: { any: filter.typeKeys } });
	}
	if (filter.authorUserId) {
		must.push({
			key: "authorUserId",
			match: { value: filter.authorUserId },
		});
	}
	if (filter.sinceMs !== undefined || filter.untilMs !== undefined) {
		must.push({
			key: "createdAtMs",
			range: {
				...(filter.sinceMs !== undefined
					? { gte: filter.sinceMs }
					: {}),
				...(filter.untilMs !== undefined
					? { lte: filter.untilMs }
					: {}),
			},
		});
	}
	const results = await qdrantClient.search(KNOWLEDGE_COLLECTION_NAME, {
		vector,
		limit,
		filter: { must },
		with_payload: true,
	});
	return results.map((hit) => ({
		...(hit.payload as unknown as KnowledgeVectorPayload),
		score: hit.score,
	}));
}

/** Removes the points of entries (e.g. when a project is deleted). */
export async function deleteKnowledgeVectors(
	entryIds: string[],
): Promise<void> {
	if (entryIds.length === 0) {
		return;
	}
	await ensureKnowledgeCollection();
	await qdrantClient.delete(KNOWLEDGE_COLLECTION_NAME, {
		wait: true,
		points: entryIds.map(knowledgePointId),
	});
}
