/**
 * The confidence gate — `project_qa_settings.confidenceThreshold` finally doing
 * something.
 *
 * Most of these assert that the gate does NOT fire. That is deliberate: the
 * threshold defaults to 80 on every project that has ever existed, so the day
 * this ships it goes live everywhere at once. The expensive failure is not "a
 * doubtful verdict slipped through" — it is a wall of NEEDS_REVIEW across every
 * suite because a provider dropped an optional field or used the other
 * percentage convention.
 */

import { describe, expect, it } from "vitest";
import { normaliseConfidence, stepStatusFor } from "../run-case";

describe("normaliseConfidence", () => {
	it("passes a 0–100 value through", () => {
		expect(normaliseConfidence(85)).toBe(85);
		expect(normaliseConfidence(0)).toBe(0);
		expect(normaliseConfidence(100)).toBe(100);
	});

	it("scales the 0–1 convention up rather than reading it literally", () => {
		// The failure this prevents: 0.9 means "very sure", and read literally
		// against a threshold of 80 it sends a confident step to review.
		expect(normaliseConfidence(0.9)).toBe(90);
		expect(normaliseConfidence(0.05)).toBeCloseTo(5);
	});

	it("reads an exact 1 as certain, not as one percent", () => {
		// Genuinely ambiguous. Resolved toward recording the verdict — i.e. toward
		// the behaviour before this gate existed — so the ambiguous case cannot
		// quietly flag a whole suite.
		expect(normaliseConfidence(1)).toBe(100);
	});

	it("clamps above 100", () => {
		expect(normaliseConfidence(140)).toBe(100);
	});

	it("returns null for anything unusable, so it reads as 'not reported'", () => {
		expect(normaliseConfidence(undefined)).toBeNull();
		expect(normaliseConfidence(Number.NaN)).toBeNull();
		expect(normaliseConfidence(Number.POSITIVE_INFINITY)).toBeNull();
		expect(normaliseConfidence(-5)).toBeNull();
	});
});

describe("stepStatusFor", () => {
	const base = { performed: true, met: true, confidence: 95, threshold: 80 };

	it("records the verdict when the model clears the bar", () => {
		expect(stepStatusFor(base)).toBe("PASSED");
		expect(stepStatusFor({ ...base, met: false })).toBe("FAILED");
	});

	it("withholds the verdict when the model is below the bar", () => {
		expect(stepStatusFor({ ...base, confidence: 40 })).toBe("NEEDS_REVIEW");
		// Both directions: an uncertain FAILED is exactly as misleading as an
		// uncertain PASSED, and arguably worse — somebody opens a bug for it.
		expect(stepStatusFor({ ...base, met: false, confidence: 40 })).toBe(
			"NEEDS_REVIEW",
		);
	});

	it("treats the threshold as a floor, not a strict inequality", () => {
		expect(stepStatusFor({ ...base, confidence: 80 })).toBe("PASSED");
		expect(stepStatusFor({ ...base, confidence: 79 })).toBe("NEEDS_REVIEW");
	});

	it("keeps the verdict when the model reported no confidence at all", () => {
		// The safety valve. A provider that ignores the new field must degrade to
		// the old behaviour, not send every step of every project to review.
		expect(stepStatusFor({ ...base, confidence: null })).toBe("PASSED");
		expect(stepStatusFor({ ...base, met: false, confidence: null })).toBe(
			"FAILED",
		);
	});

	it("is inert at threshold 0, whatever the model says", () => {
		expect(stepStatusFor({ ...base, confidence: 0, threshold: 0 })).toBe(
			"PASSED",
		);
		expect(
			stepStatusFor({ ...base, met: false, confidence: 0, threshold: 0 }),
		).toBe("FAILED");
	});

	it("reports an unperformed operation as BLOCKED regardless of confidence", () => {
		// There is no judgement to be unsure about when nothing was done, so the
		// mechanical outcome outranks the gate.
		expect(
			stepStatusFor({ ...base, performed: false, confidence: 10 }),
		).toBe("BLOCKED");
		expect(
			stepStatusFor({ ...base, performed: false, confidence: null }),
		).toBe("BLOCKED");
	});

	it("sends a step the model could not assess to review once a bar is set", () => {
		// The runner records confidence 0 when the assess call itself failed. That
		// used to be reported as FAILED — a verdict the model never gave.
		expect(stepStatusFor({ ...base, met: false, confidence: 0 })).toBe(
			"NEEDS_REVIEW",
		);
	});
});
