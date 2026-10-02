/**
 * The organization's side of the shared context-source forms (Fizzy #2719),
 * plus the pure pieces of the company context page: what each source's state
 * reads as, and when the list and a website's page list poll.
 *
 * Company sources live under `organizations.companyContext.*`. Every call
 * names the organization the page was opened for — from the URL slug, never
 * the session — and the server re-checks membership, role and the
 * COMPANY_CONTEXT gate on each one. The procedures speak `sourceId`; the
 * shared forms speak `contextId`, so the adapters translate at the seam.
 */

import type {
	ContextSourceDetailsAdapter,
	ContextSourceSubmitAdapter,
	SavedContextSourceMetadata,
} from "@saas/context-sources/lib/submit-adapter";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

type CompanyContextClient = typeof orpcClient.organizations.companyContext;

/** What `organizations.companyContext.list` answers. */
export type CompanyContextListResult = Awaited<
	ReturnType<CompanyContextClient["list"]>
>;
export type CompanyContextSource = CompanyContextListResult["sources"][number];
export type CompanyEmbeddingModel = CompanyContextListResult["embeddingModel"];

// ── Submit adapter (File / Link / Text) ──────────────────────────────────

/**
 * The add forms, bound to one organization's company context. The Link tab
 * submits one URL per call — a bulk paste fans out in the form — so each call
 * sends a single `url`, never `urls`. The knowledge-base category is a project
 * readiness field and is never sent.
 */
export function companyContextSubmitAdapter(
	organizationId: string,
): ContextSourceSubmitAdapter {
	const client = orpcClient.organizations.companyContext;
	return {
		createUploadUrl: async ({ filename, mimeType, size }) => {
			const { sourceId, signedUploadUrl, contentType } =
				await client.createUploadUrl({
					organizationId,
					filename,
					mimeType,
					size,
				});
			return { contextId: sourceId, signedUploadUrl, contentType };
		},
		processFile: ({ contextId }) =>
			client.processFile({ organizationId, sourceId: contextId }),
		processLink: async (link) => {
			const { sources } = await client.processLink({
				organizationId,
				url: link.url,
				...(link.label ? { label: link.label } : {}),
				scope: link.scope,
				refreshMode: link.refreshMode,
				...(link.maxPages !== undefined
					? { maxPages: link.maxPages }
					: {}),
				...(link.sourceType ? { sourceType: link.sourceType } : {}),
				...(link.aiInstructions
					? { aiInstructions: link.aiInstructions }
					: {}),
			});
			// A single URL whose crawl cannot start is refused outright; a
			// FAILED entry is only possible for a bulk request, but a failed
			// row must never read as added.
			const failed = sources.find((source) => source.status === "FAILED");
			if (failed) {
				throw new Error(
					failed.error ?? "The website could not be added",
				);
			}
			// The crawl runs, but its automatic refresh was not scheduled.
			// One toast id per organization: a bulk paste whose schedules
			// all fail shows the warning once, not once per URL.
			const unscheduled = sources.find(
				(source) => source.scheduleWarning,
			);
			if (unscheduled?.scheduleWarning) {
				toast.warning(unscheduled.scheduleWarning.message, {
					id: `company-context-schedule-warning-${organizationId}`,
				});
			}
			return sources;
		},
		createText: ({ title, content }) =>
			client.createText({ organizationId, title, content }),
		listQueryKey: orpc.organizations.companyContext.list.queryKey({
			input: { organizationId },
		}),
	};
}

// ── Details adapter (type label + AI instructions) ───────────────────────

/**
 * The list with one source's metadata replaced by a save's result. The shared
 * dialog writes saves into a project list's `contexts`; the company list is
 * `sources`, so this adapter writes its own before handing the result back —
 * otherwise reopening the dialog before the refetch lands would start from
 * the pre-save values and be refused as someone else's edit.
 */
export function withSavedCompanyMetadata(
	old: CompanyContextListResult | undefined,
	saved: SavedContextSourceMetadata,
): CompanyContextListResult | undefined {
	if (!old) {
		return old;
	}
	return {
		...old,
		sources: old.sources.map((source) =>
			source.id === saved.contextId
				? {
						...source,
						sourceType: saved.sourceType,
						aiInstructions: saved.aiInstructions,
						metadataUpdatedAt: (saved.metadataUpdatedAt ??
							null) as CompanyContextSource["metadataUpdatedAt"],
						metadataUpdatedByUserId:
							saved.metadataUpdatedByUserId ?? null,
					}
				: source,
		),
	};
}

