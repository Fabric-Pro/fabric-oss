/**
 * Company context (Fizzy #2719): the query layer for `CompanyContextSource`
 * and `CompanyContextUrlPage` — the material an organization maintains once
 * about itself for Proposal and Business Case generation.
 *
 * Every helper takes the organization id and puts it in the WHERE, or on the
 * row it creates. There is no unscoped by-id read or write: a source or page
 * id alone never reaches a row. A page is written only under the organization
 * its parent belongs to, which the database also enforces through the
 * composite foreign key `company_context_url_page_owner_fkey`.
 *
 * Authorization — who may read or change an organization's company context —
 * is the caller's job and must happen before any of this is reached. So is
 * the `COMPANY_CONTEXT` gate.
 *
 * Writes keyed by id return whether a row matched instead of throwing: a
 * source deleted while its ingestion is in flight is a normal event, and the
 * caller decides what a miss means.
 */

import {
	db,
	type ExtractionStatus,
	Prisma,
	type ProjectContextType,
} from "../client";
import type {
	CompanyContextSource,
	CompanyContextUrlPage,
	UrlRefreshMode,
	UrlSourceScope,
} from "../generated/client";
import {
	contextContentHashOrNull,
	hashContextContent,
} from "./projects/context-content-hash";
import {
	buildIndexingFailureUpdate,
	type ContextMetadataField,
	type ContextMetadataValues,
	type IndexingFailureOptions,
	normalizeContextMetadataValue,
} from "./projects/contexts";
import {
	urlPageFetchFailureRestorableWhere,
	urlPageFetchFailureWritableWhere,
} from "./url-page-fetch-failure";

export type CompanyContextSourceRecord = CompanyContextSource;
/** A source row without its `content`, which can be a long text. */
export type CompanyContextSourceMetaRecord = Omit<
	CompanyContextSource,
	"content"
>;
export type CompanyContextUrlPageRecord = CompanyContextUrlPage;

/**
 * The source kinds company context accepts in Layer 1. Later layers add
 * INTEGRATION. The column reuses `ProjectContextType`, so the API validates
 * against this list; the database does not.
 */
export const COMPANY_CONTEXT_SOURCE_TYPES = ["FILE", "TEXT", "LINK"] as const;
export type CompanyContextSourceType =
	(typeof COMPANY_CONTEXT_SOURCE_TYPES)[number];

// ============================================================================
// Storage
// ============================================================================

/**
 * The storage sub-path company files live under. With `buildTenantStoragePath`
 * a key is `{organizationId}/company-context/…` in the project-contexts
 * bucket, which organization deletion sweeps.
 */
export const COMPANY_CONTEXT_STORAGE_SEGMENT = "company-context";

/** The object-key prefix holding one organization's company files. */
export function companyContextStoragePrefix(organizationId: string): string {
	if (!organizationId) {
		// An empty id would widen the prefix to every organization's files.
		throw new Error(
			"companyContextStoragePrefix requires an organizationId",
		);
	}
	return `${organizationId}/${COMPANY_CONTEXT_STORAGE_SEGMENT}/`;
}

// ============================================================================
// Reads
// ============================================================================

/**
 * What a list shows for each source: everything but `content`, plus the
 * number of crawled pages under a LINK source.
 */
const SOURCE_LIST_SELECT = {
	id: true,
	organizationId: true,
	type: true,
	metadata: true,
	embeddedAt: true,
	embeddingModel: true,
	originalFilename: true,
	mimeType: true,
	fileSize: true,
	extractionStatus: true,
	extractionError: true,
	extractedAt: true,
	deletingAt: true,
	sourceUrl: true,
	sourceTitle: true,
	urlScope: true,
	urlMaxPages: true,
	urlRefreshMode: true,
	urlNextRefreshAt: true,
	urlLastSyncedAt: true,
	urlActiveWorkflowId: true,
	sourceType: true,
	aiInstructions: true,
	metadataUpdatedAt: true,
	metadataUpdatedByUserId: true,
	contentHash: true,
	createdByUserId: true,
	createdAt: true,
	updatedAt: true,
	_count: { select: { urlPages: true } },
} satisfies Prisma.CompanyContextSourceSelect;

export type CompanyContextSourceListItem =
	Prisma.CompanyContextSourceGetPayload<{
		select: typeof SOURCE_LIST_SELECT;
	}>;

/** The organization's sources, newest first, without their content. */
export async function listCompanyContextSources(
	organizationId: string,
): Promise<CompanyContextSourceListItem[]> {
	return db.companyContextSource.findMany({
		where: { organizationId },
		select: SOURCE_LIST_SELECT,
		orderBy: { createdAt: "desc" },
	});
}

/** One source, content included, or null when it is not this organization's. */
export async function getCompanyContextSource(
	id: string,
	organizationId: string,
): Promise<CompanyContextSourceRecord | null> {
	return db.companyContextSource.findUnique({
		where: { id_organizationId: { id, organizationId } },
	});
}

/**
 * One source without its content, or null when it is not this organization's
 * — for the callers that act on a source's state and never read its text.
 */
export async function getCompanyContextSourceMeta(
	id: string,
	organizationId: string,
): Promise<CompanyContextSourceMetaRecord | null> {
	return db.companyContextSource.findUnique({
		where: { id_organizationId: { id, organizationId } },
		omit: { content: true },
	});
}

const URL_PAGE_LIST_SELECT = {
	id: true,
	parentSourceId: true,
	pageUrl: true,
	pageTitle: true,
	embeddedAt: true,
	embeddingModel: true,
	lastFetchedAt: true,
	contentHash: true,
	chunkCount: true,
	extractionStatus: true,
	extractionError: true,
	updatedAt: true,
} satisfies Prisma.CompanyContextUrlPageSelect;

export type CompanyContextUrlPageListItem =
	Prisma.CompanyContextUrlPageGetPayload<{
		select: typeof URL_PAGE_LIST_SELECT;
	}>;

