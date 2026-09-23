/**
 * Unit tests for the shared cause/assertion lines both bug builders draw on.
 *
 * The point: a bug drafted from an Inconclusive or absent analysis must never
 * read as a firmer diagnosis than the analysis behind it.
 */

import { describe, expect, it } from "vitest";
import { buildAssertionLines, buildCauseLines } from "../bug-cause-lines";

describe("buildCauseLines", () => {
	it("states plainly that no analysis ran", () => {
		const lines = buildCauseLines({
			analysedAt: null,
			suspectedCause: null,
			suspectedKind: null,
			analysisModel: null,
		});

		expect(lines).toEqual([
			"Cause: not established — no AI analysis has run for this failure.",
		]);
	});

	it("labels an UNKNOWN-kind analysis as inconclusive, then quotes the hypothesis as unverified", () => {
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount calculation looks off by 10 units",
			suspectedKind: "UNKNOWN",
			analysisModel: "gpt-test",
		});

		expect(lines[0]).toContain("not established");
		expect(lines[0]).toContain("inconclusive");
		expect(lines[1]).toContain("Unverified AI hypothesis");
		expect(lines[1]).toContain("gpt-test");
		expect(lines[1]).toContain(
			"the discount calculation looks off by 10 units",
		);
	});

	it("never states a cause more strongly than Inconclusive allows", () => {
		// The exact defect the card reports: an Inconclusive verdict rendered
		// as "the discount calculation is off by 10 units" — a firm cause.
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount calculation is off by 10 units",
			suspectedKind: "UNKNOWN",
			analysisModel: null,
		});

		expect(lines.join("\n")).not.toMatch(/^the discount calculation/);
		expect(lines[0]).toContain("not established");
	});

	it("labels a confident kind as an AI hypothesis, not a verified diagnosis", () => {
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "the discount logic dropped the percentage sign",
			suspectedKind: "PRODUCT_BUG",
			analysisModel: "gpt-test",
		});

		expect(lines[0]).toContain("AI hypothesis");
		expect(lines[0]).toContain("not a verified diagnosis");
		expect(lines[0]).toContain("Product bug");
		expect(lines[1]).toBe("the discount logic dropped the percentage sign");
	});

	it("treats a verdict this code cannot name as inconclusive, not a confident finding", () => {
		// A future TestFailureKind value this map hasn't caught up with yet must
		// not be shown as a named, confident diagnosis just because it is SET.
		const lines = buildCauseLines({
			analysedAt: new Date("2026-09-01T00:00:00Z"),
			suspectedCause: "cause",
			suspectedKind: "SOMETHING_NEW",
			analysisModel: null,
		});

		expect(lines[0]).toContain("not established");
		expect(lines[0]).toContain("inconclusive");
		expect(lines[1]).toContain("Unverified AI hypothesis");
		expect(lines.join("\n")).not.toContain(
			"AI hypothesis — not a verified diagnosis",
		);
	});
});

describe("buildAssertionLines", () => {
	it("adds Expected/Actual lines when the message parses", () => {
		expect(
			buildAssertionLines(
				"Expected values to be strictly equal:\n\n90 !== 80\n",
			),
		).toEqual(["Expected: 80", "Actual: 90"]);
	});

	it("adds nothing when the message does not parse", () => {
		expect(buildAssertionLines("exit code 1")).toEqual([]);
		expect(buildAssertionLines(null)).toEqual([]);
	});
});