/**
 * The details dialog, bound to one organization's company context. A stale
 * save is refused by the server with CONFLICT and `data.current`, which the
 * shared dialog reads as is.
 */
export function companyContextDetailsAdapter(
	organizationId: string,
	queryClient: QueryClient,
	useEditorName: ContextSourceDetailsAdapter["useEditorName"],
): ContextSourceDetailsAdapter {
	const listQueryKey = orpc.organizations.companyContext.list.queryKey({
		input: { organizationId },
	});
	return {
		saveMetadata: async ({
			contextId,
			sourceType,
			aiInstructions,
			expected,
		}) => {
			const result =
				await orpcClient.organizations.companyContext.updateMetadata({
					organizationId,
					sourceId: contextId,
					sourceType,
					aiInstructions,
					expected,
				});
			const saved: SavedContextSourceMetadata = {
				contextId: result.sourceId,
				sourceType: result.sourceType,
				aiInstructions: result.aiInstructions,
				metadataUpdatedAt: result.metadataUpdatedAt,
				metadataUpdatedByUserId: result.metadataUpdatedByUserId,
			};
			queryClient.setQueryData<CompanyContextListResult>(
				listQueryKey,
				(old) => withSavedCompanyMetadata(old, saved),
			);
			return saved;
		},
		listQueryKey,
		useEditorName,
	};
}

// ── Source state ─────────────────────────────────────────────────────────

/**
 * What a source's badge says. The processing states are a project source's;
 * `ready` is the server's retrieval predicate (under the organization's
 * current embedding model), so "Ready" here means a Proposal can use it.
 */
export type CompanySourceState =
	| "pending"
	| "processing"
	| "indexing"
	| "ready"
	| "needsReprocessing"
	| "notSearchable"
	| "failed"
	| "cancelled";

type SourceStateFields = Pick<
	CompanyContextSource,
	| "extractionStatus"
	| "extractionError"
	| "embeddedAt"
	| "ready"
	| "needsReprocessing"
	| "crawlInProgress"
>;

export function resolveCompanySourceState(
	source: SourceStateFields,
	model: CompanyEmbeddingModel,
): CompanySourceState {
	// Stale first: a source embedded with an earlier model, or refused an
	// unsupported one, is fixed by re-processing, whatever it last recorded.
	if (source.needsReprocessing) {
		return "needsReprocessing";
	}
	if (source.crawlInProgress || source.extractionStatus === "EXTRACTING") {
		return "processing";
	}
	switch (source.extractionStatus) {
		case "PENDING":
			return "pending";
		case "FAILED":
			return "failed";
		case "CANCELLED":
			return "cancelled";
	}
	if (source.ready) {
		return "ready";
	}
	// Extracted, and embedding has not finished yet — unless there is no
	// usable model to embed with, or embedding already recorded why it failed.
	if (!source.embeddedAt && !source.extractionError && model?.supported) {
		return "indexing";
	}
	return "notSearchable";
}

/** States the list keeps polling through. */
const IN_FLIGHT_STATES = new Set<CompanySourceState>([
	"pending",
	"processing",
	"indexing",
]);

function isCompanySourceInFlight(
	source: SourceStateFields,
	model: CompanyEmbeddingModel,
): boolean {
	return IN_FLIGHT_STATES.has(resolveCompanySourceState(source, model));
}

// ── Polling ──────────────────────────────────────────────────────────────

export const COMPANY_CONTEXT_POLL_INTERVAL_MS = 2000;

/**
 * How long a source may sit in flight before the list stops polling for it —
 * the project Context tab's cap (`MAX_POLL_DURATION_MS`). A source stuck
 * pending (a lost workflow, an upload that never finished) is left for the
 * admin to re-process instead of polling forever.
 */
export const MAX_COMPANY_CONTEXT_POLL_MS = 5 * 60 * 1000;

/**
 * Sources whose delete the server accepted, by id, with when the list learned
 * of it. The server only starts a deletion workflow, which removes the row a
 * little later, so the list hides these at once and keeps polling until the
 * server stops returning them.
 */
export type PendingCompanyDeletes = ReadonlyMap<string, number>;

