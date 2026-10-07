/**
 * Record URL Page Fetch Failure Activity (URL Context Sources)
 *
 * Records, on a website source's crawled page, that a crawl could not fetch
 * the page at a URL, and tells the crawl whether to keep that URL from its
 * prune. Without it, a page whose scrape failed on a refresh was absent from
 * the crawl's kept set, so the prune deleted a page that is still on the site.
 *
 * The page is keyed by the URL the crawl requested — the only one known when
 * the scrape fails. `reason` is the cause; the stored message is
 * `URL_PAGE_FETCH_FAILURE_PREFIX` followed by it, so a later fetch of the
 * page can tell this failure from any other.
 *
 * Which rows change (`urlPageFetchFailureWritableWhere`):
 *   - a page that a fetch has written is marked FAILED with the message when
 *     it is COMPLETED or CANCELLED or holds no vectors; a PENDING, EXTRACTING
 *     or FAILED page holding vectors is left as it is. Its content, hash,
 *     chunk count, fetch time and vectors never change, so an indexed page
 *     stays searchable. The URL is kept;
 *   - a URL with no row, or a row no fetch has written (its content hash is
 *     empty: a placeholder, or an earlier failure), gets a FAILED row with no
 *     content on a transient failure, so it shows in the pages list and is
 *     fetched again by the next crawl that finds it, and is kept. On a
 *     permanent failure — robots disallow, an unsupported content type —
 *     the URL is not kept and its empty row, if any, is removed, even in a
 *     crawl that fetched no page (whose prune deletes nothing).
 * Recording the same failure again leaves the same state.
 *
 * A company owner (Fizzy #2719) writes `CompanyContextUrlPage` under the
 * owner's organization, and nothing under a source that is gone or being
 * deleted. A page there holding vectors of a model other than the
 * organization's current one loses them — its points first, then its index
 * markers — whatever its status: they cannot be searched with the current
 * model, and they keep the website out of `companyContextReadyWhere` until
 * the page is embedded again. A missing owner is the project owner.
 *
 * Errors are not swallowed: Temporal retries the activity, and the crawl
 * keeps a URL whose failure could not be recorded.
 */
import {
	urlPageFetchFailureMessage,
	urlPageFetchFailureWritableWhere,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { deleteCompanyContextRowPoints } from "@repo/rag";
import {
	type CompanyContextOwner,
	type ContextOwner,
	resolveContextOwner,
} from "../../lib/context-owner";
import { companyLinkCrawlStore } from "../../lib/context-row-store";
import { activityLogger } from "../lib/activity-logger";
import { currentCompanyEmbeddingModel } from "./lib/company-embedding-model";

export interface RecordUrlPageFetchFailureActivityInput {
	parentContextId: string;
	/** The parent's project; absent for a company source. */
	projectId?: string;
	/** The URL the crawl requested. */
	pageUrl: string;
	/** Why the fetch failed; stored after `URL_PAGE_FETCH_FAILURE_PREFIX`. */
	reason: string;
	/** A failure a later fetch would meet again (robots, content type). */
	permanent: boolean;
	userId: string | null;
	organizationId: string | null;
	/** Who owns the parent; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface RecordUrlPageFetchFailureActivityOutput {
	/** Whether the crawl keeps the URL from its prune. */
	kept: boolean;
}

export async function recordUrlPageFetchFailureActivity(
	input: RecordUrlPageFetchFailureActivityInput,
): Promise<RecordUrlPageFetchFailureActivityOutput> {
	const owner = resolveContextOwner(input);
	if (owner.kind === "company") {
		return recordCompanyUrlPageFetchFailure(input, owner);
	}

	const { projectId } = owner;
	const {
		parentContextId,
		pageUrl,
		reason,
		permanent,
		userId,
		organizationId,
	} = input;
	const message = urlPageFetchFailureMessage(reason);

	activityLogger.info("Record url page fetch failure start", {
		parentContextId,
		pageUrl,
		permanent,
	});

	const existing = await db.projectContextUrlPage.findFirst({
		where: { parentContextId, pageUrl },
		select: { id: true, contentHash: true },
	});

	const fetchedBefore = existing !== null && existing.contentHash !== "";
	if (permanent && !fetchedBefore) {
		// Remove the empty row here rather than leave it to the prune, which
		// deletes nothing when the crawl fetched no page at all.
		const removed = existing
			? await db.projectContextUrlPage.deleteMany({
					where: {
						id: existing.id,
						parentContextId,
						contentHash: "",
						embeddedAt: null,
					},
				})
			: { count: 0 };
		activityLogger.info(
			"Url page fetch failed permanently with no content to keep",
			{ parentContextId, pageUrl, removed: removed.count > 0 },
		);
		return { kept: false };
	}

	if (!existing) {
		// The fields bulk-init gives a placeholder; `lastFetchedAt` takes the
		// column default.
		const created = await db.projectContextUrlPage.create({
			data: {
				parentContextId,
				projectId,
				pageUrl,
				content: "",
				contentHash: "",
				extractionStatus: "FAILED",
				extractionError: message,
				userId,
				organizationId,
			},
			select: { id: true },
		});
		activityLogger.info("Record url page fetch failure created", {
			parentContextId,
			pageUrl,
			pageId: created.id,
		});
		return { kept: true };
	}

	const { count } = await db.projectContextUrlPage.updateMany({
		where: {
			id: existing.id,
			parentContextId,
			...urlPageFetchFailureWritableWhere(),
		},
		data: { extractionStatus: "FAILED", extractionError: message },
	});

	activityLogger.info("Record url page fetch failure kept existing", {
		parentContextId,
		pageUrl,
		pageId: existing.id,
		marked: count > 0,
	});

	return { kept: true };
}

/**
 * The company owner's record: the row rules run in the query layer, scoped
 * by the owner's organization; another model's vectors are removed here, as
 * the vector store sits outside it.
 */
async function recordCompanyUrlPageFetchFailure(
	input: RecordUrlPageFetchFailureActivityInput,
	owner: CompanyContextOwner,
): Promise<RecordUrlPageFetchFailureActivityOutput> {
	const { parentContextId, pageUrl, reason, permanent, userId } = input;
	const { organizationId } = owner;
	const crawls = companyLinkCrawlStore(owner);
	const message = urlPageFetchFailureMessage(reason);

	activityLogger.info("Record company url page fetch failure start", {
		parentContextId,
		organizationId,
		pageUrl,
		permanent,
	});

	const { kept, page } = await crawls.recordPageFetchFailure(
		parentContextId,
		{ pageUrl, message, permanent },
	);

	if (page && page.embeddedAt !== null) {
		// An unresolved model keeps the page's vectors: they may be the
		// current model's, and a page that cannot be fetched cannot be
		// re-embedded. The next crawl's upsert, or its finalize, decides.
		const current = await currentCompanyEmbeddingModel(
			owner,
			userId,
			"keeping the page's vectors",
		);
		if (current !== null && page.embeddingModel !== current) {
			await deleteCompanyContextRowPoints({
				organizationId,
				contextIds: [page.id],
			});
			await crawls.recordPageFailure(page.id, message, {
				pointsRemoved: true,
			});
			activityLogger.info(
				"Removed another embedding model's vectors from a company url page that could not be fetched",
				{ parentContextId, pageId: page.id },
			);
		}
	}

	activityLogger.info("Record company url page fetch failure done", {
		parentContextId,
		pageUrl,
		pageId: page?.id ?? null,
		kept,
	});

	return { kept };
}