/** The crawled pages of one LINK source, without their content. */
export async function listCompanyContextUrlPages(
	parentSourceId: string,
	organizationId: string,
): Promise<CompanyContextUrlPageListItem[]> {
	return db.companyContextUrlPage.findMany({
		where: { parentSourceId, organizationId },
		select: URL_PAGE_LIST_SELECT,
		orderBy: { pageUrl: "asc" },
	});
}

/** Where a crawling LINK source's pages stand, read in one query. */
export interface CompanyContextCrawlPageSummary {
	/** The pages found so far. */
	totalPages: number;
	/** Those done: indexed, or failed to index. */
	processedPages: number;
	/** When the crawl last fetched one of them; null before any fetch. */
	lastFetchedAt: Date | null;
}

/** The page statuses a crawl has finished with. */
const PROCESSED_PAGE_STATUSES: ExtractionStatus[] = ["COMPLETED", "FAILED"];

/**
 * Each LINK source's page summary, by source id; a source with no pages is
 * absent. A crawl creates every page it found as PENDING before it starts,
 * and stamps `lastFetchedAt` on every page it fetches, changed or not. A
 * CANCELLED page is still to do: only a crawl's end cancels its unfinished
 * pages, after it has let go of the source, so one seen while a crawl holds
 * the source is left from an earlier crawl, and this one fetches it again.
 * All three figures come from one grouped read, so they agree with each
 * other. No query when no source is given.
 */
export async function summarizeCompanyContextCrawlPages(input: {
	organizationId: string;
	parentSourceIds: string[];
}): Promise<Map<string, CompanyContextCrawlPageSummary>> {
	const { organizationId, parentSourceIds } = input;
	const summaries = new Map<string, CompanyContextCrawlPageSummary>();
	if (parentSourceIds.length === 0) {
		return summaries;
	}
	const groups = await db.companyContextUrlPage.groupBy({
		by: ["parentSourceId", "extractionStatus"],
		where: { organizationId, parentSourceId: { in: parentSourceIds } },
		_count: { _all: true },
		_max: { lastFetchedAt: true },
	});
	for (const group of groups) {
		const summary = summaries.get(group.parentSourceId) ?? {
			totalPages: 0,
			processedPages: 0,
			lastFetchedAt: null,
		};
		summary.totalPages += group._count._all;
		if (PROCESSED_PAGE_STATUSES.includes(group.extractionStatus)) {
			summary.processedPages += group._count._all;
		}
		const fetchedAt = group._max.lastFetchedAt;
		if (
			fetchedAt &&
			(!summary.lastFetchedAt || fetchedAt > summary.lastFetchedAt)
		) {
			summary.lastFetchedAt = fetchedAt;
		}
		summaries.set(group.parentSourceId, summary);
	}
	return summaries;
}

/** One crawled page, content included, or null when it is not this organization's. */
export async function getCompanyContextUrlPage(
	pageId: string,
	organizationId: string,
): Promise<CompanyContextUrlPageRecord | null> {
	return db.companyContextUrlPage.findFirst({
		where: { id: pageId, organizationId },
	});
}

/**
 * The organization's LINK sources that hold a Temporal refresh schedule, for
 * the paths that pause, resume or delete those schedules together.
 */
export async function listCompanyContextUrlScheduleIds(
	organizationId: string,
): Promise<{ id: string; urlScheduleId: string }[]> {
	const rows = await db.companyContextSource.findMany({
		where: { organizationId, urlScheduleId: { not: null } },
		select: { id: true, urlScheduleId: true },
	});
	return rows.flatMap((row) =>
		row.urlScheduleId
			? [{ id: row.id, urlScheduleId: row.urlScheduleId }]
			: [],
	);
}

// ============================================================================
// Ready for retrieval
// ============================================================================

/**
 * The one definition of a company source that is ready for retrieval. The
 * page, the empty-context notice and retrieval all read it from here, so they
 * cannot disagree about what "ready" means.
 *
 * A source is ready when its processing COMPLETED and it is embedded with the
 * organization's current embedding model — `embeddingModel` is that model's
 * identity as the caller resolved it. Vectors written by another model live in
 * a different embedding space and cannot be searched with this one's queries,
 * so a source embedded before a model switch is not ready until re-embedded.
 *
 * For a LINK source every crawled page must agree too: a page holding vectors
 * must hold the current model's, or it keeps its source out. A page holding
 * none passes whatever its status, because it adds nothing to a search — an
 * empty or failed page, a URL a crawl mapped but has not fetched yet, or one a
 * cancelled crawl never reached. That is deliberate: a scheduled refresh adds
 * a PENDING page for every URL it newly finds, and a website that was ready
 * stays ready while the refresh runs, serving the pages it already has. A
 * crawl the API starts (the first one, a re-sync, a re-process) sets the
 * source itself PENDING, which keeps it out until that crawl finishes. A
 * multi-page LINK parent holds no vectors of its own; ingestion stamps it
 * with the model its pages were embedded with when the crawl finalizes.
 *
 * And a source that has crawled pages must have at least one holding the
 * current model's vectors: a website none of whose pages could be indexed
 * has nothing to search, whatever its own markers say. A source with no
 * page rows — a file, a text, a single page — is not affected.
 *
 * A source being deleted (`deletingAt` set) is never ready, whatever its
 * status and markers say — an embed that finishes after the delete started
 * cannot put it back into retrieval.
 */
export function companyContextReadyWhere(
	embeddingModel: string,
): Prisma.CompanyContextSourceWhereInput {
	if (!embeddingModel) {
		throw new Error("companyContextReadyWhere requires an embedding model");
	}
	return {
		extractionStatus: "COMPLETED",
		embeddedAt: { not: null },
		embeddingModel,
		deletingAt: null,
		AND: [
			{
				urlPages: {
					every: {
						OR: [
							{ embeddedAt: { not: null }, embeddingModel },
							{ embeddedAt: null },
						],
					},
				},
			},
			{
				OR: [
					{ urlPages: { none: {} } },
					{
						urlPages: {
							some: { embeddedAt: { not: null }, embeddingModel },
						},
					},
				],
			},
		],
	};
}

