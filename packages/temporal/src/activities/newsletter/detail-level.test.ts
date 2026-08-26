import { describe, expect, it } from "vitest";
import { getDetailLevelClause } from "./detail-level";

// The exact lines today's prompt uses — STANDARD MUST reproduce these verbatim.
const TODAY_STANDARD_LINES = [
	"Include ONLY major, user-facing feature additions and significant changes.",
	"EXCLUDE bug fixes, refactors, chores, CI, dependency bumps, tests, and internal/granular work.",
	"Write in a friendly, non-technical tone for customers and partners.",
];

describe("getDetailLevelClause", () => {
	it("STANDARD reproduces today's include/exclude/tone lines exactly", () => {
		expect(getDetailLevelClause("STANDARD")).toEqual(TODAY_STANDARD_LINES);
	});

	it("BRIEF differs from STANDARD and signals concision", () => {
		const brief = getDetailLevelClause("BRIEF");
		expect(brief).not.toEqual(TODAY_STANDARD_LINES);
		expect(brief.join("\n")).toMatch(
			/3 most significant|ONE short sentence/,
		);
	});

	it("DETAILED differs from STANDARD and signals comprehensiveness", () => {
		const detailed = getDetailLevelClause("DETAILED");
		expect(detailed).not.toEqual(TODAY_STANDARD_LINES);
		expect(detailed.join("\n")).toMatch(
			/2-4 sentences|significant changes/,
		);
	});

	it("BRIEF and DETAILED differ from each other", () => {
		expect(getDetailLevelClause("BRIEF")).not.toEqual(
			getDetailLevelClause("DETAILED"),
		);
	});
});
