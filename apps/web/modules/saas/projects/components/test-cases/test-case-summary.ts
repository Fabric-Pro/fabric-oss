import type { AutomationStatus, TestCaseState, TestResult } from "./constants";

/**
 * The server-computed, filter-aware tallies the Testing header renders — the
 * `summary` returned by `testCases.list` (state-independent, correct across
 * pagination rather than over the loaded page).
 */
export type TestCaseSummary = {
	/** Grand total under the active filters (all states). */
	total: number;
	stateCounts: Record<TestCaseState, number>;
	/** Tally of the automation INTENT enum — not what the automation % counts. */
	automationCounts: Record<AutomationStatus, number>;
	/** Cases that are AUTOMATED *and* carry a ref — the automation-% numerator. */
	automatedWithRefCount: number;
	/** Cases whose latest result came from a real CI run — the CI-coverage numerator. */
	pipelineCoveredCount: number;
	resultCounts: Record<TestResult, number>;
};

function pct(part: number, whole: number): number {
	return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

export type TestingHealth = {
	total: number;
	/** Cases with a recorded verdict — passed + failed + blocked. */
	executed: number;
	passed: number;
	failed: number;
	blocked: number;
	/** Passing over EXECUTED cases, so a pile of never-run cases can't dilute it. */
	passRate: number;
	/** Bar segment widths, as whole percentages of `executed`. */
	passShare: number;
	failShare: number;
	blockedShare: number;
	automated: number;
	automatedPct: number;
	ciCovered: number;
	ciCoveredPct: number;
	/** True once a target exists and automation sits under it. */
	belowTarget: boolean;
};

/**
 * Collapse the server summary into everything the health line shows.
 *
 * Pure, and the single place these ratios are computed: the header, the
 * "needs attention" chips and the coverage rings all read the same numbers, so
 * they cannot tell the reader different stories about one project.
 *
 * Pass rate is over EXECUTED cases (passed + failed + blocked). Over `total` it
 * would report a suite of 200 cases with 10 run and all 10 passing as "5%
 * passing", which reads as a catastrophe rather than as "barely started".
 */
export function computeTestingHealth(
	summary: TestCaseSummary,
	coverageTarget?: number,
): TestingHealth {
	const total = summary.total;
	const passed = summary.resultCounts.PASSED;
	const failed = summary.resultCounts.FAILED;
	const blocked = summary.resultCounts.BLOCKED;
	const executed = passed + failed + blocked;
	const automated = summary.automatedWithRefCount;
	const automatedPct = pct(automated, total);

	return {
		total,
		executed,
		passed,
		failed,
		blocked,
		passRate: pct(passed, executed),
		passShare: pct(passed, executed),
		failShare: pct(failed, executed),
		blockedShare: pct(blocked, executed),
		automated,
		automatedPct,
		ciCovered: summary.pipelineCoveredCount,
		ciCoveredPct: pct(summary.pipelineCoveredCount, total),
		belowTarget:
			coverageTarget !== undefined && automatedPct < coverageTarget,
	};
}

/**
 * The four "needs attention" buckets, each a filter the chip applies when
 * pressed. Only non-zero buckets are offered — a chip reading "Failing 0" is an
 * invitation to a view that is guaranteed empty.
 */
export type AttentionBucket = {
	id: "failing" | "blocked" | "proposed" | "notRun";
	count: number;
};

export function attentionBuckets(summary: TestCaseSummary): AttentionBucket[] {
	return (
		[
			{ id: "failing", count: summary.resultCounts.FAILED },
			{ id: "blocked", count: summary.resultCounts.BLOCKED },
			{ id: "proposed", count: summary.stateCounts.PROPOSED },
			{ id: "notRun", count: summary.resultCounts.NOT_RUN },
		] as const
	)
		.filter((b) => b.count > 0)
		.map((b) => ({ ...b }));
}
