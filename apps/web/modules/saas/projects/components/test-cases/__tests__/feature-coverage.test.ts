import { describe, expect, it } from "vitest";
import type { TestResult } from "../constants";
import { featurePassRateView } from "../feature-coverage";

// Keyed off the shared TestResult union rather than re-listing its members —
// spelling them out is how this helper silently missed SKIPPED when the result
// vocabulary grew.
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

describe("featurePassRateView", () => {
	it("reuses the plan-card presentation: rounded percent + tokenized segments", () => {
		const view = featurePassRateView({
			caseCount: 4,
			resultCounts: counts({ PASSED: 3, FAILED: 1 }),
		});

		expect(view.passingPct).toBe(75);
		expect(view.total).toBe(4);
		expect(view.executed).toBe(4);
		// Best→worst, and every segment carries a design-system tone, never a colour.
		expect(view.segments.map((s) => s.result)).toEqual([
			"PASSED",
			"FAILED",
			"BLOCKED",
			"SKIPPED",
			"NOT_RUN",
		]);
		expect(view.segments[0]).toMatchObject({ tone: "secondary", pct: 75 });
		expect(view.segments[1]).toMatchObject({
			tone: "destructive",
			pct: 25,
		});
	});

	it("widths are a share of TOTAL, so unrun cases still occupy the bar", () => {
		const view = featurePassRateView({
			caseCount: 4,
			resultCounts: counts({ PASSED: 1, NOT_RUN: 3 }),
		});

		// 100% passing of what ran, but the bar shows the 3 unrun cases.
		expect(view.passingPct).toBe(100);
		expect(view.segments.find((s) => s.result === "NOT_RUN")?.pct).toBe(75);
	});
});
