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

// From common, the same class the workflow package re-exports: the pause
// subclasses it at module load, and suites that stub the workflow package
// still load this module.
import { ApplicationFailure } from "@temporalio/common";
import {
	patched,
	proxyActivities,
	sleep,
	workflowInfo,
} from "@temporalio/workflow";
import type {
	estimatePlanPoolResetActivity as EstimatePlanPoolResetFn,
	notifyPlanWaitWorkStoppedActivity as NotifyPlanWaitWorkStoppedFn,
	NotifyPlanWaitWorkStoppedInput,
} from "../../activities/chatgpt-plan-wait";

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

const { notifyPlanWaitWorkStoppedActivity } = proxyActivities<{
	notifyPlanWaitWorkStoppedActivity: typeof NotifyPlanWaitWorkStoppedFn;
}>({
	startToCloseTimeout: "1 minute",
	retry: { maximumAttempts: 2, initialInterval: "2s" },
});

/**
 * The stopped notice (Fizzy #3050): a command added on the final-failure
 * branches, so histories that failed before it replay unchanged.
 */
export const CHATGPT_PLAN_STOPPED_NOTICE_PATCH =
	"chatgpt-plan-stopped-notice-v1";

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
	/**
	 * A run with a hard deadline of its own: when the reset is further off
	 * than this, the step fails at once instead of waiting past the deadline.
	 * A function is read when the step fails, for a budget that shrinks as
	 * the run goes on ({@link untilRunDeadline}).
	 */
	maxWaitMs?: number | (() => number | undefined);
	/**
	 * A run that pauses instead of waiting long (Fizzy #2770): when the reset
	 * is further off than this, or past the run's deadline, or the step is
	 * refused again after a short wait, it throws {@link ChatGptPlanPause}
	 * and the workflow saves its progress and ends. Behind
	 * `patched("bulk-pause-resume-v1")`.
	 */
	pauseBeyondMs?: number;
	/**
	 * Set where a final plan-spent failure ends the work, never where the run
	 * carries on without the step: whoever started it and the organization's
	 * admins are told it stopped (Fizzy #3050). The initiator defaults to
	 * `userId`; name it where that is not who started the work.
	 */
	stoppedNotice?: Pick<
		NotifyPlanWaitWorkStoppedInput,
		"work" | "projectId" | "link"
	> &
		Partial<Pick<NotifyPlanWaitWorkStoppedInput, "initiatorUserId">>;
}

export const BULK_RUN_PAUSE_PATCH = "bulk-pause-resume-v1";

const CHATGPT_PLAN_PAUSE_TYPE = "ChatGptPlanPause";

/**
 * Waits up to this long in the run before pausing: a short wait costs less
 * than ending the run and starting another.
 */
export const BULK_RUN_PAUSE_BEYOND_MS = 10 * 60_000;

/**
 * Every shared plan is spent for longer than the run should wait in place:
 * the workflow pauses (`workflows/lib/bulk-run-pause.ts`) and a resume run
 * starts when the plans reset.
 */
export class ChatGptPlanPause extends ApplicationFailure {
	/** What the step had finished, for a step that fans out. */
	progress: unknown;

	constructor(
		/** Until the earliest known reset, jitter included. */
		readonly waitMs: number,
		/** False when no plan said when it resets. */
		readonly resetKnown: boolean,
	) {
		// An ApplicationFailure, so one that escapes a workflow fails the run
		// instead of retrying its task forever; the type and details carry it
		// across a child workflow's boundary (`chatGptPlanPauseOf`).
		super(
			"Every ChatGPT plan this work may use is spent; pausing.",
			CHATGPT_PLAN_PAUSE_TYPE,
			true,
			[{ waitMs, resetKnown }],
		);
	}
}

/**
 * The pause inside an error: thrown here, or carried by a child workflow's
 * failure. Null for any other error.
 */
export function chatGptPlanPauseOf(error: unknown): ChatGptPlanPause | null {
	if (error instanceof ChatGptPlanPause) {
		return error;
	}
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		const failure = current as {
			type?: unknown;
			details?: unknown;
			cause?: unknown;
		};
		if (failure.type === CHATGPT_PLAN_PAUSE_TYPE) {
			const [detail] = Array.isArray(failure.details)
				? (failure.details as Array<{
						waitMs?: unknown;
						resetKnown?: unknown;
					}>)
				: [];
			return new ChatGptPlanPause(
				typeof detail?.waitMs === "number" ? detail.waitMs : 0,
				detail?.resetKnown !== false,
			);
		}
		current = failure.cause;
	}
	return null;
}

/**
 * How long a run with an execution timeout may still wait and leave
 * `reserveMs` for the step it retries and what follows; undefined for a run
 * without one. An execution timeout cannot be caught, so a wait that overran
 * it would replace the run's own plan-spent failure with a silent timeout.
 */
