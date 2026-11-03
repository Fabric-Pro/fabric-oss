import {
	db,
	getRetrievableContextById,
	getRetrievableConversationBundleById,
} from "@repo/database";
import { logger } from "@repo/logs";
import { rethrowIfDispatchStopped } from "@repo/utils/dispatch-guard";
import { generateSparseVector } from "../embedding/sparse";
import { searchSimilarProjectContexts } from "./store";
import type {
	ProjectContextSearchOptions,
	ProjectRetrievalResult,
} from "./types";

type ContextRow = NonNullable<
	Awaited<ReturnType<typeof getRetrievableContextById>>
>;

/** Search with shared keyword encoding and a caller-controlled dense fallback. */
export async function searchProjectContextHits(
	options: Omit<ProjectContextSearchOptions, "querySparseVector"> & {
		query: string;
		/** Keep the main retrieval caller's existing encoder-error contract. */
		fallbackOnSparseFailure?: boolean;
	},
): Promise<ProjectRetrievalResult[]> {
	const { query, fallbackOnSparseFailure = true, ...searchOptions } = options;
	let querySparseVector: ProjectContextSearchOptions["querySparseVector"];
	try {
		querySparseVector = generateSparseVector(query);
	} catch (error) {
		rethrowIfDispatchStopped(error);
		if (!fallbackOnSparseFailure) {
			throw error;
		}
		logger.warn("[Retrieval] Sparse encoding failed; using dense search");
	}
	return searchSimilarProjectContexts({
		...searchOptions,
		querySparseVector,
	});
}

/**
 * Resolve distinct hits in relevance order through context, URL-page and bundle bodies.
 * Individual lookups preserve the main retrieval path. Activity batch lookups retain
 * their existing query scope; task retrieval also checks URL pages against that scope.
 * Callers normalize legacy chunk ids before calling when their contract requires it.
 */
export async function hydrateProjectContextHits(options: {
	hits: ProjectRetrievalResult[];
	projectId: string;
	userId: string;
	organizationId?: string;
	lookup?: "individual" | "batch" | "project-scoped-batch";
}): Promise<
	Array<{ hit: ProjectRetrievalResult; context: ContextRow | null }>
> {
	const {
		projectId,
		userId,
		organizationId,
		lookup = "individual",
	} = options;
	const seen = new Set<string>();
	const hits = options.hits.filter((hit) => {
		if (seen.has(hit.contextId)) {
			return false;
		}
		seen.add(hit.contextId);
		return true;
	});
	const rowsById = new Map<string, ContextRow>();
	if (lookup !== "individual") {
		const rowIds = hits
			.filter((hit) => !hit.conversationBundleId)
			.map((hit) => hit.contextId);
		const project = {
			id: projectId,
			...(organizationId
				? { organizationId }
				: { userId, organizationId: null }),
		};
		if (rowIds.length > 0) {
			const rows = await db.projectContext.findMany({
				where: {
					id: { in: rowIds },
					...(lookup === "project-scoped-batch" ? { project } : {}),
				},
				select: {
					id: true,
					content: true,
					type: true,
					createdAt: true,
					metadata: true,
					originalFilename: true,
					sourceUrl: true,
					sourceTitle: true,
					sourcePath: true,
					sourceType: true,
					aiInstructions: true,
				},
			});
			for (const row of rows) {
				rowsById.set(row.id, row);
			}
			let missingIds = rowIds.filter((id) => !rowsById.has(id));
			if (lookup === "project-scoped-batch" && missingIds.length > 0) {
				// Check candidate pages against the activity's existing project boundary.
				const pages = await db.projectContextUrlPage.findMany({
					where: {
						id: { in: missingIds },
						parentContext: { project },
					},
					select: { id: true },
				});
				missingIds = pages.map((page) => page.id);
			}
			const pages = await Promise.all(
				missingIds.map((id) => getRetrievableContextById(id)),
			);
			pages.forEach((page, i) => {
				if (page) {
					rowsById.set(missingIds[i], page);
				}
			});
		}
	}
	return Promise.all(
		hits.map(async (hit) => ({
			hit,
			context: hit.conversationBundleId
				? await getRetrievableConversationBundleById({
						bundleId: hit.conversationBundleId,
						projectId,
						tenant: { userId, organizationId },
					})
				: lookup === "individual"
					? await getRetrievableContextById(hit.contextId)
					: (rowsById.get(hit.contextId) ?? null),
		})),
	);
}