/** Ids of the organization's sources that are ready for retrieval. */
export async function listReadyCompanyContextSourceIds(
	organizationId: string,
	embeddingModel: string,
): Promise<string[]> {
	const rows = await db.companyContextSource.findMany({
		where: { organizationId, ...companyContextReadyWhere(embeddingModel) },
		select: { id: true },
	});
	return rows.map((row) => row.id);
}

/**
 * How many sources the organization has, and how many are ready. Zero total
 * is "no sources yet"; a total with none ready is "sources not ready yet".
 */
export async function getCompanyContextReadiness(
	organizationId: string,
	embeddingModel: string,
): Promise<{ total: number; ready: number }> {
	const readyWhere = companyContextReadyWhere(embeddingModel);
	const [total, ready] = await Promise.all([
		db.companyContextSource.count({ where: { organizationId } }),
		db.companyContextSource.count({
			where: { organizationId, ...readyWhere },
		}),
	]);
	return { total, ready };
}

// ============================================================================
// Creates
// ============================================================================

interface CompanyContextSourceBaseInput {
	organizationId: string;
	/** Creator provenance; SetNull when that user is deleted. */
	createdByUserId: string | null;
	sourceType?: string | null;
	aiInstructions?: string | null;
	metadata?: Prisma.InputJsonValue;
}

function baseCreateData(input: CompanyContextSourceBaseInput) {
	return {
		organizationId: input.organizationId,
		createdByUserId: input.createdByUserId,
		sourceType: normalizeContextMetadataValue(input.sourceType),
		aiInstructions: normalizeContextMetadataValue(input.aiInstructions),
		metadata: input.metadata ?? {},
	};
}

/** A pasted-text source, pending its embedding. */
export async function createCompanyTextSource(
	input: CompanyContextSourceBaseInput & {
		content: string;
		sourceTitle?: string | null;
	},
): Promise<CompanyContextSourceRecord> {
	return db.companyContextSource.create({
		data: {
			...baseCreateData(input),
			type: "TEXT",
			content: input.content,
			contentHash: contextContentHashOrNull(input.content),
			sourceTitle: input.sourceTitle ?? null,
		},
	});
}

/** An uploaded file, pending extraction. */
export async function createCompanyFileSource(
	input: CompanyContextSourceBaseInput & {
		/** FILE unless the upload path classifies it more narrowly. */
		type?: ProjectContextType;
		s3Path: string;
		s3Bucket: string;
		originalFilename: string;
		mimeType: string;
		fileSize: number;
	},
): Promise<CompanyContextSourceRecord> {
	return db.companyContextSource.create({
		data: {
			...baseCreateData(input),
			type: input.type ?? "FILE",
			content: "",
			s3Path: input.s3Path,
			s3Bucket: input.s3Bucket,
			originalFilename: input.originalFilename,
			mimeType: input.mimeType,
			fileSize: input.fileSize,
		},
	});
}

/** A website source, pending its first crawl. */
export async function createCompanyLinkSource(
	input: CompanyContextSourceBaseInput & {
		sourceUrl: string;
		sourceTitle?: string | null;
		urlScope?: UrlSourceScope;
		urlMaxPages?: number;
		urlRefreshMode?: UrlRefreshMode;
		urlNextRefreshAt?: Date | null;
	},
): Promise<CompanyContextSourceRecord> {
	return db.companyContextSource.create({
		data: {
			...baseCreateData(input),
			type: "LINK",
			content: "",
			sourceUrl: input.sourceUrl,
			sourceTitle: input.sourceTitle ?? null,
			urlScope: input.urlScope,
			urlMaxPages: input.urlMaxPages,
			urlRefreshMode: input.urlRefreshMode,
			urlNextRefreshAt: input.urlNextRefreshAt ?? null,
		},
	});
}

// ============================================================================
// Ingestion writes
// ============================================================================

/** The statuses of a source that a run is still processing. */
const IN_FLIGHT_STATUSES: ExtractionStatus[] = ["PENDING", "EXTRACTING"];

/**
 * Record a source's processing status, and optionally the content extraction
 * produced. Mirrors `updateContextExtractionStatus`: COMPLETED stamps
 * `extractedAt`, a content write carries its hash, and `extractionError: null`
 * clears an earlier failure's message.
 *
 * COMPLETED never lands on a source being deleted: a run that finishes after
 * the delete started matches nothing, as it would once the row is gone.
 */
export async function updateCompanyContextSourceStatus(
	id: string,
	organizationId: string,
	status: ExtractionStatus,
	data?: {
		content?: string;
		extractionError?: string | null;
		sourceTitle?: string;
		metadata?: Prisma.InputJsonValue;
	},
): Promise<boolean> {
	const { count } = await db.companyContextSource.updateMany({
		where: {
			id,
			organizationId,
			...(status === "COMPLETED" ? { deletingAt: null } : {}),
		},
		data: {
			extractionStatus: status,
			...(status === "COMPLETED" ? { extractedAt: new Date() } : {}),
			...(data?.content !== undefined
				? {
						content: data.content,
						contentHash: contextContentHashOrNull(data.content),
					}
				: {}),
			...(data?.extractionError !== undefined
				? { extractionError: data.extractionError }
				: {}),
			...(data?.sourceTitle !== undefined
				? { sourceTitle: data.sourceTitle }
				: {}),
			...(data?.metadata !== undefined
				? { metadata: data.metadata }
				: {}),
		},
	});
	return count > 0;
}

/**
 * Claim a source for re-processing, or a website for a re-sync: set it
 * PENDING and clear an earlier run's message, in one write that matches only
 * while nothing processes it — its status is not PENDING or EXTRACTING and no
 * crawl holds its slot — and it is not being deleted. Of two requests racing
 * for one idle source exactly one wins, so two runs never replace the same
 * source's points at once. Returns whether this call claimed it.
 */
