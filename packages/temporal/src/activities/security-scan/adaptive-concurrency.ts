/**
 * Adaptive, gateway-aware concurrency for the AI scanners (replaces the fixed
 * `SCAN_CONCURRENCY = 1` serial scan).
 *
 * WHY: a large project (up to the 200-item cap) scanned one chunk at a time is
 * the scan's speed floor. The fixed serial setting existed only because running
 * chunks in parallel blew the AI gateway's tokens-per-minute (TPM) quota — every
 * chunk 429'd and the whole scan failed with zero findings. Rather than pin
 * concurrency to 1 forever, this controller self-tunes to the gateway's REAL
 * limit using AIMD (additive-increase / multiplicative-decrease — the same
 * principle as TCP congestion control, AWS SDK adaptive retry, Netflix's
 * concurrency-limits, and Vector's adaptive request concurrency): speed up while
 * healthy, cut hard the instant it rate-limits, honoring `Retry-After`.
 *
 * BEST-PRACTICE GUARDS (validated against AWS/Netflix/Google-SRE/Vector):
 * - ONE cut per cooldown window. A single TPM breach throws a *burst* of 429s;
 *   cutting on each would collapse straight to serial. So the first 429 cuts +
 *   opens a cooldown; further 429s during it only extend the dispatch gate.
 * - Hysteresis: no increase during the cooldown window (don't ramp back into the
 *   wall we just hit).
 * - TCP-style increase: +1 only after `concurrency` consecutive clean successes,
 *   so growth self-slows as we approach the ceiling.
 * - Honor Retry-After as a dispatch GATE (pause new work), with full jitter to
 *   avoid a synchronized retry stampede.
 * - Bounded [min, max]; degrades to serial (1) under sustained throttling, so it
 *   can NEVER re-introduce the "everything 429'd → zero findings" regression.
 * - A rate-limited chunk is re-queued (not lost); a hard quota/billing error is
 *   terminal; a generic error is retried once then skipped (prior behavior).
 *
 * Pure + fully injectable (`classify`, `sleep`, `now`, `random`) → deterministic
 * to unit-test with a simulated gateway and no real timers.
 *
 * The caller MUST run each task with the SDK's own retry disabled (`maxRetries:
 * 0`) so the raw 429 surfaces here — otherwise the AI SDK silently retries (its
 * default is 2) and this controller never sees the signal it needs to back off.
 */

/** Normalized rate-limit verdict for one failed task (adapts `classifyLimitError`). */
export interface RateLimitVerdict {
	/** A transient rate-limit / overload — back off + retry the task. */
	rateLimited: boolean;
	/** A hard quota/billing exhaustion — retrying will not help; fail the task. */
	hardQuota: boolean;
	/** Provider-supplied Retry-After, in ms, when present. */
	retryAfterMs?: number;
}

export interface AdaptiveConcurrencyOptions<E = unknown> {
	/** Where concurrency starts. Default 3 (ramp from here, not 1). */
	initialConcurrency?: number;
	/** Never drops below this. Default 1 (serial — the safe floor). */
	minConcurrency?: number;
	/** Never rises above this. Default 8 (conservative — a shared gateway). */
	maxConcurrency?: number;
	/** Multiplicative decrease factor applied on the first 429 of a window. Default 0.5. */
	decreaseFactor?: number;
	/** Backoff when the provider gives no Retry-After. Default 5000ms. */
	defaultBackoffMs?: number;
	/** Cap on any single backoff. Default 60000ms. */
	maxBackoffMs?: number;
	/** Minimum "no re-cut / no increase" window after a decrease. Default 10000ms. */
	cooldownFloorMs?: number;
	/** Max full-jitter added to a backoff. Default 250ms. */
	jitterMs?: number;
	/** Max re-queues of one task due to rate-limits before giving up. Default 6. */
	maxRateLimitRetriesPerItem?: number;
	/** Max re-tries of one task due to a GENERIC (non-limit) error. Default 1. */
	maxGenericRetriesPerItem?: number;

	/** Classify a task error → rate-limit verdict. In prod: wraps `classifyLimitError`. */
	classify: (error: E) => RateLimitVerdict;
	/** Sleep hook (injectable for tests). Default real `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Clock hook (injectable for tests). Default `Date.now`. */
	now?: () => number;
	/** [0,1) source for jitter (injectable for tests). Default `Math.random`. */
	random?: () => number;
	/** Fires after each task settles (success or terminal failure) — for heartbeats. */
	onSettled?: (index: number) => void;
	/** Fires on ANY terminal task failure (rate-limit-exhausted, quota, or generic) so the caller can record the underlying cause. */
	onFail?: (index: number, error: E) => void;
	/** Optional observability hook for concurrency changes / rate-limit events. */
	onEvent?: (event: AdaptiveEvent) => void;
}

