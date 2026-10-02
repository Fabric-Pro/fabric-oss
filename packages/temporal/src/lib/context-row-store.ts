/**
 * Row reads and writes of the ingestion pipeline, for either owner of a
 * context (Fizzy #2719).
 *
 * The file-processing, embedding and deletion activities are shared between
 * project contexts and company context sources. What differs is the table the
 * source row lives in, so the row operations go through this adapter, chosen
 * inside each activity from the input's owner (`./context-owner`):
 *
 * - the project store wraps exactly the queries the pipeline has always made
 *   on `ProjectContext`, with the same arguments, so a project run writes
 *   what it wrote before;
 * - the company store reads and writes `CompanyContextSource` through its
 *   query module, always scoped by the owner's organization.
 *
 * Company writes keyed by id return whether a row matched: a source deleted
 * while its ingestion is in flight is a normal event, and the caller decides
 * what a miss means. A source whose delete has started (its `deletingAt`
 * tombstone is set) reads the same to the writes that would make it ready —
 * `markEmbedded`, `setStatus` COMPLETED, the crawl claim and finalize — so a
 * late run removes the points it wrote, as for a source already gone. Reads
 * are not filtered: the deletion activity loads the tombstoned row to delete
 * it. The project store keeps its old contract — its writes throw when the
 * row is gone — and returns true otherwise.
 *
 * Crawled-page operations (LINK sources) are added beside these, not into
 * them, so each store stays the set of operations its callers use.
 */

import {
	type CompanyContextSourceRecord,
	type CompanyLinkSourceCrawlOutcome,
	type CompanyLinkSourceCrawlState,
	cancelUnfinishedCompanyContextUrlPages,
	claimCompanyLinkSourceCrawl,
	clearCompanyContextSourceEmbedding,
	countCompanyContextUrlPagesEmbeddedWith,
	createCompanyContextUrlPages,
	type DeletedCompanyContextSource,
	db,
	deleteCompanyContextSource,
	type ExtractionStatus,
	finalizeCompanyLinkSourceCrawl,
	getCompanyContextSource,
	getCompanyLinkSourceCrawlState,
	type IndexingFailureOptions,
	listCompanyContextUrlPages,
	markCompanyContextSourceEmbedded,
	markCompanyContextUrlPageEmbedded,
	markContextAsEmbedded,
	pruneCompanyContextUrlPages,
	recordCompanyContextSourceIndexingFailure,
	recordContextIndexingFailure,
	type UpsertCompanyContextUrlPageResult,
	updateCompanyContextSourceStatus,
	updateContextExtractionStatus,
	upsertCompanyContextUrlPage,
} from "@repo/database";
import type {
	CompanyContextOwner,
	ContextOwner,
	ProjectContextOwner,
} from "./context-owner";

/** The source-row fields the pipeline reads, present on both tables. */
export interface ContextSourceRow {
	id: string;
	type: string;
	content: string;
	contentHash: string | null;
	metadata: unknown;
	s3Path: string | null;
	s3Bucket: string | null;
	originalFilename: string | null;
	mimeType: string | null;
	sourceUrl: string | null;
	sourceTitle: string | null;
	extractionStatus: ExtractionStatus;
	qdrantId: string | null;
}

/** What a status write may carry besides the status. */
export interface ContextStatusData {
	content?: string;
	/** `null` clears a message an earlier attempt left. */
	extractionError?: string | null;
}

export interface ContextRowStore {
	readonly owner: ContextOwner;
	/** The source row, or null when it is not this owner's or is gone. */
	loadSource(contextId: string): Promise<ContextSourceRow | null>;
	getStatus(contextId: string): Promise<ExtractionStatus | null>;
	/** Record a status, and optionally extracted content or an error. */
	setStatus(
		contextId: string,
		status: ExtractionStatus,
		data?: ContextStatusData,
	): Promise<boolean>;
	/**
	 * Record that the row is embedded. `embeddingModel` is the identity the
	 * points were written with; a company source must record it, a project
	 * context has no column for it.
	 */
	markEmbedded(
		contextId: string,
		embedding: { qdrantId: string | null; embeddingModel?: string },
	): Promise<boolean>;
	/** Record that indexing failed without claiming extraction did. */
	recordIndexingFailure(
		contextId: string,
		message: string,
		options?: IndexingFailureOptions,
	): Promise<boolean>;
}