/**
 * The list's refetch interval: every 2s while any source is in flight and was
 * last written within the cap, or a deleted source is still returned within
 * the cap of its delete, otherwise off. In-flight sources are measured from
 * `updatedAt` rather than the project list's `createdAt`, because a re-sync or
 * re-process puts an old source back in flight and must be followed again.
 * Timestamps in the future (clock skew) keep polling.
 */
export function companyContextPollInterval(
	result: CompanyContextListResult | undefined,
	nowMs: number,
	pendingDeletes: PendingCompanyDeletes = new Map(),
): number | false {
	if (!result) {
		return false;
	}
	const followed = result.sources.some((source) => {
		const deletedAtMs = pendingDeletes.get(source.id);
		if (deletedAtMs !== undefined) {
			return nowMs - deletedAtMs < MAX_COMPANY_CONTEXT_POLL_MS;
		}
		if (!isCompanySourceInFlight(source, result.embeddingModel)) {
			return false;
		}
		const lastWrite = source.updatedAt ?? source.createdAt;
		const lastWriteMs = lastWrite ? new Date(lastWrite).getTime() : nowMs;
		return nowMs - lastWriteMs < MAX_COMPANY_CONTEXT_POLL_MS;
	});
	return followed ? COMPANY_CONTEXT_POLL_INTERVAL_MS : false;
}

/** The sources the list shows: every returned one not already deleted. */
export function visibleCompanySources(
	sources: readonly CompanyContextSource[],
	pendingDeletes: PendingCompanyDeletes,
): CompanyContextSource[] {
	return sources.filter((source) => !pendingDeletes.has(source.id));
}

/**
 * The pending deletes minus those the server no longer returns — their rows
 * are gone. The same map when nothing changed, so a state setter can bail out.
 */
export function settlePendingCompanyDeletes(
	pendingDeletes: PendingCompanyDeletes,
	result: CompanyContextListResult,
): PendingCompanyDeletes {
	if (pendingDeletes.size === 0) {
		return pendingDeletes;
	}
	const returned = new Set(result.sources.map((source) => source.id));
	const stillReturned = [...pendingDeletes].filter(([id]) =>
		returned.has(id),
	);
	return stillReturned.length === pendingDeletes.size
		? pendingDeletes
		: new Map(stillReturned);
}

// ── Crawled pages ────────────────────────────────────────────────────────

export const COMPANY_URL_PAGES_POLL_INTERVAL_MS = 5000;

/**
 * How many loaded pages of a website's page list stay live while it crawls.
 * A refetch of an infinite query re-reads every page it holds, one request
 * each, so a list paged far down would multiply the requests on every tick.
 * The assumption: someone watching a crawl stays near the top. A list paged
 * past this holds still until the crawl ends and is then re-read once in
 * full. `maxPages` is not the cap because it drops the earliest pages from
 * the list on "Load more".
 */
export const COMPANY_URL_PAGES_LIVE_PAGES = 3;

/** The page list's refetch interval, given how many pages it has loaded. */
export function companyUrlPagesPollInterval(
	crawling: boolean,
	loadedPages: number,
): number | false {
	return crawling && loadedPages <= COMPANY_URL_PAGES_LIVE_PAGES
		? COMPANY_URL_PAGES_POLL_INTERVAL_MS
		: false;
}

// ── Display ──────────────────────────────────────────────────────────────

/** The name a source is shown under. */
export function companySourceTitle(
	source: Pick<
		CompanyContextSource,
		"sourceTitle" | "originalFilename" | "sourceUrl" | "metadata" | "type"
	>,
): string {
	const metadata = (source.metadata ?? {}) as { title?: unknown };
	const metadataTitle =
		typeof metadata.title === "string" ? metadata.title : null;
	return (
		source.sourceTitle ||
		metadataTitle ||
		source.originalFilename ||
		source.sourceUrl ||
		source.type
	);
}

/**
 * Whether a download can succeed now. A file downloads its stored original; a
 * text or website downloads its text, which a website only has once a crawl
 * has finished and is not rewriting it.
 */
export function isCompanySourceDownloadable(
	source: Pick<
		CompanyContextSource,
		"type" | "extractionStatus" | "crawlInProgress"
	>,
): boolean {
	if (source.type === "LINK") {
		return (
			!source.crawlInProgress && source.extractionStatus === "COMPLETED"
		);
	}
	return true;
}