export type AdaptiveEvent =
	| { type: "increase"; concurrency: number }
	| {
			type: "decrease";
			concurrency: number;
			index: number;
			backoffMs: number;
	  }
	| { type: "rate_limited"; index: number; backoffMs: number }
	| { type: "requeue_exhausted"; index: number };

export interface AdaptiveResult<R> {
	/** Per-item result in input order; `null` where the task ultimately failed. */
	results: Array<R | null>;
	/** Indexes that ultimately failed (rate-limit-exhausted, quota, or generic). */
	failed: number[];
	/** Highest concurrency actually reached (telemetry). */
	peakConcurrency: number;
	/** Concurrency at the end of the run (telemetry). */
	finalConcurrency: number;
	/** Count of 429 events observed (telemetry). */
	rateLimitHits: number;
}

interface Task {
	index: number;
	rlAttempts: number;
	errAttempts: number;
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `runOne` over `items` with AIMD adaptive concurrency. Returns the per-item
 * results (`null` for ultimate failures) + telemetry, mirroring the shape of the
 * prior resilient-scan helper so the caller's aggregation is unchanged.
 */
export async function runChunksAdaptive<T, R, E = unknown>(
	items: T[],
	runOne: (item: T, index: number) => Promise<R>,
	opts: AdaptiveConcurrencyOptions<E>,
): Promise<AdaptiveResult<R>> {
	const minConcurrency = Math.max(1, opts.minConcurrency ?? 1);
	const maxConcurrency = Math.max(minConcurrency, opts.maxConcurrency ?? 8);
	const decreaseFactor = clampFactor(opts.decreaseFactor ?? 0.5);
	const defaultBackoffMs = Math.max(0, opts.defaultBackoffMs ?? 5000);
	const maxBackoffMs = Math.max(defaultBackoffMs, opts.maxBackoffMs ?? 60000);
	const cooldownFloorMs = Math.max(0, opts.cooldownFloorMs ?? 10000);
	const jitterMs = Math.max(0, opts.jitterMs ?? 250);
	const maxRlRetries = Math.max(0, opts.maxRateLimitRetriesPerItem ?? 6);
	const maxErrRetries = Math.max(0, opts.maxGenericRetriesPerItem ?? 1);
	const sleep = opts.sleep ?? defaultSleep;
	const now = opts.now ?? Date.now;
	const random = opts.random ?? Math.random;

	let concurrency = clamp(
		opts.initialConcurrency ?? 3,
		minConcurrency,
		maxConcurrency,
	);
	let successesSinceChange = 0;
	let peakConcurrency = concurrency;
	let rateLimitHits = 0;
	/** Dispatch gate: don't START new work until the clock passes this (Retry-After). */
	let gateUntil = 0;
	/** Suppression window: no re-cut AND no increase until the clock passes this. */
	let cooldownUntil = 0;

	const results = new Array<R | null>(items.length).fill(null);
	const failed: number[] = [];
	const pending: Task[] = items.map((_, index) => ({
		index,
		rlAttempts: 0,
		errAttempts: 0,
	}));

	type Settled =
		| { task: Task; ok: true; value: R }
		| { task: Task; ok: false; error: E };
	const completed: Settled[] = [];
	let inFlight = 0;
	let wake: (() => void) | null = null;
	const settleWake = () => {
		const w = wake;
		wake = null;
		w?.();
	};

	const dispatch = (task: Task): void => {
		inFlight += 1;
		peakConcurrency = Math.max(peakConcurrency, inFlight);
		Promise.resolve()
			.then(() => runOne(items[task.index] as T, task.index))
			.then(
				(value) => completed.push({ task, ok: true, value }),
				(error) =>
					completed.push({ task, ok: false, error: error as E }),
			)
			.finally(() => {
				inFlight -= 1;
				settleWake();
			});
	};

	const finishFailed = (task: Task, error: E): void => {
		failed.push(task.index);
		// Report EVERY terminal failure (rate-limit-exhausted, quota, or generic)
		// to onFail so the caller captures the underlying cause. The wholesale-
		// failure hint depends on seeing these errors, and the throttling case —
		// where every chunk exhausts its rate-limit retries — is exactly when the
		// "rate-limited, try again shortly" guidance matters most.
		opts.onFail?.(task.index, error);
		opts.onSettled?.(task.index);
	};

	const handleSettled = (s: Settled): void => {
		if (s.ok) {
			results[s.task.index] = s.value;
			// Hysteresis: never grow during a cooldown (don't ramp back into the wall).
			if (now() >= cooldownUntil) {
				successesSinceChange += 1;
				// TCP-style: +1 only after `concurrency` clean successes → self-slowing.
				if (
					successesSinceChange >= concurrency &&
					concurrency < maxConcurrency
				) {
					concurrency += 1;
					successesSinceChange = 0;
					opts.onEvent?.({ type: "increase", concurrency });
				}
			}
			opts.onSettled?.(s.task.index);
			return;
		}

		const verdict = opts.classify(s.error);

		if (verdict.rateLimited) {
			rateLimitHits += 1;
			const backoffMs =
				Math.min(
					maxBackoffMs,
					verdict.retryAfterMs && verdict.retryAfterMs > 0
						? verdict.retryAfterMs
						: defaultBackoffMs,
				) + Math.floor(random() * jitterMs);
			// Always extend the dispatch gate (pace re-dispatch past Retry-After).
			gateUntil = Math.max(gateUntil, now() + backoffMs);
			opts.onEvent?.({
				type: "rate_limited",
				index: s.task.index,
				backoffMs,
			});
			// But cut concurrency AT MOST ONCE per cooldown window — a burst of
			// 429s from a single TPM breach must not collapse us to serial.
			if (now() >= cooldownUntil) {
				concurrency = Math.max(
					minConcurrency,
					Math.floor(concurrency * decreaseFactor),
				);
				successesSinceChange = 0;
				cooldownUntil = now() + Math.max(backoffMs, cooldownFloorMs);
				opts.onEvent?.({
					type: "decrease",
					concurrency,
					index: s.task.index,
					backoffMs,
				});
			}
			if (s.task.rlAttempts < maxRlRetries) {
				s.task.rlAttempts += 1;
				pending.unshift(s.task); // retry promptly once the gate lifts
			} else {
				opts.onEvent?.({
					type: "requeue_exhausted",
					index: s.task.index,
				});
				finishFailed(s.task, s.error);
			}
			return;
		}

		if (verdict.hardQuota) {
			// Billing/quota exhaustion — retrying cannot help; fail terminally.
			finishFailed(s.task, s.error);
			return;
		}

		// Generic error — retry once (as the prior resilient scan did), then skip.
		if (s.task.errAttempts < maxErrRetries) {
			s.task.errAttempts += 1;
			pending.push(s.task);
		} else {
			finishFailed(s.task, s.error);
		}
	};

	while (pending.length > 0 || inFlight > 0 || completed.length > 0) {
		// 1) Drain settled results first (apply AIMD before re-dispatching).
		if (completed.length > 0) {
			handleSettled(completed.shift() as Settled);
			continue;
		}

		// 2) Dispatch up to the current concurrency, unless the gate is closed.
		const gating = now() < gateUntil;
		while (!gating && inFlight < concurrency && pending.length > 0) {
			dispatch(pending.shift() as Task);
		}

		// 3) Wait for the right event rather than busy-spinning.
		if (completed.length > 0) {
			continue;
		}
		if (inFlight > 0) {
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		} else if (pending.length > 0 && gating) {
			await sleep(Math.max(1, gateUntil - now()));
		} else if (pending.length === 0 && inFlight === 0) {
			break;
		}
	}

	return {
		results,
		failed,
		peakConcurrency,
		finalConcurrency: concurrency,
		rateLimitHits,
	};
}

function clamp(value: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, Math.round(value)));
}

