/**
 * Background work that runs out of ChatGPT plan waits for a reset and tries
 * once more (Fizzy #2770).
 *
 * When every plan a background step may use is spent, the step fails with
 * `SubscriptionPlanExhaustedError` — non-retryable, so Temporal does not
 * hammer the plan. This helper then asks how long until the earliest known
 * reset, waits on a durable workflow timer (never an activity sleep: a worker
 * restart must not lose or repeat the wait), capped at six hours, and runs
 * the step once more. A second failure is final and reaches the workflow's
 * own failure handling, so the run ends visibly failed.
 *
 * Only for workflows whose steps may run on a shared plan: those of a job
 * type in `PLAN_POOL_BACKGROUND_JOB_TYPES`. An allowlist test pins which
 * workflows import this. Every command it adds sits behind
 * `patched("chatgpt-plan-wait")`, so histories recorded before it replay
 * unchanged.
 */

import { patched, proxyActivities, sleep } from "@temporalio/workflow";
import type { estimatePlanPoolResetActivity as EstimatePlanPoolResetFn } from "../../activities/chatgpt-plan-wait";

export const CHATGPT_PLAN_WAIT_PATCH = "chatgpt-plan-wait";

/** The longest a run waits for a plan window, whatever the estimate. */
export const MAX_CHATGPT_PLAN_WAIT_MS = 6 * 60 * 60_000;

const PLAN_EXHAUSTED_TYPE = "SubscriptionPlanExhaustedError";

const { estimatePlanPoolResetActivity } = proxyActivities<{
	estimatePlanPoolResetActivity: typeof EstimatePlanPoolResetFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 3, initialInterval: "2s" },
});

// Read by name and type, the fields Temporal sets on every activity failure,
// rather than by class.
function isPlanExhausted(error: unknown): boolean {
	const failure = error as { name?: unknown; cause?: { type?: unknown } };
	return (
		failure?.name === "ActivityFailure" &&
		failure.cause?.type === PLAN_EXHAUSTED_TYPE
	);
}

export interface ChatGptPlanWaitOptions {
	organizationId?: string | null;
	/** The member whose own plan may serve the step. */
	userId?: string | null;
	/** Told how long the run is about to wait, for its progress query. */
	onWait?: (waitMs: number) => void;
}

export async function withChatGptPlanWait<T>(
	step: () => Promise<T>,
	options: ChatGptPlanWaitOptions,
): Promise<T> {
	if (!patched(CHATGPT_PLAN_WAIT_PATCH)) {
		return step();
	}
	try {
		return await step();
	} catch (error) {
		if (!isPlanExhausted(error)) {
			throw error;
		}
		const { waitMs, jitterMs } = await estimatePlanPoolResetActivity({
			organizationId: options.organizationId ?? null,
			userId: options.userId ?? null,
		});
		const wait = Math.min(waitMs + jitterMs, MAX_CHATGPT_PLAN_WAIT_MS);
		// Zero when the organization lets the retry run on its own provider.
		if (wait > 0) {
			options.onWait?.(wait);
			await sleep(wait);
		}
		return step();
	}
}
