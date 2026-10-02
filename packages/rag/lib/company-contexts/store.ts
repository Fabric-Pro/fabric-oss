/**
 * Company context points (Fizzy #2719): writing and deleting the vectors of an
 * organization's company context sources.
 *
 * They live in `company-contexts-org-{orgId}`, never in a project collection,
 * and every point carries its organization and never a project. The payload
 * is the contract retrieval (`./search`) reads:
 *
 * - `organizationId` — always set;
 * - `originalContextId` — ALWAYS the `CompanyContextSource` id, also on a
 *   crawled page's chunks, so one delete by it removes every vector of a
 *   source and retrieval hydrates a hit by it;
 * - `contextId` — the row the text came from: the source for a file or a
 *   text, the `CompanyContextUrlPage` for a crawled page;
 * - `parentContextId` — the source id on a crawled page's chunks, null
 *   otherwise;
 * - `contextType` — the source's type (`FILE` | `TEXT` | `LINK`);
 * - `embeddingModel` — the identity of the model that produced the vector
 *   (`resolveCompanyEmbeddingModel`), which retrieval filters on;
 * - `content`, `chunkIndex`, and `sourceUrl` / `sourceTitle` when known.
 *
 * Deletes resolve the collection name exactly as the writers do and never
 * through a helper that creates it: an organization that never embedded
 * anything has no collection, which is a successful "nothing to delete", not
 * a reason to conjure one.
 */

import { logger } from "@repo/logs";
import {
	COMPANY_CONTEXTS_BASE_COLLECTION,
	type CollectionLayout,
	collectionExistsUncached,
	getCollectionLayout,
	getCollectionName,
} from "../collection-manager";
import { generateSparseVector } from "../embedding/sparse";
import { generatePointId } from "../utils/point-id";
import { qdrantClient } from "../vector-store/client";

/** One chunk of a company source, ready to be written. */
export interface CompanyContextPointInput {
	organizationId: string;
	/** The `CompanyContextSource` the text belongs to: `originalContextId`. */
	sourceId: string;
	/** The row the text came from: the source itself, or a crawled page. */
	contextId: string;
	/** The source id, on a crawled page's chunks; omitted otherwise. */
	parentContextId?: string | null;
	/** The source's type: `FILE`, `TEXT` or `LINK`. */
	contextType: string;
	/** Identity of the model that produced `embedding`. */
	embeddingModel: string;
	content: string;
	chunkIndex: number;
	embedding: number[];
	sparseVector?: { indices: number[]; values: number[] };
	sourceUrl?: string | null;
	sourceTitle?: string | null;
}

/** What a delete found, so a caller never reports absence it did not check. */
export interface CompanyContextPointsDeletion {
	/**
	 * False when the organization's company collection does not exist: it is
	 * created on the first write, so there was nothing to delete.
	 */
	collectionExists: boolean;
}

/** Points per upsert request; a large file's chunks go in several. */
const UPSERT_BATCH_SIZE = 64;

/** Ids per `contextId` delete filter. */
const DELETE_BATCH_SIZE = 100;

/**
 * The point id of one chunk: deterministic in the row and the chunk index,
 * so a retried write replaces its own points instead of duplicating them.
 */
export function companyContextPointId(
	contextId: string,
	chunkIndex: number,
): string {
	return generatePointId(`company-context:${contextId}:chunk-${chunkIndex}`);
}

function buildPointVector(
	layout: CollectionLayout,
	point: CompanyContextPointInput,
):
	| number[]
	| Record<string, number[] | { indices: number[]; values: number[] }> {
	if (!layout.supportsHybrid) {
		return point.embedding;
	}
	const sparse = point.sparseVector ?? generateSparseVector(point.content);
	return {
		[layout.denseVectorName ?? ""]: point.embedding,
		[layout.sparseVectorName ?? "sparse"]: sparse,
	};
}

