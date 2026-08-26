import { describe, expect, it } from "vitest";
import {
	resolveSeverityUpgrade,
	shouldAutoDismiss,
} from "../review-activities";
import type { ReviewProposal } from "../review-schemas";

/**
 * Auto-triage SAFETY: the auto-review applies verdicts, but it must NEVER
 * silently hide an important finding or downgrade a real one. These cover the
 * two pure decision helpers the apply step uses.
 */

function fp(confidence: ReviewProposal["confidence"]): ReviewProposal {
	return {
		findingId: "f1",
		verdict: "false_positive",
		confidence,
		reasoning: "",
	};
}

describe("shouldAutoDismiss — never auto-hide a CRITICAL/HIGH finding", () => {
	it("refuses to auto-dismiss a CRITICAL finding, even on a high-confidence FP verdict", () => {
		expect(shouldAutoDismiss(fp("high"), "CRITICAL")).toBe(false);
		expect(shouldAutoDismiss(fp("medium"), "CRITICAL")).toBe(false);
	});

	it("refuses to auto-dismiss a HIGH finding, even on a high-confidence FP verdict", () => {
		expect(shouldAutoDismiss(fp("high"), "HIGH")).toBe(false);
		expect(shouldAutoDismiss(fp("medium"), "HIGH")).toBe(false);
	});

	it("auto-dismisses MEDIUM/LOW noise on a high- or medium-confidence FP verdict", () => {
		expect(shouldAutoDismiss(fp("high"), "MEDIUM")).toBe(true);
		expect(shouldAutoDismiss(fp("medium"), "MEDIUM")).toBe(true);
		expect(shouldAutoDismiss(fp("high"), "LOW")).toBe(true);
		expect(shouldAutoDismiss(fp("medium"), "LOW")).toBe(true);
	});

	it("keeps a low-confidence FP OPEN for a human (even at MEDIUM/LOW)", () => {
		expect(shouldAutoDismiss(fp("low"), "MEDIUM")).toBe(false);
		expect(shouldAutoDismiss(fp("low"), "LOW")).toBe(false);
	});

	it("treats an unknown/absent severity conservatively (never auto-dismiss)", () => {
		expect(shouldAutoDismiss(fp("high"), undefined)).toBe(false);
		expect(shouldAutoDismiss(fp("high"), "WHATEVER")).toBe(false);
	});
});

describe("resolveSeverityUpgrade — only increases, never a silent downgrade", () => {
	it("applies an increase", () => {
		expect(resolveSeverityUpgrade("HIGH", "CRITICAL")).toBe("CRITICAL");
		expect(resolveSeverityUpgrade("LOW", "MEDIUM")).toBe("MEDIUM");
		expect(resolveSeverityUpgrade("MEDIUM", "HIGH")).toBe("HIGH");
	});

	it("never applies a downgrade", () => {
		expect(resolveSeverityUpgrade("CRITICAL", "LOW")).toBeUndefined();
		expect(resolveSeverityUpgrade("HIGH", "MEDIUM")).toBeUndefined();
		expect(resolveSeverityUpgrade("HIGH", "LOW")).toBeUndefined();
	});

	it("no change when equal, or when either side is missing", () => {
		expect(resolveSeverityUpgrade("HIGH", "HIGH")).toBeUndefined();
		expect(resolveSeverityUpgrade(undefined, "CRITICAL")).toBeUndefined();
		expect(resolveSeverityUpgrade("HIGH", undefined)).toBeUndefined();
	});
});
