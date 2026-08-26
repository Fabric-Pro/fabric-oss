/**
 * Pure presentation helper for a plan card's pass-rate bar. Turns the backend
 * `resultRollup` (counts + a [0,1] pass fraction over EXECUTED cases) into the
 * segmented-bar model the card renders: one tokenized segment per run result
 * with its width as a whole-percent of the total, plus the rounded passing %.
 *
 * No React here so it can be unit-tested without a render (mirrors the split
 * used elsewhere in this module — components import primitives, primitives stay
 * pure). Colour never appears here: segments carry a design-system `Tone`, and
 * the component maps that to `TONE_CLASSES[...].solid`.
 */

import { RESULT_TONE, type TestResult, type Tone } from "./constants";

/**
 * The rollup shape returned per plan by `plans.list` when `includePassRate` is
 * set. Declared structurally so the helper doesn't depend on the API/DB package.
 */
export interface PlanResultRollup {
	total: number;
	notRun: number;
	passed: number;
	failed: number;
	blocked: number;
	/**
	 * Deliberately skipped by the suite. Optional because the API only began
	 * returning it with the SKIPPED result — an older cached payload omits it,
	 * and treating that as 0 is right: before SKIPPED existed there were none.
	 */
	skipped?: number;
	/** total − notRun − skipped (cases that actually ran). */
	executed: number;
	/** passed / executed, in [0, 1]; 0 when nothing has been executed. */
	passRate: number;
}

interface PassRateSegment {
	result: TestResult;
	tone: Tone;
	count: number;
	/** Width as a whole percent of the total; 0 when the plan has no cases. */
	pct: number;
}

export interface PlanPassRateView {
	/** Rounded passing percent over executed cases (`passRate * 100`). */
	passingPct: number;
	/** Total live cases in the plan. */
	total: number;
	/** Cases that actually ran (passed + failed + blocked). */
	executed: number;
	/** Segments ordered best→worst for a left-to-right "health" read. */
	segments: PassRateSegment[];
}

/** Bar order: passing first, then the problem states, then the didn't-run ones. */
const SEGMENT_ORDER: readonly TestResult[] = [
	"PASSED",
	"FAILED",
	"BLOCKED",
	"SKIPPED",
	"NOT_RUN",
];

/**
 * Build a rollup from a per-result tally and the total it was counted over —
 * for callers that hold raw counts rather than a server-computed `resultRollup`
 * (a feature's coverage row, a run in progress).
 *
 * The rate lives HERE, once, next to the view that renders it: `executed`
 * excludes NOT_RUN **and SKIPPED**, and passing is over EXECUTED, so cases that
 * have never run read 0% rather than a flattering 100% — while cases the suite
 * deliberately skipped don't drag the rate down for not running. A caller
 * re-deriving that inline is how two surfaces end up disagreeing about what
 * "passing" means.
 */
export function rollupFromCounts(
	counts: Record<TestResult, number>,
	total: number,
): PlanResultRollup {
	// `?? 0` is not defensive noise: these counts arrive from the API, which
	// deploys separately from this bundle. A payload produced before SKIPPED
	// existed has no such key, and `total - undefined` is NaN — which renders as
	// a blank pass rate rather than failing loudly. Absent means none.
	const skipped = counts.SKIPPED ?? 0;
	// `total` is supplied by the caller rather than re-derived from `counts`, and
	// every caller today upholds "total equals the sum of counts" only by
	// construction. Clamped so a caller that ever breaks that contract renders a
	// harmless 0 instead of a negative executed count — passRate is already
	// guarded, but the executed NUMBER is displayed on its own.
	const executed = Math.max(0, total - counts.NOT_RUN - skipped);
	return {
		total,
		notRun: counts.NOT_RUN,
		passed: counts.PASSED,
		failed: counts.FAILED,
		blocked: counts.BLOCKED,
		skipped,
		executed,
		passRate: executed > 0 ? counts.PASSED / executed : 0,
	};
}

/**
 * Build the card's pass-rate view from a plan's `resultRollup`. A null/absent
 * rollup (e.g. the caller didn't request pass rates) collapses to an all-zero
 * view — an empty bar reading "not run", never a crash.
 */
export function planPassRateView(
	rollup: PlanResultRollup | null | undefined,
): PlanPassRateView {
	if (!rollup) {
		return { passingPct: 0, total: 0, executed: 0, segments: [] };
	}

	const counts: Record<TestResult, number> = {
		PASSED: rollup.passed,
		FAILED: rollup.failed,
		BLOCKED: rollup.blocked,
		SKIPPED: rollup.skipped ?? 0,
		NOT_RUN: rollup.notRun,
	};
	const total = rollup.total;

	const segments = SEGMENT_ORDER.map((result) => ({
		result,
		tone: RESULT_TONE[result],
		count: counts[result],
		pct: total > 0 ? Math.round((counts[result] / total) * 100) : 0,
	}));

	return {
		passingPct: Math.round(rollup.passRate * 100),
		total,
		executed: rollup.executed,
		segments,
	};
}