export async function claimCompanyContextSourceForReprocess(input: {
	id: string;
	organizationId: string;
}): Promise<boolean> {
	const { id, organizationId } = input;
	const { count } = await db.companyContextSource.updateMany({
		where: {
			id,
			organizationId,
			extractionStatus: { notIn: IN_FLIGHT_STATUSES },
			urlActiveWorkflowId: null,
			deletingAt: null,
		},
		data: { extractionStatus: "PENDING", extractionError: null },
	});
	return count > 0;
}

/**
 * Claim an uploaded file for its first processing run: set it EXTRACTING, in
 * one write that matches only while the file still waits for that run
 * (PENDING) and is not being deleted. Of two requests racing for one file
 * exactly one wins, and a delete that tombstones the file first keeps the run
 * from starting at all. Returns whether this call claimed it.
 */
export async function claimCompanyFileSourceForProcessing(input: {
	id: string;
	organizationId: string;
}): Promise<boolean> {
	const { id, organizationId } = input;
	const { count } = await db.companyContextSource.updateMany({
		where: {
			id,
			organizationId,
			type: "FILE",
			extractionStatus: "PENDING",
			deletingAt: null,
		},
		data: { extractionStatus: "EXTRACTING" },
	});
	return count > 0;
}

/**
 * Give back a source a request set in motion when the run it was set in
 * motion for cannot start: put its status back, or mark it FAILED with why.
 * Matches only while the source is not being deleted — a delete that
 * tombstoned it in the meantime owns its status from then on, so the status
 * and message saying it is going stay as the delete wrote them. Never
 * COMPLETED: nothing ran. Returns whether the write landed.
 */
export async function releaseCompanyContextSourceClaim(input: {
	id: string;
	organizationId: string;
	status: Exclude<ExtractionStatus, "COMPLETED">;
	/** `null` clears a message; omitted leaves it alone. */
	extractionError?: string | null;
}): Promise<boolean> {
	const { id, organizationId, status, extractionError } = input;
	const { count } = await db.companyContextSource.updateMany({
		where: { id, organizationId, deletingAt: null },
		data: {
			extractionStatus: status,
			...(extractionError !== undefined ? { extractionError } : {}),
		},
	});
	return count > 0;
}

/**
 * Record that a source is embedded, and with which model. `embeddedAt` and
 * `embeddingModel` are always written together — readiness reads both.
 *
 * Matches nothing on a source being deleted, as on one already gone: the
 * caller then removes the points it just wrote, which belong to nothing.
 */
export async function markCompanyContextSourceEmbedded(
	id: string,
	organizationId: string,
	embedding: { embeddingModel: string; qdrantId?: string | null },
): Promise<boolean> {
	if (!embedding.embeddingModel) {
		throw new Error(
			"markCompanyContextSourceEmbedded requires an embedding model",
		);
	}
	const { count } = await db.companyContextSource.updateMany({
		where: { id, organizationId, deletingAt: null },
		data: {
			embeddedAt: new Date(),
			embeddingModel: embedding.embeddingModel,
			...(embedding.qdrantId !== undefined
				? { qdrantId: embedding.qdrantId }
				: {}),
		},
	});
	return count > 0;
}

/**
 * Forget a source's index markers — for a re-embed that has removed its
 * points. The source reads as not ready until it is marked embedded again.
 */
export async function clearCompanyContextSourceEmbedding(
	id: string,
	organizationId: string,
): Promise<boolean> {
	const { count } = await db.companyContextSource.updateMany({
		where: { id, organizationId },
		data: { embeddedAt: null, embeddingModel: null, qdrantId: null },
	});
	return count > 0;
}

/**
 * Record that search indexing failed, without lying about whether the content
 * was extracted — the same rule as `recordContextIndexingFailure`. With
 * `pointsRemoved` the index markers are cleared as well.
 */
export async function recordCompanyContextSourceIndexingFailure(
	id: string,
	organizationId: string,
	message: string,
	options?: IndexingFailureOptions,
): Promise<boolean> {
	return db.$transaction(async (tx) => {
		const existing = await tx.companyContextSource.findUnique({
			where: { id_organizationId: { id, organizationId } },
			select: { extractionStatus: true },
		});
		if (!existing) {
			return false;
		}
		const update = buildIndexingFailureUpdate(
			existing.extractionStatus,
			message,
			options,
		);
		const { count } = await tx.companyContextSource.updateMany({
			where: { id, organizationId },
			data: {
				...update,
				...(options?.pointsRemoved ? { embeddingModel: null } : {}),
			},
		});
		return count > 0;
	});
}

/** The crawl bookkeeping of a LINK source; `undefined` leaves a field alone. */
export interface CompanyLinkSourceCrawlPatch {
	urlScope?: UrlSourceScope | null;
	urlMaxPages?: number | null;
	urlRefreshMode?: UrlRefreshMode | null;
	urlNextRefreshAt?: Date | null;
	urlLastSyncedAt?: Date | null;
	urlScheduleId?: string | null;
	urlActiveWorkflowId?: string | null;
}

/**
 * Update a LINK source's crawl configuration, schedule and in-flight crawl.
 * Matches LINK sources only, so crawl state never lands on a file or text row.
 */
export async function updateCompanyLinkSourceCrawlState(
	id: string,
	organizationId: string,
	patch: CompanyLinkSourceCrawlPatch,
): Promise<boolean> {
	const { count } = await db.companyContextSource.updateMany({
		where: { id, organizationId, type: "LINK" },
		data: patch,
	});
	return count > 0;
}

// ============================================================================
// The in-flight crawl of a LINK source
// ============================================================================
//
// `urlActiveWorkflowId` is the crawl slot of a LINK source: the workflow id of
// the one crawl allowed to write the source and its pages. A crawl claims it
// before it fetches anything, a crawl that cannot claim it does not run, and
// finishing frees it. The crawl's writes here match only while the slot is
// free or names that crawl, so one crawl never finalizes a source another
// crawl holds. Neither the claim nor the finalize matches a source being
// deleted, so no crawl starts on one, or marks one crawled.

