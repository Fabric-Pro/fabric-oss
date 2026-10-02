/**
 * Update Parent ProjectContext Status Activity (URL Context Sources)
 *
 * Single-purpose finalizer. The workflow calls this at the end of every
 * branch (COMPLETED happy path or FAILED catch path) so the UI can
 * transition the LINK card off the EXTRACTING pill.
 *
 * The error path is best-effort by design.
 *
 * Notification side effect: after the parent
 * row is written, on COMPLETED or FAILED terminal status we also insert a
 * `CONTEXT_INDEXING_COMPLETED` notification. CANCELLED is silent.
 * The notification helper lives at `./lib/emit-completion-notification.ts`
 * — co-located with the activity per `fabric/standards/backend/temporal.md`
 * ("side effects live in activities, never in workflow code").
 *
 * A company owner (Fizzy #2719) finalizes the `CompanyContextSource` instead,
 * scoped by the owner's organization, and never notifies: the notification
 * is a project surface. A multi-page crawl that COMPLETED also marks the
 * source embedded with the organization's current embedding model — the
 * source holds no vectors of its own, and it is ready for retrieval only
 * while that model matches every crawled page's. It is marked only when at
 * least one page holds that model's vectors: a crawl swallows each page's
 * scrape and embed failures, so one whose every page failed still ends
 * COMPLETED, and is recorded as having nothing indexed instead. A single
 * page is marked by the embed step that follows. A missing owner is the
 * project owner, unchanged.
 *
 * A company finalize writes only while the source's crawl slot is free or
 * names this crawl (the gate claimed it): a crawl never finalizes a source
 * another crawl holds. A crawl that ends leaves no page PENDING without
 * vectors — the URLs it mapped but never reached are settled as CANCELLED.
 * And a crawl that fails or is cancelled while its source reads COMPLETED
 * and embedded — a scheduled refresh; a crawl the API starts sets the source
 * PENDING first — keeps the source COMPLETED: its pages and vectors are
 * intact and stay searchable, so only the error and the next refresh time
 * are recorded, as an indexing failure keeps a completed extraction. The
 * same holds for such a refresh that COMPLETED while the organization's
 * embedding model could not index company context.
 */
