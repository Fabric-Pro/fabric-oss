import { describe, expect, it } from "vitest";
import {
	type AdaptiveEvent,
	type RateLimitVerdict,
	runChunksAdaptive,
	verdictFromLimitSignal,
} from "../adaptive-concurrency";

// A rate-limit error shaped like the AI SDK's APICallError (429 + retry-after).
function rateLimitError(): Error & { statusCode: number; headers: object } {
	const e = new Error("429 Too Many Requests") as Error & {
		statusCode: number;
		headers: object;
	};
	e.statusCode = 429;
	e.headers = { "retry-after": "1" };
	return e;
}

const classify = (error: unknown): RateLimitVerdict => {
	const e = error as { statusCode?: number; message?: string };
	if (e?.statusCode === 429) {
		return { rateLimited: true, hardQuota: false, retryAfterMs: 500 };
	}
	if (e?.message === "quota") {
		return { rateLimited: false, hardQuota: true };
	}
	return { rateLimited: false, hardQuota: false };
};

/**
 * Simulate a gateway that rejects (429) whenever MORE than `limit` requests are
 * in flight at once — the exact failure mode that pinned the scanner to serial.
 */
function makeGateway(limit: number) {
	let inFlight = 0;
	let peak = 0;
	let calls = 0;
	const runOne = async (_item: number, index: number): Promise<number> => {
		inFlight += 1;
		calls += 1;
		peak = Math.max(peak, inFlight);
		const over = inFlight > limit;
		await Promise.resolve();
		await Promise.resolve();
		inFlight -= 1;
		if (over) {
			throw rateLimitError();
		}
		return index;
	};
	return { runOne, peak: () => peak, calls: () => calls };
}

/** A fake clock whose `sleep` advances time instantly — fully deterministic. */
function fakeClock() {
	let t = 0;
	return {
		now: () => t,
		sleep: async (ms: number) => {
			t += ms;
		},
	};
}

// Deterministic, jitter-free base opts for rate-limit tests.
function baseOpts(clock: ReturnType<typeof fakeClock>) {
	return {
		classify,
		now: clock.now,
		sleep: clock.sleep,
		random: () => 0, // no jitter → deterministic backoff
	};
}

