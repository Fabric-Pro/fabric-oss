/**
 * Stale-generation watchdog workflow.
 *
 * Cron-driven safety net for `ProjectDocument` rows left GENERATING by a
 * dispatch whose workflow never started. The dispatch helper recovers every
 * case it can prove and deliberately declines to guess at the one it cannot —
 * an unreachable `describe()` cannot distinguish a lost start from a lost
 * response, and failing on that ambiguity risks a second run racing a live one.
 * This sweep answers the same question later, when Temporal is reachable and
 * the answer is no longer ambiguous.
 *
 * Two guards keep it conservative, because it writes a terminal status a user
 * sees. A row must be past the staleness ceiling AND Temporal must confirm
 * nothing is running under its workflow id; every uncertainty in that check
 * reads as live, so the row is skipped and retried next tick rather than failed.
 * The write itself is scoped to the attempt that was scanned, so a row
 * re-dispatched in between is left alone.
 *
 * Mirrors `backlogApplyWatchdogWorkflow`.
 */

import { log, proxyActivities } from "@temporalio/workflow";
import type * as activities from "../activities";

const {
	findStaleGeneratingDocumentsActivity,
	isGenerationWorkflowLiveActivity,
	markGenerationTimedOutActivity,
} = proxyActivities<typeof activities>({
	startToCloseTimeout: "2 minutes",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumInterval: "30s",
		maximumAttempts: 3,
	},
});

export interface DocumentGenerationWatchdogInput {
	/**
	 * Documents dispatched more than this many minutes ago and still GENERATING
	 * are candidates. Defaults to `FABRIC_DOCUMENT_GENERATION_STALE_MINUTES`, or
	 * 30 when unset. The default applies even when the caller passes 0, which
	 * would otherwise sweep every in-flight generation.
	 */
	staleAfterMinutes?: number;
	/** Max rows per tick — keeps each run bounded. */
	batchSize?: number;
}

export interface DocumentGenerationWatchdogOutput {
	failed: number;
	skippedLive: number;
	scanned: number;
}

export async function documentGenerationWatchdogWorkflow(
	input: DocumentGenerationWatchdogInput = {},
): Promise<DocumentGenerationWatchdogOutput> {
	// `process.env` is non-deterministic in a workflow under SDK 1.16 with
	// `reuseV8Context`, so the env-or-default fallback lives in the activity.
	// Passing 0 hands it that decision.
	const staleAfterMinutes =
		input.staleAfterMinutes && input.staleAfterMinutes > 0
			? input.staleAfterMinutes
			: 0;
	const batchSize =
		input.batchSize && input.batchSize > 0 ? input.batchSize : 50;

	const stale = await findStaleGeneratingDocumentsActivity({
		staleAfterMinutes,
		batchSize,
	});

	let failed = 0;
	let skippedLive = 0;

	for (const row of stale.rows) {
		try {
			// A row with no workflow id never got as far as recording one, so
			// there is nothing that could be running for it.
			if (row.workflowId) {
				const live = await isGenerationWorkflowLiveActivity({
					workflowId: row.workflowId,
				});
				if (live) {
					skippedLive++;
					continue;
				}
			}

			await markGenerationTimedOutActivity({
				documentId: row.documentId,
				generationStartedAtMs: row.generationStartedAtMs,
			});
			failed++;
		} catch (err) {
			log.error("document_generation_watchdog_row_failed", {
				documentId: row.documentId,
				workflowId: row.workflowId,
				error: err instanceof Error ? err.message : String(err),
			});
			// Continue — one bad row must not stop the sweep.
		}
	}

	log.info("document_generation_watchdog_completed", {
		failed,
		skippedLive,
		scanned: stale.rows.length,
		staleAfterMinutes,
		batchSize,
	});

	return { failed, skippedLive, scanned: stale.rows.length };
}