const LINK_CRAWL_STATE_SELECT = {
	extractionStatus: true,
	embeddedAt: true,
	urlRefreshMode: true,
	urlActiveWorkflowId: true,
} satisfies Prisma.CompanyContextSourceSelect;

export type CompanyLinkSourceCrawlState =
	Prisma.CompanyContextSourceGetPayload<{
		select: typeof LINK_CRAWL_STATE_SELECT;
	}>;

/** What a crawl reads to decide how it may start and finish, or null. */
export async function getCompanyLinkSourceCrawlState(
	id: string,
	organizationId: string,
): Promise<CompanyLinkSourceCrawlState | null> {
	return db.companyContextSource.findFirst({
		where: { id, organizationId, type: "LINK" },
		select: LINK_CRAWL_STATE_SELECT,
	});
}

/**
 * Claim a LINK source's crawl slot for `workflowId`. It is granted when the
 * slot is free or already names this crawl — the API records a crawl it
 * started after the start, so either write may land first — and, with
 * `replacing`, when the slot still names that crawl, which the caller has
 * found finished. With `onlyWhileInFlight` it is granted only while the
 * source is still PENDING or EXTRACTING: the API's record of a crawl it
 * started must not refill the slot of a crawl that already finished. Never
 * granted on a source being deleted. Returns whether this crawl holds the
 * slot now.
 */
export async function claimCompanyLinkSourceCrawl(input: {
	id: string;
	organizationId: string;
	workflowId: string;
	replacing?: string;
	onlyWhileInFlight?: boolean;
}): Promise<boolean> {
	const { id, organizationId, workflowId, replacing, onlyWhileInFlight } =
		input;
	if (!workflowId) {
		throw new Error("claimCompanyLinkSourceCrawl requires a workflow id");
	}
	const { count } = await db.companyContextSource.updateMany({
		where: {
			id,
			organizationId,
			type: "LINK",
			deletingAt: null,
			...(onlyWhileInFlight
				? { extractionStatus: { in: IN_FLIGHT_STATUSES } }
				: {}),
			OR: [
				{ urlActiveWorkflowId: null },
				{ urlActiveWorkflowId: workflowId },
				...(replacing ? [{ urlActiveWorkflowId: replacing }] : []),
			],
		},
		data: { urlActiveWorkflowId: workflowId },
	});
	return count > 0;
}

/** What a finishing crawl records; `undefined` leaves a field alone. */
export interface CompanyLinkSourceCrawlOutcome {
	status?: ExtractionStatus;
	/** `null` clears a message an earlier run left. */
	extractionError?: string | null;
	/** A single page's markdown, which lives on the source itself. */
	content?: string;
	urlLastSyncedAt?: Date | null;
	urlNextRefreshAt?: Date | null;
	/** Mark the source embedded with this model. */
	embeddingModel?: string;
}

/**
 * Record a crawl's outcome on its LINK source and free the slot, in one write
 * that matches only while the slot is free or names this crawl and the
 * source is not being deleted. Returns false when the source is gone, being
 * deleted, or another crawl holds it; nothing is written then.
 *
 * The status, content and embedding writes follow
 * `updateCompanyContextSourceStatus` and `markCompanyContextSourceEmbedded`:
 * COMPLETED stamps `extractedAt`, content carries its hash, and the model is
 * written with `embeddedAt`.
 */
export async function finalizeCompanyLinkSourceCrawl(input: {
	id: string;
	organizationId: string;
	workflowId: string;
	outcome: CompanyLinkSourceCrawlOutcome;
}): Promise<boolean> {
	const { id, organizationId, workflowId, outcome } = input;
	if (!workflowId) {
		throw new Error(
			"finalizeCompanyLinkSourceCrawl requires a workflow id",
		);
	}
	const now = new Date();
	const { count } = await db.companyContextSource.updateMany({
		where: {
			id,
			organizationId,
			type: "LINK",
			deletingAt: null,
			OR: [
				{ urlActiveWorkflowId: null },
				{ urlActiveWorkflowId: workflowId },
			],
		},
		data: {
			urlActiveWorkflowId: null,
			...(outcome.status !== undefined
				? {
						extractionStatus: outcome.status,
						...(outcome.status === "COMPLETED"
							? { extractedAt: now }
							: {}),
					}
				: {}),
			...(outcome.extractionError !== undefined
				? { extractionError: outcome.extractionError }
				: {}),
			...(outcome.content !== undefined
				? {
						content: outcome.content,
						contentHash: contextContentHashOrNull(outcome.content),
					}
				: {}),
			...(outcome.urlLastSyncedAt !== undefined
				? { urlLastSyncedAt: outcome.urlLastSyncedAt }
				: {}),
			...(outcome.urlNextRefreshAt !== undefined
				? { urlNextRefreshAt: outcome.urlNextRefreshAt }
				: {}),
			...(outcome.embeddingModel
				? { embeddedAt: now, embeddingModel: outcome.embeddingModel }
				: {}),
		},
	});
	return count > 0;
}

// ============================================================================
// Crawled pages
// ============================================================================

/**
 * Create a PENDING row for every URL not already under the source. Idempotent:
 * the (parentSourceId, pageUrl) unique key makes a concurrent re-sync skip
 * rather than duplicate. Returns how many rows this call created.
 */
export async function createCompanyContextUrlPages(input: {
	parentSourceId: string;
	organizationId: string;
	pageUrls: readonly string[];
}): Promise<{ createdCount: number; existingCount: number }> {
	const { parentSourceId, organizationId } = input;
	const pageUrls = [...new Set(input.pageUrls)];
	if (pageUrls.length === 0) {
		return { createdCount: 0, existingCount: 0 };
	}
	const existing = await db.companyContextUrlPage.findMany({
		where: { parentSourceId, organizationId, pageUrl: { in: pageUrls } },
		select: { pageUrl: true },
	});
	const present = new Set(existing.map((row) => row.pageUrl));
	const toCreate = pageUrls.filter((pageUrl) => !present.has(pageUrl));
	if (toCreate.length === 0) {
		return { createdCount: 0, existingCount: present.size };
	}
	const { count } = await db.companyContextUrlPage.createMany({
		data: toCreate.map((pageUrl) => ({
			parentSourceId,
			organizationId,
			pageUrl,
			content: "",
			contentHash: "",
			extractionStatus: "PENDING" as const,
		})),
		skipDuplicates: true,
	});
	return { createdCount: count, existingCount: present.size };
}

