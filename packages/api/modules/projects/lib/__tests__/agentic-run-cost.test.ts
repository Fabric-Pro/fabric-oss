/**
 * Tests for the agentic-run cost guard.
 *
 * The property that matters: the cap **refuses**, and it refuses in the
 * expensive-to-get-wrong direction. An estimate that runs UNDER the real cost
 * would wave through a run that should have been stopped, so the rounding and
 * the boundary are both pinned here rather than left to reading the arithmetic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ASSUMED_STEPS_PER_CASE,
	DEFAULT_RUN_COST_CAP_USD,
	describeCostRefusal,
	ESTIMATED_COST_PER_STEP_USD,
	estimateRunCost,
	resolveRunCostCapUsd,
} from "../agentic-run-cost";

const ENV = "FABRIC_QA_AGENTIC_RUN_COST_CAP_USD";
let saved: string | undefined;

beforeEach(() => {
	saved = process.env[ENV];
	delete process.env[ENV];
});

afterEach(() => {
	if (saved === undefined) {
		delete process.env[ENV];
	} else {
		process.env[ENV] = saved;
	}
});

describe("resolveRunCostCapUsd", () => {
	it("uses the default when unset", () => {
		expect(resolveRunCostCapUsd()).toBe(DEFAULT_RUN_COST_CAP_USD);
	});

	it("honours a valid override", () => {
		process.env[ENV] = "12.5";
		expect(resolveRunCostCapUsd()).toBe(12.5);
	});

	it.each(["not-a-number", "", "0", "-5", "NaN"])(
		"falls back to the default for a malformed override (%s)",
		(value) => {
			process.env[ENV] = value;
			// The failure mode this guards: NaN compares false against every
			// estimate, which would silently DISABLE the cap. A typo in an env var
			// must not turn the guard off.
			expect(resolveRunCostCapUsd()).toBe(DEFAULT_RUN_COST_CAP_USD);
		},
	);
});

describe("estimateRunCost", () => {
	it("charges per real step when the count is known", () => {
		const e = estimateRunCost({ caseCount: 2, stepCount: 10 });
		expect(e.stepCount).toBe(10);
		expect(e.estimatedCostUsd).toBeCloseTo(
			10 * ESTIMATED_COST_PER_STEP_USD,
			4,
		);
	});

	it("falls back to an assumed step count for a pre-dispatch quote", () => {
		const e = estimateRunCost({ caseCount: 3 });
		expect(e.stepCount).toBe(3 * ASSUMED_STEPS_PER_CASE);
	});

	it("allows a run that lands exactly on the cap", () => {
		process.env[ENV] = "1";
		// 20 steps × $0.05 = exactly $1.00. `<=`, not `<` — refusing at the
		// boundary would be an off-by-one a user could never explain.
		const e = estimateRunCost({ caseCount: 1, stepCount: 20 });
		expect(e.estimatedCostUsd).toBe(1);
		expect(e.withinCap).toBe(true);
	});

	it("refuses one step past the cap", () => {
		process.env[ENV] = "1";
		const e = estimateRunCost({ caseCount: 1, stepCount: 21 });
		expect(e.withinCap).toBe(false);
	});

	it("refuses a large suite at the default cap", () => {
		// The headline consequence of these constants: a 100-case suite at ~6
		// steps each is ~600 steps ≈ $30, well past the $5 default. If this ever
		// starts passing, the cap has been quietly defeated.
		const e = estimateRunCost({ caseCount: 100 });
		expect(e.withinCap).toBe(false);
		expect(e.estimatedCostUsd).toBeGreaterThan(DEFAULT_RUN_COST_CAP_USD);
	});

	it("treats a zero-step run as free rather than dividing by anything", () => {
		const e = estimateRunCost({ caseCount: 0, stepCount: 0 });
		expect(e.estimatedCostUsd).toBe(0);
		expect(e.withinCap).toBe(true);
	});
});

describe("describeCostRefusal", () => {
	it("names both numbers and what to do about it", () => {
		process.env[ENV] = "5";
		const message = describeCostRefusal(
			estimateRunCost({ caseCount: 40, stepCount: 400 }),
		);
		// A refusal that says only "too expensive" leaves someone re-pressing the
		// button, so the estimate, the cap and the remedy all have to be in it.
		expect(message).toContain("$20.00");
		expect(message).toContain("$5.00");
		expect(message).toContain("400 steps");
		expect(message).toMatch(/fewer cases/i);
	});

	it("says 'case' not 'cases' for a single case", () => {
		const message = describeCostRefusal(
			estimateRunCost({ caseCount: 1, stepCount: 500 }),
		);
		expect(message).toContain("1 case,");
	});
});
