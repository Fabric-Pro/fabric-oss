/**
 * Company context search, shared by every caller that draws on an
 * organization's company context (Fizzy #2719).
 *
 * An organization keeps sources about itself — case studies, service
 * descriptions, its website — once. Proposal and Business Case generation
 * (`company-context-retrieval.ts`) search them today, and Advisor chats will
 * search them for a user's question. Both ask the same thing — "which of this
 * organization's ready company material answers this text, for this user?" —
 * so the rules that keep the answer safe live here once, and a fix to one
 * reaches every caller instead of drifting between copies.
 *
 * Who gets it:
 * - The caller names the organization and the user. The `COMPANY_CONTEXT`
 *   gate is read for that organization, and the user must be a member of it.
 *   Membership, never the guest-inclusive organization tie: a project guest
 *   is not a member, and company material is the host's, so the project
 *   invitation does not extend to it.
 *
 * What it finds:
 * - The query is embedded with the organization's embedding model, never the
 *   user's personal one, and only vectors of that model, from sources that
 *   are ready right now (`companyContextReadyWhere`: extracted, embedded with
 *   that model, not being deleted, and a website past its first crawl), can
 *   answer it.
 * - Should the organization switch models between the readiness read and the
 *   query's embedding, the query is not searched.
 * - A crawled page's hit counts only while its page row exists and holds
 *   that model's vectors: a page's vectors can outlive its row when the
 *   prune that removed the row could not remove them.
 * - A model whose dimension no collection can hold skips the search.
 * - Hits group by source, best first; at most four sources, three chunks each.
 *
 * What it returns: one entry per source, with the source's id and name for a
 * citation, and its text — starting with `VENDOR_CONTEXT_MARKER`, then the
 * source label, type and guidance, then the matched text. The text is
 * neutralized here, because not every place that renders it neutralizes what
 * it is given (generation's agent prompt builder does not).
 *
 * What stays out, deliberately:
 * - No `@temporalio/activity` import. A Temporal activity heartbeats while
 *   this runs; a request handler has nothing to heartbeat. Liveness is an
 *   optional callback the caller wires to whatever signal it has.
 * - Nothing caller-shaped: how the query is written (generation's document
 *   intent and project profile, a chat's question), which threshold applies,
 *   and how long the caller can wait are inputs.
 *
 * It never throws, and never takes longer than the caller's `timeoutMs`. A
 * failure or a timeout is logged once and yields no entries; `timedOut`
 * tells the caller which of the two empty results it got.
 */

import { VENDOR_CONTEXT_MARKER } from "@repo/agent-types";
import {
	companyContextReadyWhere,
	db,
	isFeatureEnabled,
	isOrganizationMember,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	COMPANY_EMBEDDING_RESOLUTION,
	type CompanyContextSearchHit,
	companyEmbeddingIdentity,
	generateEmbedding,
	resolveCompanyEmbeddingModel,
	searchCompanyContexts,
} from "@repo/rag";
import {
	neutralizeAiChatAttachmentBody,
	neutralizeAiChatAttachmentFilename,
} from "@repo/utils/ai-chat-attachment";

/** Company entries per search, after grouping hits by source. */
const MAX_COMPANY_ENTRIES = 4;
/** Chunks of one source kept in its entry. */
const MAX_CHUNKS_PER_ENTRY = 3;
/** Hits requested from the search: enough to fill four sources. */
const COMPANY_SEARCH_TOP_K = MAX_COMPANY_ENTRIES * MAX_CHUNKS_PER_ENTRY;

/** What the deadline race resolves with when the search ran out of time. */
const TIMED_OUT = Symbol("company-context-search-timed-out");

const READY_SOURCE_SELECT = {
	id: true,
	sourceTitle: true,
	originalFilename: true,
	sourceUrl: true,
	sourceType: true,
	aiInstructions: true,
} as const;

interface ReadySource {
	id: string;
	sourceTitle: string | null;
	originalFilename: string | null;
	sourceUrl: string | null;
	sourceType: string | null;
	aiInstructions: string | null;
}

/** One company source's share of the answer. */
interface CompanyContextEntry {
	/** The company context source the text came from. */
	sourceId: string;
	/**
	 * The source's label, for a citation. Kept to one line: a citation is
	 * printed mid-line, where a line break could start a forged section.
	 */
	sourceName: string;
	/** The vendor-marked, neutralized entry, as generation consumes it. */
	text: string;
}