export interface UpsertCompanyContextUrlPageResult {
	pageId: string;
	contentHash: string;
	/**
	 * True when the stored content already matched and this was not a forced
	 * write, so the content needs no re-embed. Whether the page holds that
	 * content's vectors is its status and index markers, which the caller
	 * reads.
	 */
	unchanged: boolean;
}

/**
 * Store one fetched page under its source. An existing page whose content hash
 * matches keeps its content and embedding unless `force` is set (the manual
 * re-sync path); any content write resets the page to PENDING for embedding.
 *
 * A matching page that a failed fetch marked FAILED, and that still holds
 * vectors, is COMPLETED again with its reason cleared
 * (`urlPageFetchFailureRestorableWhere`): its indexed content is the content
 * just fetched. Any other page keeps its status.
 */
export async function upsertCompanyContextUrlPage(input: {
	parentSourceId: string;
	organizationId: string;
	pageUrl: string;
	pageTitle?: string | null;
	content: string;
	etag?: string | null;
	lastModifiedHeader?: string | null;
	force?: boolean;
}): Promise<UpsertCompanyContextUrlPageResult> {
	const { parentSourceId, organizationId, pageUrl } = input;
	const contentHash = hashContextContent(input.content);
	const fetched = {
		pageTitle: input.pageTitle ?? null,
		lastFetchedAt: new Date(),
		etag: input.etag ?? null,
		lastModifiedHeader: input.lastModifiedHeader ?? null,
	};
	const contentWrite = {
		content: input.content,
		contentHash,
		extractionStatus: "PENDING" as const,
		extractionError: null,
	};

	const updateExisting = async (existing: {
		id: string;
		contentHash: string;
	}): Promise<UpsertCompanyContextUrlPageResult> => {
		const unchanged = existing.contentHash === contentHash && !input.force;
		await db.companyContextUrlPage.updateMany({
			where: { id: existing.id, organizationId },
			data: unchanged ? fetched : { ...fetched, ...contentWrite },
		});
		if (unchanged) {
			await db.companyContextUrlPage.updateMany({
				where: {
					id: existing.id,
					organizationId,
					...urlPageFetchFailureRestorableWhere(),
				},
				data: { extractionStatus: "COMPLETED", extractionError: null },
			});
		}
		return { pageId: existing.id, contentHash, unchanged };
	};

	const findExisting = () =>
		db.companyContextUrlPage.findFirst({
			where: { parentSourceId, organizationId, pageUrl },
			select: { id: true, contentHash: true },
		});

	const existing = await findExisting();
	if (existing) {
		return updateExisting(existing);
	}
	try {
		const created = await db.companyContextUrlPage.create({
			data: {
				parentSourceId,
				organizationId,
				pageUrl,
				...fetched,
				...contentWrite,
			},
			select: { id: true },
		});
		return { pageId: created.id, contentHash, unchanged: false };
	} catch (error) {
		// A concurrent writer created the same page first: update theirs.
		if (
			error instanceof Prisma.PrismaClientKnownRequestError &&
			error.code === "P2002"
		) {
			const raced = await findExisting();
			if (raced) {
				return updateExisting(raced);
			}
		}
		throw error;
	}
}

/** What recording a failed page fetch did, for the crawl that asked. */
export interface CompanyContextUrlPageFetchFailureResult {
	/** Whether the crawl keeps the URL from its prune. */
	kept: boolean;
	/**
	 * The page at the URL and its index markers, so the caller can remove
	 * vectors of another model; null when nothing was recorded.
	 */
	page: {
		id: string;
		embeddedAt: Date | null;
		embeddingModel: string | null;
	} | null;
}

/**
 * Record that a crawl could not fetch the page at `pageUrl` under a LINK
 * source, so the crawl keeps the page instead of pruning it. `message` is the
 * whole reason, `URL_PAGE_FETCH_FAILURE_PREFIX` included.
 *
 * - A page that holds content is marked FAILED with the message when it is
 *   COMPLETED or CANCELLED or holds no vectors
 *   (`urlPageFetchFailureWritableWhere`); any other is left as it is. Its
 *   content, hash, chunk count, fetch time and index markers never change,
 *   so a page holding vectors stays searchable. Either way it is kept.
 * - A URL with no row, or a row no fetch has written (its content hash is
 *   empty: a placeholder, or an earlier failure), gets a FAILED row with no
 *   content on a transient failure, and is kept. On a permanent failure
 *   the URL is not kept and its empty row, if any, is removed, even in a
 *   crawl that fetched no page (whose prune deletes nothing).
 * - A source that is gone or being deleted gets nothing; the URL reads as
 *   kept, the safe default, and the source's delete takes its pages with it.
 *   A delete that lands between the read and the write does the same.
 *
 * A page another writer creates first is marked as an existing one, the way
 * `upsertCompanyContextUrlPage` takes over a raced create. Recording the
 * same failure again leaves the same state.
 */
