/**
 * Company context search (Fizzy #2719).
 *
 * Reads the organization's `company-contexts-org-{orgId}` collection for
 * Proposal and Business Case generation. The caller decides who may read it
 * and which sources are ready; this module only asks Qdrant, and only inside
 * the limits the caller hands it:
 *
 * - `organizationId` names the collection and is filtered on again inside it.
 * - `embeddingModel` keeps the results to vectors written by the model the
 *   query was embedded with. Vectors from another model live in a different
 *   embedding space; scoring them against this query is noise.
 * - `sourceIds` keeps the results to sources the caller found ready. Without
 *   it, a source half-way through re-processing would still answer queries.
 *
 * Dense search only, with a score threshold. Fusion scores are ranks, not
 * similarities, so a hybrid query could not honour the threshold.
 *
 * A read never creates the collection: an organization that never embedded a
 * company source has nothing to find, and a search must not leave an empty
 * collection behind to say so.
 */

import { logger } from "@repo/logs";
import {
	COMPANY_CONTEXTS_BASE_COLLECTION,
	getCollectionLayout,
	getCollectionName,
} from "../collection-manager";
import { qdrantClient } from "../vector-store/client";

export interface CompanyContextSearchOptions {
	organizationId: string;
	/** The model identity the query vector was produced with. */
	embeddingModel: string;
	queryEmbedding: number[];
	/**
	 * The company sources a hit may come from — the caller's ready set. An
	 * empty list finds nothing and does not reach Qdrant.
	 */
	sourceIds: readonly string[];
	topK?: number;
	minSimilarity?: number;
}

/** One matching chunk of a company source. */
export interface CompanyContextSearchHit {
	/** The CompanyContextSource id (`originalContextId`), also for page chunks. */
	sourceId: string;
	/** The row the text came from: the source, or one of its crawled pages. */
	contextId: string;
	/**
	 * The source id on a crawled page's chunk, null on the source's own. A
	 * page hit can outlive its page row; the caller checks it against one.
	 */
	parentContextId: string | null;
	contextType: string | null;
	/** The chunk text. */
	content: string;
	chunkIndex: number | null;
	score: number;
	sourceUrl: string | null;
	sourceTitle: string | null;
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Qdrant's answer for a collection that does not exist. */
function isNotFound(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { status?: unknown }).status === 404
	);
}

/**
 * Whether the organization's company collection exists, asked of that one
 * collection. Every Proposal and Business Case generation asks, so it must
 * not list every collection in the instance (`collectionExistsUncached`
 * does), and it must not be cached either: a collection another worker
 * created a moment ago is there to be searched. Not found is `false`; any
 * other failure propagates, so an unreachable store never reads as an empty
 * one.
 */
async function companyCollectionExists(
	collectionName: string,
): Promise<boolean> {
	try {
		await qdrantClient.getCollection(collectionName);
		return true;
	} catch (error) {
		if (isNotFound(error)) {
			return false;
		}
		throw error;
	}
}

/**
 * Find the company context chunks most similar to a query vector, best first.
 * Throws when Qdrant fails, so the caller can tell "nothing matched" from
 * "the search did not run".
 */
export async function searchCompanyContexts(
	options: CompanyContextSearchOptions,
): Promise<CompanyContextSearchHit[]> {
	const {
		organizationId,
		embeddingModel,
		queryEmbedding,
		sourceIds,
		topK = 12,
		minSimilarity = 0.5,
	} = options;

	if (!embeddingModel) {
		throw new Error("searchCompanyContexts requires an embedding model");
	}
	// Throws without an organization: company vectors have no shared collection.
	const collectionName = getCollectionName(
		COMPANY_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);
	if (sourceIds.length === 0) {
		return [];
	}
	if (!(await companyCollectionExists(collectionName))) {
		logger.info(
			`[CompanyContextSearch] No company collection for organization ${organizationId}`,
		);
		return [];
	}

	const layout = await getCollectionLayout(
		COMPANY_CONTEXTS_BASE_COLLECTION,
		organizationId,
	);
	const vector = layout.denseVectorName
		? { name: layout.denseVectorName, vector: queryEmbedding }
		: queryEmbedding;

	const points = await qdrantClient.search(collectionName, {
		vector,
		limit: topK,
		score_threshold: minSimilarity,
		with_payload: true,
		filter: {
			must: [
				{ key: "organizationId", match: { value: organizationId } },
				{ key: "embeddingModel", match: { value: embeddingModel } },
				{ key: "originalContextId", match: { any: [...sourceIds] } },
			],
		},
	});

	const hits: CompanyContextSearchHit[] = [];
	for (const point of points) {
		const payload = point.payload ?? {};
		const sourceId = stringOrNull(payload.originalContextId);
		const content = stringOrNull(payload.content);
		// A point without its source id cannot be checked against a live row,
		// and one without text has nothing to give the prompt.
		if (!sourceId || !content) {
			continue;
		}
		hits.push({
			sourceId,
			contextId: stringOrNull(payload.contextId) ?? sourceId,
			parentContextId: stringOrNull(payload.parentContextId),
			contextType: stringOrNull(payload.contextType),
			content,
			chunkIndex:
				typeof payload.chunkIndex === "number"
					? payload.chunkIndex
					: null,
			score: point.score,
			sourceUrl: stringOrNull(payload.sourceUrl),
			sourceTitle: stringOrNull(payload.sourceTitle),
		});
	}

	logger.info(
		`[CompanyContextSearch] ${hits.length} company context hits for organization ${organizationId} (topK=${topK}, minSimilarity=${minSimilarity})`,
	);
	return hits;
}
