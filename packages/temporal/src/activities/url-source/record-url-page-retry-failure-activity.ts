/**
 * Record URL Page Retry Failure Activity (URL Context Sources)
 *
 * Puts a page back to FAILED when a retry of it failed. A page retry
 * (`resyncUrlPage`) sets the page PENDING and keeps its reason; without this,
 * a retry that failed left the page PENDING, with nothing running that would
 * ever finish it.
 *
 * Which reason the page gets when the retry could not fetch it
 * (`urlPageRetryFetchFailureWritableWhere`):
 *   - the fetch failure's — `URL_PAGE_FETCH_FAILURE_PREFIX` and the cause —
 *     when it holds no vectors or a failed fetch had already marked it, so a
 *     later fetch of unchanged content completes or indexes it as for any page
 *     a crawl could not fetch;
 *   - its earlier one otherwise: a page that failed for another reason may
 *     hold an earlier version's vectors, which a fetch failure's reason would
 *     let a later fetch restore.
 *
 * When the retry fetched the page but could not index it (its upsert or embed
 * threw):
 *   - a page the upsert rewrote (the write clears the reason) gets the index
 *     failure's reason. It may hold the earlier version's vectors, so the
 *     reason is never a fetch failure's;
 *   - a page the upsert never reached keeps its earlier reason, as it was.
 * A page the embed itself marked FAILED is no longer PENDING and is left as
 * it is.
 *
 * Only a PENDING page changes, so a page another write has moved on is left
 * as it is, and recording the failure again leaves the same state.
 *
 * Project sources only: the company context list has no page retry.
 *
 * Errors are not swallowed: Temporal retries the activity.
 */
import {
	urlPageFetchFailureMessage,
	urlPageRetryFetchFailureWritableWhere,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import {
	type ContextOwner,
	resolveContextOwner,
} from "../../lib/context-owner";
import { activityLogger } from "../lib/activity-logger";

export interface RecordUrlPageRetryFailureActivityInput {
	parentContextId: string;
	/** The parent's project; absent for a company source. */
	projectId?: string;
	/** The URL the retry requested. */
	pageUrl: string;
	/** Why the retry failed. */
	reason: string;
	/**
	 * Where the retry failed: fetching the page (the default), or indexing
	 * what it fetched.
	 */
	stage?: "fetch" | "index";
	/** Who owns the parent; absent is the project owner (`../../lib/context-owner`). */
	owner?: ContextOwner;
}

export interface RecordUrlPageRetryFailureActivityOutput {
	/** Which reason the page was left with, or `none` when it did not change. */
	outcome: "fetch-failure" | "index-failure" | "earlier-reason" | "none";
}

export async function recordUrlPageRetryFailureActivity(
	input: RecordUrlPageRetryFailureActivityInput,
): Promise<RecordUrlPageRetryFailureActivityOutput> {
	const { parentContextId, pageUrl, reason, stage = "fetch" } = input;

	if (resolveContextOwner(input).kind === "company") {
		activityLogger.warn(
			"Page retry failure recorded for a company source",
			{
				parentContextId,
				pageUrl,
			},
		);
		return { outcome: "none" };
	}

	const page = { parentContextId, pageUrl };
	const marked =
		stage === "fetch"
			? await db.projectContextUrlPage.updateMany({
					where: {
						...page,
						...urlPageRetryFetchFailureWritableWhere(),
					},
					data: {
						extractionStatus: "FAILED",
						extractionError: urlPageFetchFailureMessage(reason),
					},
				})
			: await db.projectContextUrlPage.updateMany({
					where: {
						...page,
						extractionStatus: "PENDING",
						extractionError: null,
					},
					data: {
						extractionStatus: "FAILED",
						extractionError: `Could not index this page: ${reason.trim() || "unknown error"}`,
					},
				});

	let outcome: RecordUrlPageRetryFailureActivityOutput["outcome"] =
		stage === "fetch" ? "fetch-failure" : "index-failure";
	if (marked.count === 0) {
		const reverted = await db.projectContextUrlPage.updateMany({
			where: { ...page, extractionStatus: "PENDING" },
			data: { extractionStatus: "FAILED" },
		});
		outcome = reverted.count > 0 ? "earlier-reason" : "none";
	}

	activityLogger.info("Record url page retry failure done", {
		parentContextId,
		pageUrl,
		stage,
		outcome,
	});

	return { outcome };
}
