/**
 * Tests for the `computeReconnectDelayMs` helper exported by
 * `useConversationRealtime`.
 *
 * The helper is the only piece of `useConversationRealtime` that's
 * unit-testable without a full EventSource integration harness. We
 * pin two contracts:
 *
 *   1. The delay grows non-linearly (exponential base × 2^(n-1)).
 *      Specifically: delay(2) > 2 × delay(1) − jitter_max, i.e. the
 *      exponential growth dominates the jitter at every step beyond
 *      the first.
 *   2. Jitter is bounded: delay(n) - exponential(n) is always in
 *      [0, 1000)ms (no negative delays, no runaway).
 *
 * These pins catch regressions where someone "simplifies" the formula
 * back to `BASE * n` (the prior linear implementation that the
 * docstring lied about).
 */

import { describe, expect, it } from "vitest";
import { computeReconnectDelayMs } from "../useConversationRealtime";

const BASE_MS = 3000;
const JITTER_MAX_MS = 1000;

describe("computeReconnectDelayMs", () => {
	it("attempt 1: returns BASE..BASE+JITTER (no exponential growth on the first try)", () => {
		for (let i = 0; i < 100; i += 1) {
			const d = computeReconnectDelayMs(1);
			expect(d).toBeGreaterThanOrEqual(BASE_MS);
			expect(d).toBeLessThan(BASE_MS + JITTER_MAX_MS);
		}
	});

	it("attempt 2: returns 2*BASE..2*BASE+JITTER (doubled)", () => {
		for (let i = 0; i < 100; i += 1) {
			const d = computeReconnectDelayMs(2);
			expect(d).toBeGreaterThanOrEqual(2 * BASE_MS);
			expect(d).toBeLessThan(2 * BASE_MS + JITTER_MAX_MS);
		}
	});

	it("attempt 5: returns 16*BASE..16*BASE+JITTER (exponential ceiling before disable)", () => {
		for (let i = 0; i < 100; i += 1) {
			const d = computeReconnectDelayMs(5);
			expect(d).toBeGreaterThanOrEqual(16 * BASE_MS);
			expect(d).toBeLessThan(16 * BASE_MS + JITTER_MAX_MS);
		}
	});

	it("growth is non-linear: average delay at attempt n+1 > 2x average at attempt n", () => {
		// Sample averages — large enough that jitter washes out
		function avg(attempt: number): number {
			let total = 0;
			const samples = 200;
			for (let i = 0; i < samples; i += 1) {
				total += computeReconnectDelayMs(attempt);
			}
			return total / samples;
		}
		const a1 = avg(1);
		const a2 = avg(2);
		const a3 = avg(3);

		// Exponential growth — each step nearly doubles the previous.
		// The exact ratio is 2.0; we allow a generous tolerance to
		// absorb jitter and Monte Carlo variance.
		expect(a2 / a1).toBeGreaterThan(1.8);
		expect(a3 / a2).toBeGreaterThan(1.8);

		// And critically: NOT linear (linear would have a2/a1 == 2 but
		// a3/a2 == 1.5, i.e. declining ratio). Confirm a3/a2 stays
		// above 1.8 — the linear formula would fail this assertion.
		expect(a3 / a2).toBeGreaterThan(1.8);
	});
});
