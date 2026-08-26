import {
	CONTEXT_SUMMARY_ENGINE_VERSION,
	type ContextVolumeCandidate,
	countRawContextChars,
	estimateTokensFromChars,
	getContextVolumeCandidates,
	getLatestCompletedContextSummary,
} from "@repo/database";
import { logger } from "@repo/logs";
import { isContextSummarizationEnabled } from "@repo/utils/feature-flag";
import { heartbeat } from "@temporalio/activity";
import { startContextSummarizationWorkflow } from "../../lib/start-context-summarization";

const DEFAULT_TOKEN_THRESHOLD = 50_000;
const DEFAULT_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function resolvePositiveIntEnv(
	raw: string | undefined,
	fallback: number,
): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Decide whether a candidate project's context volume warrants a fresh summary,
 * given its current summary (if any):
 *   - No summary yet AND its total raw volume clears the token threshold; or
 *   - New context has landed since the last summary (`latestContextAt >
 *     coveredThrough`) AND either the uncovered volume clears the threshold OR
 *     the summary is older than the staleness window.
 */
async function qualifies(
	candidate: ContextVolumeCandidate,
	tokenThreshold: number,
	staleDays: number,
): Promise<boolean> {
	const summary = await getLatestCompletedContextSummary({
		projectId: candidate.projectId,
		userId: candidate.userId,
		organizationId: candidate.organizationId,
	});

	if (!summary) {
		return estimateTokensFromChars(candidate.rawChars) >= tokenThreshold;
	}

	// Legacy (v1) summaries carry an untrustworthy, over-advanced watermark — the
	// map-reduce engine must rebuild them so their coverage becomes real. Always
	// re-qualify regardless of the (unreliable) `coveredThrough` comparison.
	if (summary.engineVersion < CONTEXT_SUMMARY_ENGINE_VERSION) {
		return true;
	}

	if (candidate.latestContextAt <= summary.coveredThrough) {
		// Nothing new since the last summary — it's still complete.
		return false;
	}

	const uncoveredChars = await countRawContextChars({
		projectId: candidate.projectId,
		after: summary.coveredThrough,
	});
	const uncoveredIsLarge =
		estimateTokensFromChars(uncoveredChars) >= tokenThreshold;
	const daysSinceSummary =
		(Date.now() - summary.coveredThrough.getTime()) / MS_PER_DAY;

	return uncoveredIsLarge || daysSinceSummary >= staleDays;
}

/**
 * The auto-trigger cron handler. No-ops when the feature is off. Otherwise runs
 * one cheap grouped pre-filter, refines each candidate against its latest
 * summary, and dispatches a summarization run for the ones that qualify. The
 * dispatcher's dedup + the in-progress guard keep it overlap-safe, so a run
 * that spills past the daily tick is never double-started.
 */
export async function scanAndDispatchContextSummariesActivity(): Promise<{
	scanned: number;
	dispatched: number;
}> {
	if (!isContextSummarizationEnabled()) {
		logger.info(
			"[Context Summarization] feature disabled — skipping auto-scan",
		);
		return { scanned: 0, dispatched: 0 };
	}

	const tokenThreshold = resolvePositiveIntEnv(
		process.env.CONTEXT_SUMMARIZATION_TOKEN_THRESHOLD,
		DEFAULT_TOKEN_THRESHOLD,
	);
	const staleDays = resolvePositiveIntEnv(
		process.env.CONTEXT_SUMMARIZATION_STALE_DAYS,
		DEFAULT_STALE_DAYS,
	);

	// Grouped pre-filter: only projects whose total raw volume could plausibly
	// clear the token threshold (chars ≈ tokens × 4).
	const candidates = await getContextVolumeCandidates({
		minChars: tokenThreshold * 4,
	});

	let dispatched = 0;
	for (const candidate of candidates) {
		heartbeat(`context-summarization scan: ${candidate.projectId}`);
		try {
			if (!(await qualifies(candidate, tokenThreshold, staleDays))) {
				continue;
			}
			const { started } = await startContextSummarizationWorkflow({
				projectId: candidate.projectId,
				userId: candidate.userId,
				organizationId: candidate.organizationId,
				trigger: "AUTO",
			});
			if (started) {
				dispatched += 1;
			}
		} catch (error) {
			// One project's failure must not block the rest of the sweep.
			logger.warn(
				"[Context Summarization] failed to evaluate/dispatch candidate",
				{
					projectId: candidate.projectId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}
	}

	logger.info("[Context Summarization] auto-scan complete", {
		scanned: candidates.length,
		dispatched,
	});
	return { scanned: candidates.length, dispatched };
}
