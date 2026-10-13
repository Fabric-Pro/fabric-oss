/**
 * ChatGPT plan source-row sweep activity (Fizzy #3038).
 *
 * Deletes the breaker, served-model, budget-observation and window-accuracy
 * rows of ChatGPT plan sources that no longer exist: a member's own plan
 * whose user was deleted, or a shared account whose organization was purged.
 * Those deletes cascade the sign-in but cannot reach these rows, which have
 * no foreign key. The query owns the safety rules (each source re-checked
 * under its own advisory lock, see `chatgpt-plan-source-sweep.ts` in
 * `@repo/database`); this activity handles one page of candidates after the
 * workflow's cursor, within a wall-clock budget, and logs what it did.
 *
 * A source whose transaction failed is returned, not thrown: the workflow
 * moves past it, finishes the walk, and then fails the run so a persistent
 * failure shows. Throwing here would make Temporal retry the whole page.
 * A failure of the page itself (the candidate query) does throw and is
 * retried. Idempotent: a retry from the same cursor finds only what is still
 * left.
 */

import {
	type ChatGptPlanOrphanedSource,
	sweepOrphanedChatGptPlanSourceRows,
} from "@repo/database";
import { logger } from "@repo/logs";
import {
	CHATGPT_PLAN_SOURCE_SWEEP_BATCH_SIZE,
	CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS,
} from "../lib/chatgpt-plan-source-sweep-budget";

export type SweepChatGptPlanSourceRowsInput = {
	/** Exclusive cursor from the previous call; `null` for the first page. */
	after: ChatGptPlanOrphanedSource | null;
};

export type SweepChatGptPlanSourceRowsResult = Awaited<
	ReturnType<typeof sweepOrphanedChatGptPlanSourceRows>
>;

export async function sweepChatGptPlanSourceRowsActivity(
	input: SweepChatGptPlanSourceRowsInput,
): Promise<SweepChatGptPlanSourceRowsResult> {
	// Measured from the function's start, as the instruction sync-receipt
	// reaper measures its budget; the budget module explains the margin.
	const deadline = Date.now() + CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS;
	const result = await sweepOrphanedChatGptPlanSourceRows({
		limit: CHATGPT_PLAN_SOURCE_SWEEP_BATCH_SIZE,
		after: input.after,
		deadline,
	});

	logger.info(
		{
			event: "chatgpt_plan.source_sweep.page",
			after: input.after,
			candidates: result.candidates,
			sourcesSwept: result.sourcesSwept,
			sourcesKept: result.sourcesKept,
			sourcesFailed: result.sourcesFailed.length,
			sourcesNotReached: result.sourcesNotReached,
			deleted: result.deleted,
			nextCursor: result.nextCursor,
		},
		`[ChatGptPlanSourceSweep] Swept ${result.sourcesSwept} of ${result.candidates} sources without a sign-in (kept ${result.sourcesKept}, failed ${result.sourcesFailed.length}, not reached ${result.sourcesNotReached})`,
	);
	if (result.sourcesNotReached > 0) {
		logger.warn(
			{
				event: "chatgpt_plan.source_sweep.budget_reached",
				budgetMs: CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS,
				sourcesNotReached: result.sourcesNotReached,
			},
			"[ChatGptPlanSourceSweep] Time budget reached; the next page resumes after the last source handled",
		);
	}
	if (result.sourcesFailed.length > 0) {
		logger.error(
			{
				event: "chatgpt_plan.source_sweep.failed_sources",
				failures: result.sourcesFailed.slice(0, 10),
			},
			"[ChatGptPlanSourceSweep] Some sources could not be swept; the walk moves past them and the run fails at its end",
		);
	}
	return result;
}