function assertPointInput(
	point: CompanyContextPointInput,
	organizationId: string,
): void {
	if (point.organizationId !== organizationId) {
		// One call writes one organization's collection; a point of another
		// organization would land in the wrong tenant's collection.
		throw new Error(
			"storeCompanyContextPoints writes one organization's points per call",
		);
	}
	if (!point.sourceId || !point.contextId) {
		throw new Error(
			"A company context point requires its source and row ids",
		);
	}
	if (!point.embeddingModel) {
		throw new Error("A company context point requires its embedding model");
	}
}

/**
 * Write chunks of company sources to the organization's company collection,
 * creating the collection on first use. All points must belong to one
 * organization. Returns the point ids in input order.
 *
 * Throws on any Qdrant failure: a caller marks a source embedded only after
 * every one of its chunks is written.
 */
export async function storeCompanyContextPoints(
	points: readonly CompanyContextPointInput[],
): Promise<string[]> {
	if (points.length === 0) {
		return [];
	}
	const { organizationId } = points[0];
	if (!organizationId) {
		throw new Error("Company context points require an organizationId");
	}
	for (const point of points) {
		assertPointInput(point, organizationId);
	}

	try {
		const layout = await getCollectionLayout(
			COMPANY_CONTEXTS_BASE_COLLECTION,
			organizationId,
		);
		const createdAt = new Date().toISOString();
		const ids = points.map((point) =>
			companyContextPointId(point.contextId, point.chunkIndex),
		);

		for (let start = 0; start < points.length; start += UPSERT_BATCH_SIZE) {
			const batch = points.slice(start, start + UPSERT_BATCH_SIZE);
			await qdrantClient.upsert(layout.collectionName, {
				wait: true,
				points: batch.map((point, offset) => ({
					id: ids[start + offset],
					vector: buildPointVector(layout, point),
					payload: {
						organizationId,
						originalContextId: point.sourceId,
						contextId: point.contextId,
						parentContextId: point.parentContextId ?? null,
						contextType: point.contextType,
						embeddingModel: point.embeddingModel,
						content: point.content,
						chunkIndex: point.chunkIndex,
						sourceUrl: point.sourceUrl ?? null,
						sourceTitle: point.sourceTitle ?? null,
						createdAt,
					},
				})),
			});
		}

		logger.info(
			`[CompanyContextStore] Stored ${points.length} point(s) in ${layout.collectionName}`,
		);
		return ids;
	} catch (error) {
		logger.error(
			`[CompanyContextStore] Failed to store company context points: ${error}`,
		);
		throw new Error(
			`Failed to store company context points: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

type PointFilterCondition = {
	key: string;
	match: { value: string } | { any: string[] };
};

/**
 * One delete request's filter, apart from the organization: the points that
 * match every `must` condition and no `mustNot` one.
 */
interface PointDeleteFilter {
	must: PointFilterCondition[];
	mustNot?: PointFilterCondition[];
}

/**
 * Delete the organization's company points matching `filters`, one request
 * per filter. The collection is resolved by name and checked, never ensured;
 * a missing one is reported, not created.
 */
async function deleteCompanyPoints(
	organizationId: string,
	filters: readonly PointDeleteFilter[],
	description: string,
): Promise<CompanyContextPointsDeletion> {
	if (!organizationId) {
		throw new Error(
			"Deleting company context points requires an organizationId",
		);
	}
	const collectionName = getCollectionName(
		COMPANY_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);

	try {
		if (!(await collectionExistsUncached(collectionName))) {
			logger.info(
				`[CompanyContextStore] ${collectionName} does not exist; no points to delete for ${description}`,
			);
			return { collectionExists: false };
		}

		await Promise.all(
			filters.map(({ must, mustNot }) =>
				qdrantClient.delete(collectionName, {
					wait: true,
					filter: {
						must: [
							// Defense in depth on top of the per-organization
							// collection.
							{
								key: "organizationId",
								match: { value: organizationId },
							},
							...must,
						],
						...(mustNot && mustNot.length > 0
							? { must_not: mustNot }
							: {}),
					},
				}),
			),
		);

		logger.info(
			`[CompanyContextStore] Deleted points for ${description} from ${collectionName}`,
		);
		return { collectionExists: true };
	} catch (error) {
		logger.error(
			`[CompanyContextStore] Failed to delete points for ${description}: ${error}`,
		);
		throw new Error(
			`Failed to delete company context points: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
	}
}

/**
 * Delete every point of a company source — its own chunks and every crawled
 * page's — by `originalContextId`. Throws on a Qdrant failure, so a caller
 * can keep the source row (and the ids this needs) until it succeeds.
 */
export async function deleteCompanyContextSourcePoints(params: {
	organizationId: string;
	sourceId: string;
}): Promise<CompanyContextPointsDeletion> {
	const { organizationId, sourceId } = params;
	if (!sourceId) {
		throw new Error("deleteCompanyContextSourcePoints requires a sourceId");
	}
	return deleteCompanyPoints(
		organizationId,
		[{ must: [{ key: "originalContextId", match: { value: sourceId } }] }],
		`source ${sourceId}`,
	);
}

/**
 * Delete the points written from specific rows, by `contextId`: a source's
 * own chunks before it is embedded again, or crawled pages that changed or
 * disappeared. A source's crawled pages are untouched by a delete of the
 * source's own row. Throws on a Qdrant failure.
 */
export async function deleteCompanyContextRowPoints(params: {
	organizationId: string;
	contextIds: readonly string[];
}): Promise<CompanyContextPointsDeletion> {
	const { organizationId } = params;
	const contextIds = [...new Set(params.contextIds)].filter(Boolean);
	// No ids still resolves and checks the collection, so the answer is one
	// this call verified rather than assumed.
	return deleteCompanyPoints(
		organizationId,
		contextIdBatches(contextIds).map((condition) => ({
			must: [condition],
		})),
		`${contextIds.length} row(s)`,
	);
}

/**
 * Delete every crawled-page point of a website source whose page is not
 * among `livePageIds` — the source's page rows as they are now. One request:
 * the points whose `parentContextId` is the source and whose `contextId` is
 * none of the live pages. The source's own points (no `parentContextId`) and
 * every other source's pages are outside the filter.
 *
 * Idempotent and driven by the rows alone, so it needs no record of which
 * pages were deleted: run after a prune, it removes the vectors of pages
 * whose rows are gone, and whatever an earlier run failed to remove. No live
 * page removes every page point of the source. A page whose row is created
 * after `livePageIds` was read and whose points are written before this
 * delete lands would lose them; a caller runs this while it holds the
 * source's crawl, so no other crawl writes pages meanwhile. Throws on a
 * Qdrant failure.
 */
export async function deleteCompanyPagePointsNotIn(params: {
	organizationId: string;
	sourceId: string;
	livePageIds: readonly string[];
}): Promise<CompanyContextPointsDeletion> {
	const { organizationId, sourceId } = params;
	if (!sourceId) {
		throw new Error("deleteCompanyPagePointsNotIn requires a sourceId");
	}
	const livePageIds = [...new Set(params.livePageIds)].filter(Boolean);
	return deleteCompanyPoints(
		organizationId,
		[
			{
				must: [{ key: "parentContextId", match: { value: sourceId } }],
				// A point is kept when it matches any batch: must_not refuses a
				// match on each of them.
				mustNot: contextIdBatches(livePageIds),
			},
		],
		`pages of source ${sourceId} outside ${livePageIds.length} live page(s)`,
	);
}

/** `contextId` conditions over `ids`, `DELETE_BATCH_SIZE` ids each. */
function contextIdBatches(ids: readonly string[]): PointFilterCondition[] {
	const conditions: PointFilterCondition[] = [];
	for (let start = 0; start < ids.length; start += DELETE_BATCH_SIZE) {
		conditions.push({
			key: "contextId",
			match: { any: ids.slice(start, start + DELETE_BATCH_SIZE) },
		});
	}
	return conditions;
}