export async function recordCompanyContextUrlPageFetchFailure(input: {
	parentSourceId: string;
	organizationId: string;
	pageUrl: string;
	message: string;
	permanent: boolean;
}): Promise<CompanyContextUrlPageFetchFailureResult> {
	const { parentSourceId, organizationId, pageUrl, message, permanent } =
		input;
	const nothingRecorded: CompanyContextUrlPageFetchFailureResult = {
		kept: true,
		page: null,
	};
	const notKept: CompanyContextUrlPageFetchFailureResult = {
		kept: false,
		page: null,
	};

	const source = await db.companyContextSource.findFirst({
		where: {
			id: parentSourceId,
			organizationId,
			type: "LINK",
			deletingAt: null,
		},
		select: { id: true },
	});
	if (!source) {
		return nothingRecorded;
	}

	const findPage = () =>
		db.companyContextUrlPage.findFirst({
			where: { parentSourceId, organizationId, pageUrl },
			select: {
				id: true,
				contentHash: true,
				embeddedAt: true,
				embeddingModel: true,
			},
		});

	const markExisting = async (existing: {
		id: string;
		contentHash: string;
		embeddedAt: Date | null;
		embeddingModel: string | null;
	}): Promise<CompanyContextUrlPageFetchFailureResult> => {
		if (permanent && existing.contentHash === "") {
			// Removed here rather than by the prune, which deletes nothing
			// when the crawl fetched no page at all.
			await db.companyContextUrlPage.deleteMany({
				where: {
					id: existing.id,
					parentSourceId,
					organizationId,
					contentHash: "",
					embeddedAt: null,
				},
			});
			return notKept;
		}
		await db.companyContextUrlPage.updateMany({
			where: {
				id: existing.id,
				organizationId,
				...urlPageFetchFailureWritableWhere(),
			},
			data: { extractionStatus: "FAILED", extractionError: message },
		});
		return {
			kept: true,
			page: {
				id: existing.id,
				embeddedAt: existing.embeddedAt,
				embeddingModel: existing.embeddingModel,
			},
		};
	};

	const existing = await findPage();
	if (existing) {
		return markExisting(existing);
	}
	if (permanent) {
		return notKept;
	}
	try {
		const created = await db.companyContextUrlPage.create({
			data: {
				parentSourceId,
				organizationId,
				pageUrl,
				content: "",
				contentHash: "",
				extractionStatus: "FAILED",
				extractionError: message,
			},
			select: { id: true },
		});
		return {
			kept: true,
			page: { id: created.id, embeddedAt: null, embeddingModel: null },
		};
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError) {
			// The source was deleted since it was read.
			if (error.code === "P2003") {
				return nothingRecorded;
			}
			// A concurrent writer created the same page first: mark theirs.
			if (error.code === "P2002") {
				const raced = await findPage();
				if (raced) {
					return markExisting(raced);
				}
			}
		}
		throw error;
	}
}

/** The per-page fields ingestion writes after the fetch. */
export interface CompanyContextUrlPagePatch {
	extractionStatus?: ExtractionStatus;
	extractionError?: string | null;
	chunkCount?: number;
	pageTitle?: string | null;
}

export async function updateCompanyContextUrlPage(
	pageId: string,
	organizationId: string,
	patch: CompanyContextUrlPagePatch,
): Promise<boolean> {
	const { count } = await db.companyContextUrlPage.updateMany({
		where: { id: pageId, organizationId },
		data: patch,
	});
	return count > 0;
}

/**
 * Record that a page is embedded, and with which model; also completes it and
 * clears any earlier failure.
 */
export async function markCompanyContextUrlPageEmbedded(
	pageId: string,
	organizationId: string,
	embedding: {
		embeddingModel: string;
		qdrantId?: string | null;
		chunkCount: number;
	},
): Promise<boolean> {
	if (!embedding.embeddingModel) {
		throw new Error(
			"markCompanyContextUrlPageEmbedded requires an embedding model",
		);
	}
	const { count } = await db.companyContextUrlPage.updateMany({
		where: { id: pageId, organizationId },
		data: {
			embeddedAt: new Date(),
			embeddingModel: embedding.embeddingModel,
			qdrantId: embedding.qdrantId ?? null,
			chunkCount: embedding.chunkCount,
			extractionStatus: "COMPLETED",
			extractionError: null,
		},
	});
	return count > 0;
}

/**
 * Delete the pages under a source that the latest crawl no longer returned,
 * and return their ids so the caller can remove their vectors.
 *
 * An empty `keptUrls` deletes nothing: a crawl that returned no pages is a
 * transient failure or a scope change, and neither should wipe the source.
 */
export async function pruneCompanyContextUrlPages(input: {
	parentSourceId: string;
	organizationId: string;
	keptUrls: readonly string[];
}): Promise<{ deletedPageIds: string[] }> {
	const { parentSourceId, organizationId, keptUrls } = input;
	if (keptUrls.length === 0) {
		return { deletedPageIds: [] };
	}
	return db.$transaction(async (tx) => {
		const orphans = await tx.companyContextUrlPage.findMany({
			where: {
				parentSourceId,
				organizationId,
				pageUrl: { notIn: [...keptUrls] },
			},
			select: { id: true },
		});
		const ids = orphans.map((row) => row.id);
		if (ids.length > 0) {
			await tx.companyContextUrlPage.deleteMany({
				where: { id: { in: ids }, organizationId },
			});
		}
		return { deletedPageIds: ids };
	});
}

/**
 * Settle the pages a finished crawl left waiting — PENDING and holding no
 * vectors: a URL it mapped but never fetched, or fetched but never embedded —
 * as CANCELLED, so none reads as still processing. The next crawl that
 * fetches one rewrites it. A PENDING page that holds vectors keeps them and
 * its status. Returns how many pages were settled.
 */
export async function cancelUnfinishedCompanyContextUrlPages(
	parentSourceId: string,
	organizationId: string,
): Promise<number> {
	const { count } = await db.companyContextUrlPage.updateMany({
		where: {
			parentSourceId,
			organizationId,
			extractionStatus: "PENDING",
			embeddedAt: null,
		},
		data: { extractionStatus: "CANCELLED" },
	});
	return count;
}

/**
 * How many of a source's crawled pages hold vectors written with
 * `embeddingModel` — the pages a search under that model can reach.
 */
export async function countCompanyContextUrlPagesEmbeddedWith(input: {
	parentSourceId: string;
	organizationId: string;
	embeddingModel: string;
}): Promise<number> {
	const { parentSourceId, organizationId, embeddingModel } = input;
	if (!embeddingModel) {
		throw new Error(
			"countCompanyContextUrlPagesEmbeddedWith requires an embedding model",
		);
	}
	return db.companyContextUrlPage.count({
		where: {
			parentSourceId,
			organizationId,
			embeddedAt: { not: null },
			embeddingModel,
		},
	});
}