import { AIProviderNotConfiguredError } from "@repo/ai";
import type {
	CompanyLinkSourceCrawlState,
	ExtractionStatus,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { contextContentHashOrNull } from "@repo/database/prisma/queries/projects/context-content-hash";
import {
	resolveCompanyEmbeddingModel,
	unsupportedEmbeddingModelMessage,
} from "@repo/rag";
import { activityInfo } from "@temporalio/activity";
import {
	type CompanyContextOwner,
	type ContextOwner,
	companyContextOwnerOf,
} from "../../lib/context-owner";
import {
	type CompanyCrawlFinalizeData,
	type CompanyLinkCrawlStore,
	companyLinkCrawlStore,
} from "../../lib/context-row-store";
import { cadenceNextFireUtc } from "../../schedules/url-source-schedule";
import { activityLogger } from "../lib/activity-logger";
import {
	COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE,
	isCompletedAndEmbedded,
} from "./company-gate-activity";
import { emitCompletionNotification } from "./lib/emit-completion-notification";

/** Recorded on a website whose COMPLETED crawl left no page with vectors. */
export const COMPANY_CRAWL_NO_INDEXED_PAGE_MESSAGE =
	"No page of this website could be indexed, so there is nothing to search. Re-process it to try again.";

export interface UpdateParentStatusActivityInput {
	contextId: string;
	extractionStatus: ExtractionStatus;
	extractionError?: string | null;
	urlLastSyncedAt?: Date | null;
	urlNextRefreshAt?: Date | null;
	/** Single-page content lives directly on the parent row; multi-page leaves it null. */
	content?: string;
	// --- Notification-emit fields. All optional so legacy
	// callers (and any in-flight workflows that started before this code
	// shipped) keep their existing call shapes. When projectId or sourceUrl
	// is missing the notification emit is silently skipped — the row status
	// update still happens unconditionally.
	projectId?: string;
	userId?: string | null;
	organizationId?: string | null;
	sourceUrl?: string;
	pagesIndexed?: number;
	/** Who owns the row; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface UpdateParentStatusActivityOutput {
	success: boolean;
}

export async function updateParentStatusActivity(
	input: UpdateParentStatusActivityInput,
): Promise<UpdateParentStatusActivityOutput> {
	const company = companyContextOwnerOf(input.owner);
	if (company) {
		return finalizeCompanySource(input, company);
	}

	const {
		contextId,
		extractionStatus,
		extractionError,
		urlLastSyncedAt,
		urlNextRefreshAt,
		content,
		projectId,
		userId,
		organizationId,
		sourceUrl,
		pagesIndexed,
	} = input;

	activityLogger.info("Update parent status activity start", {
		contextId,
		extractionStatus,
	});

	await db.projectContext.update({
		where: { id: contextId },
		data: {
			extractionStatus,
			extractionError: extractionError ?? null,
			...(urlLastSyncedAt !== undefined ? { urlLastSyncedAt } : {}),
			...(urlNextRefreshAt !== undefined ? { urlNextRefreshAt } : {}),
			// The hash travels with the content (Fizzy #2619): a stale one
			// would keep matching this row against the page it used to hold.
			...(content !== undefined
				? { content, contentHash: contextContentHashOrNull(content) }
				: {}),
			// Clear the in-flight workflowId on every finalize. Set by
			// resync-url-source / process-context-link when starting the
			// crawl; read by cancel-url-source-crawl to look up the handle.
			// We clear unconditionally so a workflow that finalizes via the
			// FAILED branch (or partial-success after cancellation) still
			// frees the slot for the next re-sync.
			urlActiveWorkflowId: null,
		},
	});

	activityLogger.info("Update parent status activity success", {
		contextId,
		extractionStatus,
	});

	// Emit the persistent CONTEXT_INDEXING_COMPLETED notification.
	// The helper is idempotent + dedup-aware (P2002 on
	// the partial unique index coalesces into the existing unread row);
	// CANCELLED is silently skipped. Skip entirely when the caller
	// didn't supply the notification context (e.g., legacy workflow runs).
	if (projectId && sourceUrl) {
		await emitCompletionNotification({
			contextId,
			projectId,
			userId: userId ?? null,
			organizationId: organizationId ?? null,
			sourceUrl,
			extractionStatus,
			pagesIndexed,
			extractionError,
		});
	}

	return { success: true };
}

/**
 * The company owner's finalize: the same status, error, content, timestamps
 * and freed crawl slot, on the company row, under the rules at the top of
 * this file. A multi-page COMPLETED also records the embedding model when a
 * page holds its vectors; if no model can index company context, the source
 * is FAILED with the reason instead.
 */
async function finalizeCompanySource(
	input: UpdateParentStatusActivityInput,
	owner: CompanyContextOwner,
): Promise<UpdateParentStatusActivityOutput> {
	const { contextId, extractionStatus: requested } = input;
	const { organizationId } = owner;
	const crawls = companyLinkCrawlStore(owner);
	const workflowId = activityInfo().workflowExecution?.workflowId;
	if (!workflowId) {
		// A standalone activity has no crawl, so no slot it could own.
		throw new Error(
			"A company crawl is finalized from the crawl workflow only",
		);
	}

	activityLogger.info("Update company source status activity start", {
		contextId,
		organizationId,
		extractionStatus: requested,
	});

	const state = await crawls.getCrawlState(contextId);
	if (!state) {
		activityLogger.info(
			"Company context source no longer exists; nothing to finalize",
			{ contextId, organizationId },
		);
		return { success: true };
	}
	if (
		state.urlActiveWorkflowId !== null &&
		state.urlActiveWorkflowId !== workflowId
	) {
		activityLogger.warn(
			"Another crawl holds this company context source; not finalizing it",
			{
				contextId,
				organizationId,
				runningCrawl: state.urlActiveWorkflowId,
			},
		);
		return { success: true };
	}

	const keepCompleted =
		(requested === "FAILED" || requested === "CANCELLED") &&
		isCompletedAndEmbedded(state);
	const data = keepCompleted
		? keptCompletedFinalize(
				input,
				workflowId,
				state.urlRefreshMode,
				requested === "FAILED"
					? (input.extractionError ?? null)
					: undefined,
			)
		: await outcomeFinalize(input, owner, crawls, workflowId, state);

	const found = await crawls.finalizeCrawl(contextId, data);
	if (!found) {
		activityLogger.info(
			"Company context source is gone, being deleted, or held by another crawl; nothing finalized",
			{ contextId, organizationId },
		);
		return { success: true };
	}

	const settledPages = await crawls.cancelUnfinishedPages(contextId);

	activityLogger.info("Update company source status activity success", {
		contextId,
		extractionStatus: data.status ?? state.extractionStatus,
		embeddingModel: data.embeddingModel ?? null,
		keptCompleted: data.status === undefined,
		settledPages,
	});

	return { success: true };
}

/**
 * A refresh of a source that is COMPLETED and embedded, which failed, was
 * cancelled, or could not be indexed with the organization's model: the
 * status, the last sync time and the index markers stay as they are. A
 * `failure` message is recorded (a cancel records none), and the next
 * refresh time — which a failed crawl does not compute — from the source's
 * cadence.
 */
function keptCompletedFinalize(
	input: UpdateParentStatusActivityInput,
	workflowId: string,
	refreshMode: CompanyLinkSourceCrawlState["urlRefreshMode"],
	failure: string | null | undefined,
): CompanyCrawlFinalizeData {
	return {
		workflowId,
		...(failure !== undefined ? { extractionError: failure } : {}),
		urlNextRefreshAt:
			input.urlNextRefreshAt ??
			cadenceNextFireUtc(refreshMode, new Date()),
	};
}

/**
 * The crawl's own outcome, with the model a multi-page COMPLETED records —
 * or, when no page holds that model's vectors, why nothing is searchable.
 */
async function outcomeFinalize(
	input: UpdateParentStatusActivityInput,
	owner: CompanyContextOwner,
	crawls: CompanyLinkCrawlStore,
	workflowId: string,
	state: CompanyLinkSourceCrawlState,
): Promise<CompanyCrawlFinalizeData> {
	const { extractionError, urlLastSyncedAt, urlNextRefreshAt, content } =
		input;
	let status = input.extractionStatus;
	let error = extractionError ?? null;
	let embeddingModel: string | undefined;

	if (status === "COMPLETED" && content === undefined) {
		try {
			const model = await resolveCompanyEmbeddingModel({
				organizationId: owner.organizationId,
				userId: input.userId ?? "",
			});
			if (!model.supported) {
				status = "FAILED";
				error = unsupportedEmbeddingModelMessage(model);
			} else if (
				(await crawls.countEmbeddedPages(
					input.contextId,
					model.identity,
				)) > 0
			) {
				embeddingModel = model.identity;
			} else {
				error = COMPANY_CRAWL_NO_INDEXED_PAGE_MESSAGE;
			}
		} catch (resolveError) {
			if (!(resolveError instanceof AIProviderNotConfiguredError)) {
				throw resolveError;
			}
			status = "FAILED";
			error = COMPANY_CRAWL_NO_EMBEDDING_PROVIDER_MESSAGE;
		}
		// A scheduled refresh of an intact website is not failed for a
		// model it could not be indexed with: its pages keep their vectors.
		if (status === "FAILED" && isCompletedAndEmbedded(state)) {
			return keptCompletedFinalize(
				input,
				workflowId,
				state.urlRefreshMode,
				error,
			);
		}
	}

	return {
		workflowId,
		status,
		extractionError: error,
		...(content !== undefined ? { content } : {}),
		...(urlLastSyncedAt !== undefined ? { urlLastSyncedAt } : {}),
		...(urlNextRefreshAt !== undefined ? { urlNextRefreshAt } : {}),
		...(embeddingModel ? { embeddingModel } : {}),
	};
}