/** Company-only operations: re-embed and delete a source. */
export interface CompanyContextRowStore extends ContextRowStore {
	readonly owner: CompanyContextOwner;
	/** The whole company row, crawl bookkeeping included. */
	loadSource(contextId: string): Promise<CompanyContextSourceRecord | null>;
	/** Forget the index markers, before a pass that removes the points. */
	clearEmbedding(contextId: string): Promise<boolean>;
	/** Delete the row (its crawled pages cascade); null when it was not there. */
	deleteSource(
		contextId: string,
	): Promise<DeletedCompanyContextSource | null>;
}

/**
 * The project store. `scope` is the run's tenant, used by `loadSource`
 * exactly as the processing activity always filtered: an organization's
 * context by organization (project access was checked by the API before the
 * workflow started), a personal one by its user as well.
 */
export function projectContextRowStore(
	owner: ProjectContextOwner,
	scope: { userId?: string; organizationId?: string | null },
): ContextRowStore {
	return {
		owner,
		loadSource: (contextId) => {
			const orgFilter = scope.organizationId
				? { organizationId: scope.organizationId }
				: { organizationId: null, userId: scope.userId };
			return db.projectContext.findFirst({
				where: {
					id: contextId,
					projectId: owner.projectId,
					...orgFilter,
				},
			});
		},
		getStatus: async (contextId) => {
			const row = await db.projectContext.findUnique({
				where: { id: contextId },
				select: { extractionStatus: true },
			});
			return row?.extractionStatus ?? null;
		},
		setStatus: async (contextId, status, data) => {
			await updateContextExtractionStatus(contextId, status, data);
			return true;
		},
		markEmbedded: async (contextId, { qdrantId }) => {
			if (qdrantId) {
				await markContextAsEmbedded(contextId, qdrantId);
			}
			return true;
		},
		recordIndexingFailure: async (contextId, message, options) => {
			// Two arguments unless there are options, as every caller has
			// always made this call.
			await (options
				? recordContextIndexingFailure(contextId, message, options)
				: recordContextIndexingFailure(contextId, message));
			return true;
		},
	};
}

/** The company store: every read and write scoped by the owner's organization. */
export function companyContextRowStore(
	owner: CompanyContextOwner,
): CompanyContextRowStore {
	const { organizationId } = owner;
	return {
		owner,
		loadSource: (contextId) =>
			getCompanyContextSource(contextId, organizationId),
		getStatus: async (contextId) =>
			(await getCompanyContextSource(contextId, organizationId))
				?.extractionStatus ?? null,
		setStatus: (contextId, status, data) =>
			updateCompanyContextSourceStatus(
				contextId,
				organizationId,
				status,
				data,
			),
		markEmbedded: (contextId, { qdrantId, embeddingModel }) => {
			if (!embeddingModel) {
				throw new Error(
					"A company context source is marked embedded only with its embedding model",
				);
			}
			return markCompanyContextSourceEmbedded(contextId, organizationId, {
				embeddingModel,
				qdrantId,
			});
		},
		recordIndexingFailure: (contextId, message, options) =>
			recordCompanyContextSourceIndexingFailure(
				contextId,
				organizationId,
				message,
				options,
			),
		clearEmbedding: (contextId) =>
			clearCompanyContextSourceEmbedding(contextId, organizationId),
		deleteSource: (contextId) =>
			deleteCompanyContextSource(contextId, organizationId),
	};
}

// ============================================================================
// Website crawls of a company source
// ============================================================================

/**
 * What a crawl's finalize records on a company LINK source; `undefined`
 * leaves a field alone.
 */