function clampFactor(value: number): number {
	if (!Number.isFinite(value) || value <= 0) {
		return 0.5;
	}
	return Math.min(0.9, Math.max(0.1, value));
}

/**
 * Adapt `classifyLimitError`'s `LimitSignal` (or any equivalent) into the
 * scheduler's {@link RateLimitVerdict}. Kept here (not in the scheduler) so the
 * scheduler stays free of any @repo/ai dependency and is trivially unit-testable.
 *
 * - `provider_rate_limit` / `provider_overloaded` → rateLimited (back off + retry)
 * - `provider_quota` → hardQuota (terminal — billing/quota won't clear by waiting)
 * - anything else (incl. null / context_length) → neither (generic handling)
 */
export function verdictFromLimitSignal(
	signal: { kind?: string; retryAfterMs?: number } | null | undefined,
): RateLimitVerdict {
	if (!signal) {
		return { rateLimited: false, hardQuota: false };
	}
	if (
		signal.kind === "provider_rate_limit" ||
		signal.kind === "provider_overloaded"
	) {
		return {
			rateLimited: true,
			hardQuota: false,
			retryAfterMs: signal.retryAfterMs,
		};
	}
	if (signal.kind === "provider_quota") {
		return { rateLimited: false, hardQuota: true };
	}
	return { rateLimited: false, hardQuota: false };
}
