/**
 * Context re-enrichment sweep activity (Fizzy #2770).
 *
 * A project context embedded while every ChatGPT plan that could serve its
 * contextual enrichment was spent keeps its chunks, unenriched, and carries
 * `contextEnrichmentRetryAt` — the plan's reset, or a backoff. This pass takes
 * a bounded batch of rows whose time has come and re-embeds each through the
 * guarded re-embed (`embedSingleContextActivity` with `reembed: true`), which
 * reads the row's current content and ends on the version the row holds. The
 * embed itself writes the outcome: the marker is cleared once every chunk is
 * enriched, or pushed to the next reset when the plan is still spent.
 *
 * Idempotent: a row is selected only while its marker is due, and a retry
 * re-embeds whatever version the row holds. It stops at the first row the
 * plan defers again — the rest of the batch would only be refused too.
 *
 * Runs inside the conversation-bundle embedding sweep's schedule rather than
 * one of its own.
 */

import {
	db,
	listContextsDueForReenrichment,
	setContextEnrichmentRetryAt,
} from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";
import { embedSingleContextActivity } from "./context-embedding";

/** Rows re-embedded per tick, at most; each is a full re-chunk and re-embed. */
const CONTEXT_REENRICHMENT_BATCH_SIZE = 5;

/**
 * No new row is started past this much wall-clock time. Enrichment is one
 * sequential model call per chunk, so a single large context can take minutes;
 * the budget sits well under the workflow's start-to-close so a run that is
 * still finishing its last row is not abandoned and re-run by the next tick.
 */
const CONTEXT_REENRICHMENT_RUN_BUDGET_MS = 3 * 60 * 1000;

/** How far a row that failed to re-embed is pushed back. */
const CONTEXT_REENRICHMENT_FAILURE_BACKOFF_MS = 60 * 60 * 1000;

export interface ReenrichDeferredContextsResult {
	/** Due rows selected this tick. */
	candidates: number;
	/** Re-embedded with every chunk enriched. */
	reenriched: number;
	/** Re-embedded, but the plan was still spent; the batch stopped there. */
	deferredAgain: number;
	/** Nothing left to enrich (the row emptied, or has no owner to run as). */
	cleared: number;
	/** The re-embed threw; pushed back by the failure backoff. */
	failed: number;
	/** Left for the next tick: the run's time budget was spent. */
	notReached: number;
}

export async function reenrichDeferredContextsActivity(): Promise<ReenrichDeferredContextsResult> {
	const now = new Date();
	const deadline = now.getTime() + CONTEXT_REENRICHMENT_RUN_BUDGET_MS;
	const due = await listContextsDueForReenrichment({
		now,
		limit: CONTEXT_REENRICHMENT_BATCH_SIZE,
	});
	const result: ReenrichDeferredContextsResult = {
		candidates: due.length,
		reenriched: 0,
		deferredAgain: 0,
		cleared: 0,
		failed: 0,
		notReached: 0,
	};

	for (const [index, row] of due.entries()) {
		if (Date.now() >= deadline) {
			result.notReached = due.length - index;
			break;
		}
		heartbeat({ contextId: row.id });

		if (!row.userId) {
			// Model resolution runs as a member; a row with none cannot be
			// re-embedded here, and leaving it due would hold the head of the
			// queue forever.
			await setContextEnrichmentRetryAt(row.id, null);
			result.cleared++;
			continue;
		}

		try {
			await embedSingleContextActivity({
				contextId: row.id,
				projectId: row.projectId,
				userId: row.userId,
				organizationId: row.organizationId ?? undefined,
				type: row.type,
				metadata: {
					filename:
						row.originalFilename ?? row.sourcePath ?? undefined,
					mimeType: row.mimeType ?? undefined,
					sourceUrl: row.sourceUrl ?? undefined,
					sourceTitle: row.sourceTitle ?? undefined,
					sourcePath: row.sourcePath ?? undefined,
				},
				reembed: true,
			});
		} catch (error) {
			logger.warn(
				{
					event: "context_reenrichment.failed",
					contextId: row.id,
					error:
						error instanceof Error ? error.message : String(error),
				},
				"[ContextReenrichment] Re-embed failed; retrying after the backoff",
			);
			await setContextEnrichmentRetryAt(
				row.id,
				new Date(Date.now() + CONTEXT_REENRICHMENT_FAILURE_BACKOFF_MS),
			);
			result.failed++;
			continue;
		}

		const after = await db.projectContext.findUnique({
			where: { id: row.id },
			select: { contextEnrichmentRetryAt: true },
		});
		const retryAt = after?.contextEnrichmentRetryAt ?? null;
		if (retryAt === null) {
			result.reenriched++;
			continue;
		}
		if (retryAt.getTime() > now.getTime()) {
			result.deferredAgain++;
			break;
		}
		// The embed wrote no outcome: the row was emptied or deleted under
		// us, so nothing is owed any more.
		await setContextEnrichmentRetryAt(row.id, null);
		result.cleared++;
	}

	if (result.candidates > 0) {
		logger.info(
			{ event: "context_reenrichment.tick", ...result },
			`[ContextReenrichment] Re-enriched ${result.reenriched} of ${result.candidates} due contexts (deferred again ${result.deferredAgain}, cleared ${result.cleared}, failed ${result.failed}, not reached ${result.notReached})`,
		);
	}
	return result;
}