describe("runChunksAdaptive", () => {
	it("converges below a gateway concurrency ceiling and completes EVERY item", async () => {
		const gw = makeGateway(2);
		const clock = fakeClock();
		const res = await runChunksAdaptive(
			Array.from({ length: 40 }, (_, i) => i),
			gw.runOne,
			{
				...baseOpts(clock),
				initialConcurrency: 8,
				maxConcurrency: 8,
				minConcurrency: 1,
				defaultBackoffMs: 500,
				cooldownFloorMs: 1000,
				maxRateLimitRetriesPerItem: 50,
			},
		);
		// No item is lost: rate-limited chunks are re-queued, not dropped.
		expect(res.results.filter((r) => r !== null)).toHaveLength(40);
		expect(res.failed).toHaveLength(0);
		// It actually hit the ceiling and backed off.
		expect(res.rateLimitHits).toBeGreaterThan(0);
		// It stayed bounded.
		expect(res.finalConcurrency).toBeGreaterThanOrEqual(1);
		expect(res.finalConcurrency).toBeLessThanOrEqual(8);
	});

	it("cuts concurrency AT MOST ONCE per 429 burst (no collapse-to-serial)", async () => {
		// limit 1 → the whole initial fan-out 429s at once (a burst).
		const gw = makeGateway(1);
		const clock = fakeClock();
		const events: AdaptiveEvent[] = [];
		const res = await runChunksAdaptive(
			Array.from({ length: 24 }, (_, i) => i),
			gw.runOne,
			{
				...baseOpts(clock),
				initialConcurrency: 8,
				maxConcurrency: 8,
				minConcurrency: 1,
				defaultBackoffMs: 500,
				cooldownFloorMs: 5000, // wide window → many 429s share one cut
				maxRateLimitRetriesPerItem: 100,
				onEvent: (e) => events.push(e),
			},
		);
		const decreases = events.filter((e) => e.type === "decrease").length;
		// Many 429s were observed...
		expect(res.rateLimitHits).toBeGreaterThan(decreases);
		// ...but concurrency was cut far fewer times (one-per-window), and never
		// more than the log2(initial) it takes to walk 8→4→2→1.
		expect(decreases).toBeLessThanOrEqual(3);
		expect(res.results.filter((r) => r !== null)).toHaveLength(24);
	});

	it("ramps concurrency UP when the gateway is healthy (additive increase)", async () => {
		const gw = makeGateway(Number.POSITIVE_INFINITY); // never rate-limits
		const clock = fakeClock();
		const res = await runChunksAdaptive(
			Array.from({ length: 60 }, (_, i) => i),
			gw.runOne,
			{ ...baseOpts(clock), initialConcurrency: 2, maxConcurrency: 8 },
		);
		expect(res.results.filter((r) => r !== null)).toHaveLength(60);
		expect(res.rateLimitHits).toBe(0);
		// Ramped above the initial 2 (proves additive increase fired).
		expect(res.finalConcurrency).toBeGreaterThan(2);
		expect(res.peakConcurrency).toBeGreaterThan(2);
	});

	it("never exceeds maxConcurrency", async () => {
		const gw = makeGateway(Number.POSITIVE_INFINITY);
		const clock = fakeClock();
		const res = await runChunksAdaptive(
			Array.from({ length: 80 }, (_, i) => i),
			gw.runOne,
			{ ...baseOpts(clock), initialConcurrency: 2, maxConcurrency: 4 },
		);
		expect(gw.peak()).toBeLessThanOrEqual(4);
		expect(res.finalConcurrency).toBeLessThanOrEqual(4);
	});

	it("fails a hard quota error terminally — no infinite retry", async () => {
		const clock = fakeClock();
		let calls = 0;
		const res = await runChunksAdaptive(
			[0, 1, 2],
			async () => {
				calls += 1;
				throw new Error("quota");
			},
			baseOpts(clock),
		);
		expect(res.results).toEqual([null, null, null]);
		expect(res.failed.sort((a, b) => a - b)).toEqual([0, 1, 2]);
		// Each item attempted exactly once (quota is terminal, not retried).
		expect(calls).toBe(3);
	});

	it("retries a generic error once, then skips it", async () => {
		const clock = fakeClock();
		const attempts = new Map<number, number>();
		const res = await runChunksAdaptive(
			[0, 1],
			async (_item, index) => {
				attempts.set(index, (attempts.get(index) ?? 0) + 1);
				throw new Error("boom"); // generic, always fails
			},
			{ ...baseOpts(clock), maxGenericRetriesPerItem: 1 },
		);
		expect(res.failed.sort((a, b) => a - b)).toEqual([0, 1]);
		expect(attempts.get(0)).toBe(2); // 1 original + 1 retry
		expect(attempts.get(1)).toBe(2);
	});

	it("preserves input order in results", async () => {
		const clock = fakeClock();
		const res = await runChunksAdaptive(
			[10, 11, 12, 13, 14],
			async (item) => {
				await Promise.resolve();
				return item * 2;
			},
			baseOpts(clock),
		);
		expect(res.results).toEqual([20, 22, 24, 26, 28]);
	});

	it("reports onFail (index + error) when a chunk exhausts its rate-limit retries", async () => {
		// A chunk that ALWAYS rate-limits and never recovers must, once its
		// rate-limit retries run out, both land in `failed` AND fire onFail with
		// the underlying error. This guards the fix: previously a rate-limit-
		// exhausted chunk was pushed to `failed` but onFail was skipped, so a
		// fully-throttled scan couldn't explain *why* it failed (the wholesale-
		// failure hint depends on seeing these errors).
		const clock = fakeClock();
		const err = new Error("429 forever");
		const onFailCalls: Array<{ index: number; error: unknown }> = [];
		const res = await runChunksAdaptive(
			[0],
			async () => {
				throw err;
			},
			{
				...baseOpts(clock),
				// Classify EVERY error as a transient rate-limit (never hard quota),
				// so the item is re-queued until its rate-limit retries are spent.
				classify: (): RateLimitVerdict => ({
					rateLimited: true,
					hardQuota: false,
				}),
				maxRateLimitRetriesPerItem: 2,
				onFail: (index, error) => onFailCalls.push({ index, error }),
			},
		);

		// The exhausted chunk produced no result and is reported in `failed`.
		expect(res.results).toEqual([null]);
		expect(res.failed).toEqual([0]);
		// onFail fired exactly once, with the index and the underlying error.
		expect(onFailCalls).toEqual([{ index: 0, error: err }]);
	});
});

describe("verdictFromLimitSignal", () => {
	it("maps rate-limit + overloaded to a retryable back-off", () => {
		expect(
			verdictFromLimitSignal({
				kind: "provider_rate_limit",
				retryAfterMs: 2000,
			}),
		).toEqual({ rateLimited: true, hardQuota: false, retryAfterMs: 2000 });
		expect(verdictFromLimitSignal({ kind: "provider_overloaded" })).toEqual(
			{
				rateLimited: true,
				hardQuota: false,
				retryAfterMs: undefined,
			},
		);
	});

	it("maps quota to a terminal hard failure", () => {
		expect(verdictFromLimitSignal({ kind: "provider_quota" })).toEqual({
			rateLimited: false,
			hardQuota: true,
		});
	});

	it("treats null / context-length / unknown as generic (neither)", () => {
		expect(verdictFromLimitSignal(null)).toEqual({
			rateLimited: false,
			hardQuota: false,
		});
		expect(verdictFromLimitSignal({ kind: "context_length" })).toEqual({
			rateLimited: false,
			hardQuota: false,
		});
	});
});