export interface CompanyCrawlFinalizeData
	extends CompanyLinkSourceCrawlOutcome {
	/** The finishing crawl, which must hold the slot or find it free. */
	workflowId: string;
}

/** The index markers of one crawled page, and whether its content is indexed. */
export interface CompanyUrlPageEmbedding {
	extractionStatus: ExtractionStatus;
	embeddedAt: Date | null;
	embeddingModel: string | null;
}

/**
 * The crawl's reads and writes on a company LINK source and its crawled
 * pages (`CompanyContextUrlPage`), for the URL-source activities. Every one
 * is scoped by the owner's organization, and writes keyed by id return
 * whether a row matched: a source deleted mid-crawl takes its pages with it.
 */
export interface CompanyLinkCrawlStore {
	readonly owner: CompanyContextOwner;
	/** PENDING rows for the URLs a crawl is about to fetch; idempotent. */
	createPages(
		sourceId: string,
		pageUrls: readonly string[],
	): Promise<{ createdCount: number; existingCount: number }>;
	/** Store one fetched page; `force` rewrites unchanged content too. */
	upsertPage(page: {
		sourceId: string;
		pageUrl: string;
		pageTitle: string | null;
		content: string;
		etag?: string;
		lastModifiedHeader?: string;
		force: boolean;
	}): Promise<UpsertCompanyContextUrlPageResult>;
	/** A page's status and index markers, or null when the page is gone. */
	getPageEmbedding(pageId: string): Promise<CompanyUrlPageEmbedding | null>;
	listPages(sourceId: string): Promise<{ id: string; pageUrl: string }[]>;
	markPageEmbedded(
		pageId: string,
		embedding: {
			embeddingModel: string;
			qdrantId: string | null;
			chunkCount: number;
		},
	): Promise<boolean>;
	/** Complete a page with no text: no chunks, and no index markers. */
	completeEmptyPage(pageId: string): Promise<boolean>;
	/**
	 * Fail a page. With `pointsRemoved` its index markers go too, so it is
	 * never read as holding vectors it no longer has.
	 */
	recordPageFailure(
		pageId: string,
		message: string,
		options?: { pointsRemoved?: boolean },
	): Promise<boolean>;
	/** Delete the pages a crawl no longer returned; empty `keptUrls` deletes none. */
	prunePages(
		sourceId: string,
		keptUrls: readonly string[],
	): Promise<{ deletedPageIds: string[] }>;
	/** Settle the PENDING pages without vectors a finished crawl left. */
	cancelUnfinishedPages(sourceId: string): Promise<number>;
	/** How many of the source's pages hold vectors of `embeddingModel`. */
	countEmbeddedPages(
		sourceId: string,
		embeddingModel: string,
	): Promise<number>;
	/** The source's status, index marker, cadence and crawl slot, or null. */
	getCrawlState(
		sourceId: string,
	): Promise<CompanyLinkSourceCrawlState | null>;
	/**
	 * Claim the source's crawl slot (`urlActiveWorkflowId`) for this crawl:
	 * granted when it is free or already this crawl's, or — with `replacing`
	 * — still names a crawl the caller found finished.
	 */
	claimCrawl(
		sourceId: string,
		workflowId: string,
		options?: { replacing?: string },
	): Promise<boolean>;
	/**
	 * Record a crawl's outcome — status, error, single-page content, the sync
	 * timestamps, the embedding model — and free the crawl slot, in one write
	 * that matches only while the slot is free or names this crawl. False
	 * when the source is gone or another crawl holds it.
	 */
	finalizeCrawl(
		sourceId: string,
		data: CompanyCrawlFinalizeData,
	): Promise<boolean>;
	/**
	 * Settle a crawl that will not run, so its source is not left looking
	 * in flight. Matches only a source still PENDING or EXTRACTING whose
	 * in-flight slot is free or names this workflow, so it never touches a
	 * finished source or another run's crawl.
	 */
	releaseCrawl(
		sourceId: string,
		release: {
			workflowId: string;
			status: ExtractionStatus;
			message: string;
		},
	): Promise<boolean>;
}

