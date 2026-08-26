/**
 * `parseQaAnalysis` — the read side of the QA tab's stored analysis.
 *
 * Deliberately NOT in `feature-maturation.test.ts`: that suite is
 * `describe.skipIf(!hasReachableDatabaseUrl())`, so a pure-function test placed
 * there reports green in any job without a database — which is the same as not
 * having the test. Nothing here touches the database.
 *
 * The behaviour that matters: the "Drafting revealed" attribution is parsed out
 * of the model's prefix on READ. That is what turns the test-first ordering's
 * central claim — writing the cases first exposes specification gaps — from a
 * prompt instruction nobody could see into a flag the tab can render, and doing
 * it on read means analyses stored before the change gain it too.
 */

import { describe, expect, it } from "vitest";
import { parseQaAnalysis } from "../prisma/queries/feature-maturation";

const base = {
	integrationNotes: "- touches checkout",
	e2eScenarios: "### Happy path",
	depth: "STANDARD",
	specHash: "abc",
	generatedAt: "2026-08-12T00:00:00.000Z",
};

describe("parseQaAnalysis — drafting attribution", () => {
	it("flags a warning the drafted cases exposed, and strips the prefix", () => {
		const parsed = parseQaAnalysis({
			...base,
			warnings: [
				{
					criterionRef: "AC 3",
					warning: "Drafting revealed: expiry has no timezone.",
				},
			],
		});

		expect(parsed?.warnings[0]).toEqual({
			criterionRef: "AC 3",
			// The prefix carried the meaning; now the flag does, so the
			// displayed text should not repeat it.
			warning: "expiry has no timezone.",
			fromDraftedCases: true,
		});
	});

	it("matches the prefix regardless of case and spacing", () => {
		// The model writes this, so an exact-string match would silently stop
		// working on any wording drift the prompt tolerates.
		for (const raw of [
			"drafting revealed: x",
			"DRAFTING REVEALED:  x",
			"  Drafting Revealed:x",
		]) {
			const parsed = parseQaAnalysis({
				...base,
				warnings: [{ criterionRef: "AC 1", warning: raw }],
			});
			expect(parsed?.warnings[0].fromDraftedCases).toBe(true);
			expect(parsed?.warnings[0].warning).toBe("x");
		}
	});

	it("leaves an ordinary warning unflagged and unmodified", () => {
		const parsed = parseQaAnalysis({
			...base,
			warnings: [
				{ criterionRef: "AC 5", warning: "No threshold given." },
			],
		});

		expect(parsed?.warnings[0].warning).toBe("No threshold given.");
		expect(parsed?.warnings[0].fromDraftedCases).toBeUndefined();
	});

	it("does not flag a warning that merely mentions drafting", () => {
		// The attribution is a marker, not a keyword. A warning discussing the
		// drafting process is not a warning the drafting exposed.
		const parsed = parseQaAnalysis({
			...base,
			warnings: [
				{
					criterionRef: "AC 2",
					warning: "Drafting is blocked until criteria exist.",
				},
			],
		});

		expect(parsed?.warnings[0].fromDraftedCases).toBeUndefined();
	});

	it("strips the marker when the model drops it mid-warning", () => {
		// Observed on a real analysis: the model folded two observations into
		// one warning and put the marker at the second sentence. A
		// leading-only match left the raw marker rendering in the prose —
		// exactly what the chip exists to replace.
		const parsed = parseQaAnalysis({
			...base,
			warnings: [
				{
					criterionRef: "AC 6",
					warning:
						"Open Questions leaves the scope undecided. Drafting revealed: TC-047 and TC-060 both assume one specific behaviour.",
				},
			],
		});

		expect(parsed?.warnings[0]).toEqual({
			criterionRef: "AC 6",
			// One space between the two sentences — not the two that naive
			// removal of the marker alone would leave behind.
			warning:
				"Open Questions leaves the scope undecided. TC-047 and TC-060 both assume one specific behaviour.",
			fromDraftedCases: true,
		});
	});

	it("drops a warning that was nothing but the marker", () => {
		// Otherwise it renders as a chip labelling an empty warning.
		const parsed = parseQaAnalysis({
			...base,
			warnings: [
				{ criterionRef: "AC 4", warning: "Drafting revealed:" },
				{ criterionRef: "AC 5", warning: "No threshold given." },
			],
		});

		expect(parsed?.warnings).toHaveLength(1);
		expect(parsed?.warnings[0].warning).toBe("No threshold given.");
	});
});

describe("parseQaAnalysis — reviewed-against count", () => {
	it("carries the count through when one was recorded", () => {
		const parsed = parseQaAnalysis({
			...base,
			warnings: [],
			reviewedAgainstCaseCount: 8,
		});
		expect(parsed?.reviewedAgainstCaseCount).toBe(8);
	});

	it("omits it entirely when absent, rather than defaulting to 0", () => {
		// An analysis stored before this was recorded, and every standard-flow
		// analysis, has no count. Defaulting to 0 would render as "reviewed
		// against 0 test cases", which reads as a failure rather than as the
		// ordering working as designed.
		const parsed = parseQaAnalysis({ ...base, warnings: [] });
		expect(parsed).not.toHaveProperty("reviewedAgainstCaseCount");
	});

	it("ignores a non-numeric count from a malformed row", () => {
		const parsed = parseQaAnalysis({
			...base,
			warnings: [],
			reviewedAgainstCaseCount: "eight",
		});
		expect(parsed).not.toHaveProperty("reviewedAgainstCaseCount");
	});
});
