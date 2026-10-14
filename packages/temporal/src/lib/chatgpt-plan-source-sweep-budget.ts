/**
 * Time and size bounds of the ChatGPT plan source-row sweep (Fizzy #3038),
 * shared by the activity, the workflow and the schedule so each one sizes
 * itself from the same numbers.
 *
 * Dependency-free, so the workflow can import it without the activity layer
 * or `@repo/database`.
 *
 * One activity attempt, worst case:
 *   candidate query
 *   + RUN_BUDGET (3 min): no source transaction starts after it
 *   + one source past it (30 s: the 10 s connection wait plus the 20 s
 *     transaction timeout of `withRefreshLock`, the value
 *     `chatGptPlanSourceSweepSourceWorstCaseMs()` in `@repo/database`
 *     computes; the schedule test asserts this copy is not smaller)
 *   = candidate query + 3.5 min, inside the 5-minute start-to-close with
 *     1.5 min left for the query. The batch is not the bound here: 50
 *     sources at 30 s each would be 25 min, so the deadline is what stops an
 *     attempt; in a healthy run each source takes milliseconds and a batch
 *     finishes long before it.
 *
 * One activity call with its retries, worst case:
 *   3 attempts x 5 min + backoff (30 s + 60 s) = 16.5 min.
 *
 * One workflow run, worst case:
 *   MAX_ITERATIONS (50) calls x 16.5 min = 825 min (13.75 h), which the
 *   schedule's execution timeout must exceed while staying under the day
 *   between triggers.
 */

/** Candidates one activity call reads. */
export const CHATGPT_PLAN_SOURCE_SWEEP_BATCH_SIZE = 50;

/**
 * Longest one source's transaction can take: `REFRESH_LOCK_MAX_WAIT_MS`
 * (10 s) plus `REFRESH_LOCK_TRANSACTION_TIMEOUT_MS` (20 s).
 */
export const CHATGPT_PLAN_SOURCE_SWEEP_SOURCE_WORST_CASE_MS = 30_000;

/** After this much of an attempt, no further source transaction starts. */
export const CHATGPT_PLAN_SOURCE_SWEEP_RUN_BUDGET_MS = 3 * 60_000;

/** The activity's options, in milliseconds so the arithmetic can use them. */
export const CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS = {
	startToCloseTimeout: 5 * 60_000,
	retry: {
		initialInterval: 30_000,
		maximumInterval: 5 * 60_000,
		backoffCoefficient: 2,
		maximumAttempts: 3,
	},
} as const;

/**
 * Activity calls one workflow run makes at most. A backstop: at 50 sources a
 * call it covers 2,500 candidates in a healthy run. A run that reaches it
 * stops and fails, so an unfinished walk is never reported as a clean one.
 */
export const CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS = 50;

/**
 * Worst case of one activity call's execution, all its attempts and backoff
 * included. Time an attempt spends queued for a free worker is not part of
 * `startToCloseTimeout`, so this bounds execution, not wall-clock time; the
 * workflow's execution timeout is what bounds the run as a whole.
 */
export function chatGptPlanSourceSweepActivityCallWorstCaseMs(): number {
	const { startToCloseTimeout, retry } =
		CHATGPT_PLAN_SOURCE_SWEEP_ACTIVITY_OPTIONS;
	let backoff = 0;
	for (
		let retryIndex = 0;
		retryIndex < retry.maximumAttempts - 1;
		retryIndex++
	) {
		backoff += Math.min(
			retry.initialInterval * retry.backoffCoefficient ** retryIndex,
			retry.maximumInterval,
		);
	}
	return startToCloseTimeout * retry.maximumAttempts + backoff;
}

/** Worst case of one workflow run: every call at its worst, up to the cap. */
export function chatGptPlanSourceSweepRunWorstCaseMs(): number {
	return (
		CHATGPT_PLAN_SOURCE_SWEEP_MAX_ITERATIONS *
		chatGptPlanSourceSweepActivityCallWorstCaseMs()
	);
}
