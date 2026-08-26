/**
 * Pure presentation helpers for the Features / coverage segment.
 *
 * A feature row and a plan card can never disagree about what "passing" means:
 * this module only feeds the coverage row's raw `resultCounts` through the same
 * `rollupFromCounts` + `planPassRateView` pair the plan cards use. The rate
 * itself is defined in exactly one place — see `plan-pass-rate.ts` (and
 * `computePlanPassRate` server-side, which this mirrors field-for-field).
 *
 * No React here, so the derivation is unit-testable without a render (mirrors
 * the split `plan-pass-rate.ts` / `feature-options.ts` already use).
 */

import type { TestResult, Tone } from "./constants";
import {
	type PlanPassRateView,
	planPassRateView,
	rollupFromCounts,
} from "./plan-pass-rate";

/**
 * A feature is COVERED once at least one live case tests it, UNCOVERED
 * otherwise. There is no PARTIAL: the API cannot honestly compute one, because
 * a story's acceptance criteria are unvalidated free text with no parser, so
 * any "X of N criteria" would be a guess wearing the costume of a metric. The
 * countable, honest number is `distinctAcRefs` — how many distinct criteria
 * testers actually referenced — and that is what the row renders.
 */
export type FeatureCoverageState = "COVERED" | "UNCOVERED";

/**
 * The slice of a `listFeatureCoverage` row these helpers read. Declared
 * structurally so the pure module doesn't depend on the API/DB package (same
 * convention as `PlanResultRollup`); the API returns a superset.
 */
export interface FeatureCoverageRollupSource {
	/** Live cases linked to this story. Equals the sum of `resultCounts`. */
	caseCount: number;
	resultCounts: Record<TestResult, number>;
}

/** Coverage state → the tone its chip renders in. Covered reads as success. */
export const COVERAGE_STATE_TONE: Record<FeatureCoverageState, Tone> = {
	COVERED: "secondary",
	UNCOVERED: "muted",
};

export const COVERAGE_STATE_I18N_KEY: Record<FeatureCoverageState, string> = {
	COVERED: "features.covered",
	UNCOVERED: "features.uncovered",
};

/** The row's pass-rate view, built through the shared plan-card presentation. */
export function featurePassRateView(
	row: FeatureCoverageRollupSource,
): PlanPassRateView {
	return planPassRateView(rollupFromCounts(row.resultCounts, row.caseCount));
}