interface CompanyContextSearchResult {
	entries: CompanyContextEntry[];
	/** True when the search was cut off at `timeoutMs`, not merely empty. */
	timedOut: boolean;
}

interface CompanyContextSearchInput {
	/** The organization whose company context is searched. */
	organizationId: string;
	/** Who searches: must be a member of `organizationId`. */
	userId: string;
	/** The text to embed and search with. */
	query: string;
	/** The lowest similarity a hit may score and still count. */
	minSimilarity: number;
	/** How long the caller can wait before going on without company context. */
	timeoutMs: number;
	/**
	 * Called once as the search starts, so a Temporal activity can report
	 * liveness. Anything it throws is ignored.
	 */
	heartbeat?: () => void;
	/** Usage attribution for the query's embedding only; never resolves the organization. */
	projectId?: string;
	/** Fields every log line carries, so a caller can trace its own run. */
	logContext?: Readonly<Record<string, unknown>>;
}

function sourceLabel(source: ReadySource): string {
	return (
		source.sourceTitle ||
		source.originalFilename ||
		source.sourceUrl ||
		"Company context"
	);
}

function formatVendorEntry(source: ReadySource, chunks: string[]): string {
	const header = [
		VENDOR_CONTEXT_MARKER,
		`[Source: ${sourceLabel(source)}]`,
		source.sourceType ? `[Source type: ${source.sourceType}]` : null,
		source.aiInstructions
			? `[Source guidance: ${source.aiInstructions}]`
			: null,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return neutralizeAiChatAttachmentBody(
		`${header}\n${chunks.join("\n\n[...]\n\n")}`,
	);
}

/**
 * Drop the hits of crawled pages whose row is gone, or no longer holds
 * `embeddingModel`'s vectors, under a ready source. One query, scoped to the
 * organization and its ready sources, for the pages among the hits; a hit on
 * a source's own text needs none.
 */
async function keepLivePageHits(
	hits: readonly CompanyContextSearchHit[],
	scope: {
		organizationId: string;
		sourceIds: readonly string[];
		embeddingModel: string;
	},
): Promise<CompanyContextSearchHit[]> {
	const isPageHit = (hit: CompanyContextSearchHit) =>
		Boolean(hit.parentContextId);
	const pageIds = [
		...new Set(hits.filter(isPageHit).map((hit) => hit.contextId)),
	];
	if (pageIds.length === 0) {
		return [...hits];
	}
	const livePages = await db.companyContextUrlPage.findMany({
		where: {
			organizationId: scope.organizationId,
			id: { in: pageIds },
			parentSourceId: { in: [...scope.sourceIds] },
			embeddedAt: { not: null },
			embeddingModel: scope.embeddingModel,
		},
		select: { id: true, parentSourceId: true },
	});
	const parentOf = new Map(
		livePages.map((page) => [page.id, page.parentSourceId]),
	);
	return hits.filter(
		(hit) =>
			!isPageHit(hit) || parentOf.get(hit.contextId) === hit.sourceId,
	);
}

/**
 * Group hits by source in score order, keep only sources that are still
 * ready, and cap the result. Hits arrive best first, so the first hit of a
 * source fixes its rank.
 */
function selectVendorEntries(
	hits: readonly CompanyContextSearchHit[],
	readySources: ReadonlyMap<string, ReadySource>,
): CompanyContextEntry[] {
	const selected = new Map<
		string,
		{ source: ReadySource; chunks: string[] }
	>();
	for (const hit of hits) {
		const source = readySources.get(hit.sourceId);
		if (!source) {
			continue;
		}
		const entry = selected.get(hit.sourceId);
		if (entry) {
			if (entry.chunks.length < MAX_CHUNKS_PER_ENTRY) {
				entry.chunks.push(hit.content);
			}
		} else if (selected.size < MAX_COMPANY_ENTRIES) {
			selected.set(hit.sourceId, { source, chunks: [hit.content] });
		}
	}
	return [...selected.values()].map(({ source, chunks }) => ({
		sourceId: source.id,
		sourceName: neutralizeAiChatAttachmentFilename(sourceLabel(source)),
		text: formatVendorEntry(source, chunks),
	}));
}

/**
 * Search `organizationId`'s company context for `query`, as `userId`. Never
 * throws, and gives up after `timeoutMs`: a hung embedding call or search
 * must not hold, or fail, whatever the caller is doing alongside it.
 */
export async function searchCompanyContext(
	input: CompanyContextSearchInput,
): Promise<CompanyContextSearchResult> {
	try {
		input.heartbeat?.();
	} catch {
		// Not in an activity context (e.g. tests); liveness is best effort.
	}

	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), input.timeoutMs);
	});
	try {
		const entries = await Promise.race([
			findCompanyContextEntries(input, controller.signal),
			deadline,
		]);
		if (entries !== TIMED_OUT) {
			return { entries, timedOut: false };
		}
		// Cancels the embedding call if that is where it hangs; whatever
		// else is in flight finishes unobserved and is ignored.
		controller.abort();
		logger.warn(
			"[CompanyContext] Company context search timed out; going on without company context",
			{
				...input.logContext,
				organizationId: input.organizationId,
				timeoutMs: input.timeoutMs,
			},
		);
		return { entries: [], timedOut: true };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The search `searchCompanyContext` bounds. Never throws; once `signal` is
 * aborted it stops at its next step and logs nothing, since the caller
 * already logged the timeout.
 */
async function findCompanyContextEntries(
	input: CompanyContextSearchInput,
	signal: AbortSignal,
): Promise<CompanyContextEntry[]> {
	const { organizationId, userId, query, minSimilarity, projectId } = input;
	const logContext = { ...input.logContext, organizationId };
	try {
		if (!(await isFeatureEnabled("COMPANY_CONTEXT", organizationId))) {
			return [];
		}
		if (!(await isOrganizationMember(userId, organizationId))) {
			logger.info(
				"[CompanyContext] User is not a member of the organization; company context not searched",
				{ ...logContext, userId },
			);
			return [];
		}

		const model = await resolveCompanyEmbeddingModel({
			organizationId,
			userId,
		});
		if (!model.supported) {
			logger.warn(
				"[CompanyContext] Skipping company context: unsupported embedding model for the company context collection",
				{
					...logContext,
					embeddingModel: model.identity,
					dimensions: model.dimensions,
				},
			);
			return [];
		}

		// Readiness is read for the model resolved just above, so a source
		// written with an earlier model is not ready until it is re-embedded.
		const readyRows: ReadySource[] = await db.companyContextSource.findMany(
			{
				where: {
					organizationId,
					...companyContextReadyWhere(model.identity),
				},
				select: READY_SOURCE_SELECT,
			},
		);
		if (readyRows.length === 0) {
			return [];
		}
		const readySources = new Map(readyRows.map((row) => [row.id, row]));

		if (signal.aborted) {
			return [];
		}
		// Embedded with the organization's model, the one `model` names and
		// the sources were written with — never the user's personal one.
		const queryEmbedding = await generateEmbedding(
			query,
			{
				userId,
				organizationId,
				projectId,
				tags: ["company-context-retrieval"],
				...COMPANY_EMBEDDING_RESOLUTION,
			},
			undefined,
			signal,
		);
		// The call resolves the model again. Should the organization have
		// switched models in between, the query vector lives in another
		// embedding space than the ready sources': no search this time.
		const queryModel = companyEmbeddingIdentity(queryEmbedding);
		if (queryModel !== model.identity) {
			logger.info(
				"[CompanyContext] The organization's embedding model changed during the search; company context not searched",
				{
					...logContext,
					embeddingModel: model.identity,
					queryModel,
				},
			);
			return [];
		}
		if (signal.aborted) {
			return [];
		}
		const { embedding } = queryEmbedding;

		const hits = await searchCompanyContexts({
			organizationId,
			embeddingModel: model.identity,
			queryEmbedding: embedding,
			sourceIds: [...readySources.keys()],
			topK: COMPANY_SEARCH_TOP_K,
			minSimilarity,
		});

		const liveHits = await keepLivePageHits(hits, {
			organizationId,
			sourceIds: [...readySources.keys()],
			embeddingModel: model.identity,
		});
		const entries = selectVendorEntries(liveHits, readySources);
		// Ids and counts only: never the query or the company text.
		logger.info("[CompanyContext] Company context searched", {
			...logContext,
			userId,
			readySourceCount: readyRows.length,
			hitCount: hits.length,
			goneHitCount: hits.length - liveHits.length,
			entryCount: entries.length,
			sourceIds: entries.map((entry) => entry.sourceId),
		});
		return entries;
	} catch (error) {
		if (signal.aborted) {
			return [];
		}
		logger.warn(
			"[CompanyContext] Company context search failed; going on without company context",
			{
				...logContext,
				error: error instanceof Error ? error.message : String(error),
			},
		);
		return [];
	}
}
