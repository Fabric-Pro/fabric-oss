/**
 * Upstash cache of the Proposal Inbox items' duplicate-detection vectors.
 *
 * The inbox duplicate check compares every unresolved item of every PENDING
 * proposal. Embedding all of them on each call would make the cost grow with
 * the inbox, so each item's vectors are kept here, keyed by a hash of the
 * text that was embedded and by the embedding model: an edited item, or a
 * changed model, is a new key and is embedded again. A check embeds only the
 * items it does not find, a bounded number per call.
 *
 * Keys carry the organization and the project, so one tenant's vectors are
 * never read for another's, even for the same text.
 *
 * Every read and write reports failure instead of throwing; the caller
 * decides how the check degrades.
 */

import {
	hashDetectionText,
	PAIR_FOCUS_KINDS,
	type PairFocusKind,
} from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import { getRedisClient } from "../../../lib/redis-client";

/** Long enough to outlive a proposal's review; a key is never stale, since
 * its text and model are part of it. */
const TTL_SECONDS = 14 * 24 * 60 * 60;

/** Keys per MGET / pipeline, to keep each Upstash request small: a vector
 * is several kilobytes of JSON. */
const BATCH_SIZE = 50;

const LOG_PREFIX = "[proposal-item-vector-cache]";

/** An item's whole-text vector and its section vectors. */
export interface ItemVectors {
	embedding: number[];
	focusVectors?: Partial<Record<PairFocusKind, number[]>>;
}

/** Whose vectors, and from which embedding model. */
export interface ItemVectorScope {
	organizationId: string | null;
	projectId: string;
	model: string;
}

/** The hash an item's vectors are cached under: its text and its sections. */
export function itemVectorHash(subject: {
	text: string;
	focusTexts: Partial<Record<PairFocusKind, string>> | null;
}): string {
	return hashDetectionText(
		JSON.stringify([
			subject.text,
			...PAIR_FOCUS_KINDS.map((kind) => subject.focusTexts?.[kind] ?? ""),
		]),
	);
}

export function itemVectorKey(scope: ItemVectorScope, hash: string): string {
	return `proposal-dup:vec:${scope.organizationId ?? "_"}:${scope.projectId}:${scope.model}:${hash}`;
}

const vectorSchema = z.array(z.number()).min(1);

/** What a cache entry must hold to be used; anything else is a miss. */
const itemVectorsSchema = z.object({
	embedding: vectorSchema,
	focusVectors: z
		.object({
			scope: vectorSchema.optional(),
			acceptance_criteria: vectorSchema.optional(),
		})
		.optional(),
});

function readItemVectors(value: unknown): ItemVectors | null {
	const parsed = itemVectorsSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

function batches<T>(values: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let start = 0; start < values.length; start += BATCH_SIZE) {
		out.push(values.slice(start, start + BATCH_SIZE));
	}
	return out;
}

/**
 * The cached vectors of the given hashes; a hash not in the map was not
 * found. Null when the cache is not configured or could not be read.
 */
export async function readCachedItemVectors(
	scope: ItemVectorScope,
	hashes: readonly string[],
): Promise<Map<string, ItemVectors> | null> {
	const redis = getRedisClient();
	if (!redis) {
		return null;
	}
	const found = new Map<string, ItemVectors>();
	try {
		// Batches are read in parallel: a large inbox is many requests, and
		// the check has a request deadline.
		const keyBatches = batches(Array.from(new Set(hashes)));
		const valueBatches = await Promise.all(
			keyBatches.map((batch) =>
				redis.mget<unknown[]>(
					batch.map((hash) => itemVectorKey(scope, hash)),
				),
			),
		);
		keyBatches.forEach((batch, batchIndex) => {
			batch.forEach((hash, index) => {
				const vectors = readItemVectors(
					valueBatches[batchIndex]?.[index],
				);
				if (vectors) {
					found.set(hash, vectors);
				}
			});
		});
		return found;
	} catch (error) {
		logger.warn(`${LOG_PREFIX} Redis MGET failed`, {
			projectId: scope.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Stores freshly embedded vectors. False when the cache is not configured
 * or the write failed.
 */
export async function writeCachedItemVectors(
	scope: ItemVectorScope,
	vectors: ReadonlyMap<string, ItemVectors>,
): Promise<boolean> {
	const redis = getRedisClient();
	if (!redis) {
		return false;
	}
	try {
		for (const batch of batches(Array.from(vectors))) {
			const pipeline = redis.pipeline();
			for (const [hash, value] of batch) {
				pipeline.set(itemVectorKey(scope, hash), value, {
					ex: TTL_SECONDS,
				});
			}
			await pipeline.exec();
		}
		return true;
	} catch (error) {
		logger.warn(`${LOG_PREFIX} Redis SET failed`, {
			projectId: scope.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
