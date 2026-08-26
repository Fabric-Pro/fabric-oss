import { describe, expect, it } from "vitest";
import type { TestResult } from "../constants";
import {
	type PlanResultRollup,
	planPassRateView,
	rollupFromCounts,
} from "../plan-pass-rate";

function counts(
	over: Partial<Record<TestResult, number>> = {},
): Record<TestResult, number> {
	return {
		NOT_RUN: 0,
		PASSED: 0,
		FAILED: 0,
		BLOCKED: 0,
		SKIPPED: 0,
		...over,
	};
}

describe("rollupFromCounts", () => {
	it("rates passing over EXECUTED, not over total", () => {
		// 2 passed, 1 failed, 7 never run: 2/3 executed — not 2/10.
		const rollup = rollupFromCounts(
			counts({ PASSED: 2, FAILED: 1, NOT_RUN: 7 }),
			10,
		);

		expect(rollup.executed).toBe(3);
		expect(rollup.passRate).toBeCloseTo(2 / 3);
	});

	it("reads 0%, never 100%, when nothing has been run", () => {
		const rollup = rollupFromCounts(counts({ NOT_RUN: 4 }), 4);

		expect(rollup.executed).toBe(0);
		expect(rollup.passRate).toBe(0);
	});

	it("collapses an empty tally to an all-zero rollup", () => {
		expect(rollupFromCounts(counts(), 0)).toEqual({
			total: 0,
			notRun: 0,
			passed: 0,
			failed: 0,
			blocked: 0,
			skipped: 0,
			executed: 0,
			passRate: 0,
		});
	});

	it("treats a payload with no SKIPPED key as zero, not NaN", () => {
		// The API deploys separately from this bundle, so a rollup produced before
		// SKIPPED existed arrives without the key. `total - undefined` is NaN,
		// which renders as a blank pass rate instead of failing loudly.
		const legacy = {
			NOT_RUN: 1,
			PASSED: 3,
			FAILED: 0,
			BLOCKED: 0,
		} as unknown as Record<TestResult, number>;

		const rollup = rollupFromCounts(legacy, 4);

		expect(rollup.skipped).toBe(0);
		expect(rollup.executed).toBe(3);
		expect(rollup.passRate).toBe(1);
	});

	it("keeps skipped cases out of the executed denominator", () => {
		// 3 passed, 1 skipped, 1 never run: 3/3 executed — a suite is not
		// penalised for tests it was deliberately told to skip.
		const rollup = rollupFromCounts(
			counts({ PASSED: 3, SKIPPED: 1, NOT_RUN: 1 }),
			5,
		);

		expect(rollup.skipped).toBe(1);
		expect(rollup.executed).toBe(3);
		expect(rollup.passRate).toBe(1);
	});

	it("counts blocked as executed but not passing", () => {
		const rollup = rollupFromCounts(counts({ PASSED: 1, BLOCKED: 1 }), 2);

		expect(rollup.executed).toBe(2);
		expect(rollup.passRate).toBe(0.5);
	});
});

describe("planPassRateView", () => {
	it("derives passing % (over executed) and tokenized segment widths", () => {
		const rollup: PlanResultRollup = {
			total: 10,
			notRun: 2,
			passed: 6,
			failed: 2,
			blocked: 0,
			executed: 8,
			passRate: 6 / 8, // 0.75
		};

		const view = planPassRateView(rollup);

		expect(view.passingPct).toBe(75);
		expect(view.executed).toBe(8);
		expect(view.total).toBe(10);
		// Ordered best → worst, each mapped to its design-system tone.
		expect(view.segments).toEqual([
			{ result: "PASSED", tone: "secondary", count: 6, pct: 60 },
			{ result: "FAILED", tone: "destructive", count: 2, pct: 20 },
			{ result: "BLOCKED", tone: "highlight", count: 0, pct: 0 },
			// SKIPPED sits between the problem states and NOT_RUN, and renders
			// muted rather than amber — the suite chose not to run it, so it is
			// not "needs attention" the way BLOCKED is.
			{ result: "SKIPPED", tone: "muted", count: 0, pct: 0 },
			{ result: "NOT_RUN", tone: "muted", count: 2, pct: 20 },
		]);
	});

	it("rounds the passing % (executed denominator, not total)", () => {
		// 2 passed / 3 executed = 66.67% → 67, even though only 2 of 4 total pass.
		const view = planPassRateView({
			total: 4,
			notRun: 1,
			passed: 2,
			failed: 1,
			blocked: 0,
			executed: 3,
			passRate: 2 / 3,
		});
		expect(view.passingPct).toBe(67);
	});

	it("reports zero executed for a plan whose cases have never run", () => {
		const view = planPassRateView({
			total: 5,
			notRun: 5,
			passed: 0,
			failed: 0,
			blocked: 0,
			executed: 0,
			passRate: 0,
		});
		expect(view.executed).toBe(0);
		expect(view.passingPct).toBe(0);
		// The whole bar is the neutral "not run" segment.
		expect(view.segments.find((s) => s.result === "NOT_RUN")?.pct).toBe(
			100,
		);
	});

	it("collapses a null rollup to an empty, non-crashing view", () => {
		const view = planPassRateView(null);
		expect(view).toEqual({
			passingPct: 0,
			total: 0,
			executed: 0,
			segments: [],
		});
	});
});