/** Index markers a page loses with its points. */
const CLEARED_PAGE_EMBEDDING = {
	embeddedAt: null,
	embeddingModel: null,
	qdrantId: null,
	chunkCount: 0,
} as const;

/** The crawl store of a company owner. */
export function companyLinkCrawlStore(
	owner: CompanyContextOwner,
): CompanyLinkCrawlStore {
	const { organizationId } = owner;
	return {
		owner,
		createPages: (sourceId, pageUrls) =>
			createCompanyContextUrlPages({
				parentSourceId: sourceId,
				organizationId,
				pageUrls,
			}),
		upsertPage: (page) =>
			upsertCompanyContextUrlPage({
				parentSourceId: page.sourceId,
				organizationId,
				pageUrl: page.pageUrl,
				pageTitle: page.pageTitle,
				content: page.content,
				etag: page.etag ?? null,
				lastModifiedHeader: page.lastModifiedHeader ?? null,
				force: page.force,
			}),
		getPageEmbedding: (pageId) =>
			db.companyContextUrlPage.findFirst({
				where: { id: pageId, organizationId },
				select: {
					extractionStatus: true,
					embeddedAt: true,
					embeddingModel: true,
				},
			}),
		listPages: async (sourceId) =>
			(await listCompanyContextUrlPages(sourceId, organizationId)).map(
				(page) => ({ id: page.id, pageUrl: page.pageUrl }),
			),
		markPageEmbedded: (pageId, embedding) =>
			markCompanyContextUrlPageEmbedded(
				pageId,
				organizationId,
				embedding,
			),
		completeEmptyPage: async (pageId) => {
			const { count } = await db.companyContextUrlPage.updateMany({
				where: { id: pageId, organizationId },
				data: {
					...CLEARED_PAGE_EMBEDDING,
					extractionStatus: "COMPLETED",
					extractionError: null,
				},
			});
			return count > 0;
		},
		recordPageFailure: async (pageId, message, options) => {
			const { count } = await db.companyContextUrlPage.updateMany({
				where: { id: pageId, organizationId },
				data: {
					...(options?.pointsRemoved ? CLEARED_PAGE_EMBEDDING : {}),
					extractionStatus: "FAILED",
					extractionError: message,
				},
			});
			return count > 0;
		},
		prunePages: (sourceId, keptUrls) =>
			pruneCompanyContextUrlPages({
				parentSourceId: sourceId,
				organizationId,
				keptUrls,
			}),
		cancelUnfinishedPages: (sourceId) =>
			cancelUnfinishedCompanyContextUrlPages(sourceId, organizationId),
		countEmbeddedPages: (sourceId, embeddingModel) =>
			countCompanyContextUrlPagesEmbeddedWith({
				parentSourceId: sourceId,
				organizationId,
				embeddingModel,
			}),
		getCrawlState: (sourceId) =>
			getCompanyLinkSourceCrawlState(sourceId, organizationId),
		claimCrawl: (sourceId, workflowId, options) =>
			claimCompanyLinkSourceCrawl({
				id: sourceId,
				organizationId,
				workflowId,
				...(options?.replacing ? { replacing: options.replacing } : {}),
			}),
		finalizeCrawl: (sourceId, { workflowId, ...outcome }) =>
			finalizeCompanyLinkSourceCrawl({
				id: sourceId,
				organizationId,
				workflowId,
				outcome,
			}),
		releaseCrawl: async (sourceId, { workflowId, status, message }) => {
			const { count } = await db.companyContextSource.updateMany({
				where: {
					id: sourceId,
					organizationId,
					type: "LINK",
					extractionStatus: { in: ["PENDING", "EXTRACTING"] },
					OR: [
						{ urlActiveWorkflowId: null },
						{ urlActiveWorkflowId: workflowId },
					],
				},
				data: {
					extractionStatus: status,
					extractionError: message,
					urlActiveWorkflowId: null,
				},
			});
			return count > 0;
		},
	};
}