// ============================================================================
// Metadata edits
// ============================================================================

const SOURCE_METADATA_SELECT = {
	id: true,
	organizationId: true,
	type: true,
	sourceTitle: true,
	originalFilename: true,
	sourceUrl: true,
	sourceType: true,
	aiInstructions: true,
	metadataUpdatedAt: true,
	metadataUpdatedByUserId: true,
	updatedAt: true,
} satisfies Prisma.CompanyContextSourceSelect;

export type CompanyContextSourceMetadataRow =
	Prisma.CompanyContextSourceGetPayload<{
		select: typeof SOURCE_METADATA_SELECT;
	}>;

const METADATA_FIELDS: readonly ContextMetadataField[] = [
	"sourceType",
	"aiInstructions",
];

export type UpdateCompanyContextSourceMetadataResult =
	| { status: "not-found" }
	| { status: "stale"; current: CompanyContextSourceMetadataRow }
	| { status: "unchanged"; source: CompanyContextSourceMetadataRow }
	| {
			status: "updated";
			source: CompanyContextSourceMetadataRow;
			before: ContextMetadataValues;
			after: ContextMetadataValues;
			changed: ContextMetadataField[];
	  };

/**
 * Edit a source's type label and AI instructions, with the same semantics as
 * the project write `updateContextMetadata`: `undefined` leaves a field alone
 * and `null` or blank clears it; `expected` is an optional compare-and-swap
 * against the values the caller read; a no-op returns `unchanged` and stamps
 * nothing; every real write stamps `metadataUpdatedAt` and
 * `metadataUpdatedByUserId`. No re-embed: both fields are read live at
 * retrieval time.
 */
export async function updateCompanyContextSourceMetadata(
	id: string,
	organizationId: string,
	userId: string,
	patch: { sourceType?: string | null; aiInstructions?: string | null },
	options: { expected?: ContextMetadataValues } = {},
): Promise<UpdateCompanyContextSourceMetadataResult> {
	const scope = { id, organizationId };

	return db.$transaction(
		async (tx): Promise<UpdateCompanyContextSourceMetadataResult> => {
			const existing = await tx.companyContextSource.findFirst({
				where: scope,
				select: SOURCE_METADATA_SELECT,
			});
			if (!existing) {
				return { status: "not-found" };
			}

			const before: ContextMetadataValues = {
				sourceType: normalizeContextMetadataValue(existing.sourceType),
				aiInstructions: normalizeContextMetadataValue(
					existing.aiInstructions,
				),
			};
			const data: Partial<ContextMetadataValues> = {};
			for (const field of METADATA_FIELDS) {
				if (patch[field] !== undefined) {
					data[field] = normalizeContextMetadataValue(patch[field]);
				}
			}
			const after: ContextMetadataValues = { ...before, ...data };
			const changed = METADATA_FIELDS.filter(
				(field) => after[field] !== before[field],
			);
			// Before the compare-and-swap, so a retried call whose first
			// attempt landed is told "done" rather than "stale".
			if (changed.length === 0) {
				return { status: "unchanged", source: existing };
			}

			const { expected } = options;
			if (
				expected &&
				METADATA_FIELDS.some(
					(field) =>
						normalizeContextMetadataValue(expected[field]) !==
						before[field],
				)
			) {
				return { status: "stale", current: existing };
			}

			const { count } = await tx.companyContextSource.updateMany({
				// Keyed on the raw stored values, so a concurrent save makes
				// this match nothing instead of being overwritten.
				where: {
					...scope,
					sourceType: existing.sourceType,
					aiInstructions: existing.aiInstructions,
				},
				data: {
					...data,
					metadataUpdatedAt: new Date(),
					metadataUpdatedByUserId: userId,
				},
			});
			if (count === 0) {
				const current = await tx.companyContextSource.findFirst({
					where: scope,
					select: SOURCE_METADATA_SELECT,
				});
				return current
					? { status: "stale", current }
					: { status: "not-found" };
			}

			const source = await tx.companyContextSource.findFirstOrThrow({
				where: scope,
				select: SOURCE_METADATA_SELECT,
			});
			return { status: "updated", source, before, after, changed };
		},
	);
}

// ============================================================================
// Delete
// ============================================================================

/**
 * What the caller needs after a delete to clean up outside Postgres — the
 * stored file, the refresh schedule, an in-flight crawl, the vectors of the
 * source and of each page — and to name the source in an audit entry.
 */
const SOURCE_DELETE_SELECT = {
	id: true,
	organizationId: true,
	type: true,
	sourceTitle: true,
	originalFilename: true,
	sourceUrl: true,
	s3Path: true,
	s3Bucket: true,
	qdrantId: true,
	urlScheduleId: true,
	urlActiveWorkflowId: true,
} satisfies Prisma.CompanyContextSourceSelect;

export type DeletedCompanyContextSource =
	Prisma.CompanyContextSourceGetPayload<{
		select: typeof SOURCE_DELETE_SELECT;
	}> & { urlPageIds: string[] };

/**
 * Delete a source and, by cascade, its crawled pages. Returns what was
 * deleted, or null when no such source belongs to the organization.
 */
export async function deleteCompanyContextSource(
	id: string,
	organizationId: string,
): Promise<DeletedCompanyContextSource | null> {
	return db.$transaction(async (tx) => {
		const source = await tx.companyContextSource.findUnique({
			where: { id_organizationId: { id, organizationId } },
			select: SOURCE_DELETE_SELECT,
		});
		if (!source) {
			return null;
		}
		const pages = await tx.companyContextUrlPage.findMany({
			where: { parentSourceId: id, organizationId },
			select: { id: true },
		});
		const { count } = await tx.companyContextSource.deleteMany({
			where: { id, organizationId },
		});
		if (count === 0) {
			return null;
		}
		return { ...source, urlPageIds: pages.map((page) => page.id) };
	});
}