export function untilRunDeadline(reserveMs: number): () => number | undefined {
	return () => {
		const info = workflowInfo();
		// Not every server fills in the expiration time; the timeout and the
		// execution's start say the same thing.
		const expires =
			info.executionExpirationTime?.getTime() ??
			(info.executionTimeoutMs === undefined
				? undefined
				: info.startTime.getTime() + info.executionTimeoutMs);
		return expires === undefined
			? undefined
			: Math.max(0, expires - Date.now() - reserveMs);
	};
}

/**
 * What a fan-out step finished before every plan ran out, from the details
 * of its plan-spent failure; undefined for any other failure.
 */
function planSpentProgress<P>(error: unknown): P | undefined {
	if (!isPlanExhausted(error)) {
		return undefined;
	}
	const details = (error as { cause?: { details?: unknown } }).cause?.details;
	return Array.isArray(details) ? (details[0] as P | undefined) : undefined;
}

/**
 * A plan-spent activity failure as a plain error carrying the plan's own
 * sentence, for a run that reports a failure by its message (an activity
 * failure's own reads "Activity task failed"); null for any other failure.
 */
export function planSpentFailureAsError(error: unknown): Error | null {
	if (!isPlanExhausted(error)) {
		return null;
	}
	const message = (error as { cause?: { message?: unknown } }).cause?.message;
	return new Error(
		typeof message === "string" && message
			? message
			: "Every ChatGPT plan this work may use has no usage left in this window.",
	);
}

/**
 * {@link withChatGptPlanWait} for a step that fans out inside one activity:
 * the activity reports what it finished in its plan-spent failure, and the
 * retry after the wait is handed that progress, so only the rest runs.
 */
export async function withChatGptPlanWaitResuming<P, T>(
	step: (resume: P | undefined) => Promise<T>,
	options: ChatGptPlanWaitOptions & {
		/** What an earlier run of this step finished before it paused. */
		resumeFrom?: P;
	},
): Promise<T> {
	let resume: P | undefined = options.resumeFrom;
	try {
		return await withChatGptPlanWait(async () => {
			try {
				return await step(resume);
			} catch (error) {
				resume = planSpentProgress<P>(error) ?? resume;
				throw error;
			}
		}, options);
	} catch (error) {
		if (error instanceof ChatGptPlanPause) {
			error.progress = resume;
		}
		throw error;
	}
}

async function estimateReset(options: ChatGptPlanWaitOptions) {
	const { waitMs, jitterMs, resetKnown } =
		await estimatePlanPoolResetActivity({
			organizationId: options.organizationId ?? null,
			userId: options.userId ?? null,
		});
	return { waitMs: waitMs + jitterMs, resetKnown: resetKnown ?? true };
}

/**
 * Announces a final plan-spent failure when the caller asked for it. A failed
 * notice is swallowed: the step's own error is what ends the run.
 */
async function noticeStopped(options: ChatGptPlanWaitOptions): Promise<void> {
	if (!options.stoppedNotice || !patched(CHATGPT_PLAN_STOPPED_NOTICE_PATCH)) {
		return;
	}
	const info = workflowInfo();
	try {
		const { initiatorUserId, ...notice } = options.stoppedNotice;
		await notifyPlanWaitWorkStoppedActivity({
			...notice,
			runId: `${info.workflowId}:${info.runId}`,
			organizationId: options.organizationId ?? null,
			initiatorUserId:
				initiatorUserId === undefined
					? (options.userId ?? null)
					: initiatorUserId,
		});
	} catch {
		// The notice never changes how the run ends.
	}
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
		const estimate = await estimateReset(options);
		const wait = Math.min(estimate.waitMs, MAX_CHATGPT_PLAN_WAIT_MS);
		const maxWaitMs =
			typeof options.maxWaitMs === "function"
				? options.maxWaitMs()
				: options.maxWaitMs;
		// A run that may pause ends instead of waiting long (Fizzy #2770):
		// past `pauseBeyondMs`, or past its own deadline. Zero is an AUTO
		// policy, which never pauses, so it records no marker either.
		const pausable =
			options.pauseBeyondMs !== undefined &&
			wait > 0 &&
			patched(BULK_RUN_PAUSE_PATCH);
		if (
			pausable &&
			(wait > (options.pauseBeyondMs ?? 0) ||
				(maxWaitMs !== undefined && wait > maxWaitMs))
		) {
			throw new ChatGptPlanPause(estimate.waitMs, estimate.resetKnown);
		}
		if (maxWaitMs !== undefined && wait > maxWaitMs) {
			await noticeStopped(options);
			throw error;
		}
		// Zero when the organization lets the retry run on its own provider.
		if (wait > 0) {
			options.onWait?.(wait);
			await sleep(wait);
		}
		if (!pausable) {
			try {
				return await step();
			} catch (retryError) {
				if (isPlanExhausted(retryError)) {
					await noticeStopped(options);
				}
				throw retryError;
			}
		}
		try {
			return await step();
		} catch (retryError) {
			if (!isPlanExhausted(retryError)) {
				throw retryError;
			}
			const again = await estimateReset(options);
			throw new ChatGptPlanPause(again.waitMs, again.resetKnown);
		}
	}
}
