import { describe, expect, it } from "vitest";
import {
	DEFAULT_SEVERITY_RUBRIC,
	parseScanCustomRules,
	parseSecurityKnowledgePacks,
	parseSeverityRubric,
	scanEngineWhere,
} from "../prisma/queries/projects/scan";

describe("parseSeverityRubric — tolerant, seeded defaults", () => {
	it("returns the seeded CVSS-aligned defaults for null / non-array input", () => {
		expect(parseSeverityRubric(null)).toEqual(DEFAULT_SEVERITY_RUBRIC);
		expect(parseSeverityRubric("nope")).toEqual(DEFAULT_SEVERITY_RUBRIC);
		expect(parseSeverityRubric({})).toEqual(DEFAULT_SEVERITY_RUBRIC);
		// Defaults cover all four bands.
		expect(DEFAULT_SEVERITY_RUBRIC.map((r) => r.severity)).toEqual([
			"CRITICAL",
			"HIGH",
			"MEDIUM",
			"LOW",
		]);
	});

	it("keeps well-formed bands and drops malformed entries", () => {
		const rubric = parseSeverityRubric([
			{ severity: "CRITICAL", definition: "unauth RCE" },
			// bad severity — dropped
			{ severity: "NOPE", definition: "x" },
			// empty definition — dropped
			{ severity: "HIGH", definition: "   " },
			{ severity: "LOW", definition: "hardening" },
			"garbage",
			null,
		]);
		expect(rubric).toHaveLength(2);
		expect(rubric[0]).toEqual({
			severity: "CRITICAL",
			definition: "unauth RCE",
		});
		expect(rubric[1].severity).toBe("LOW");
	});

	it("de-dupes repeated severities (first wins) and falls back to defaults if all bad", () => {
		const rubric = parseSeverityRubric([
			{ severity: "HIGH", definition: "first" },
			{ severity: "HIGH", definition: "second" },
		]);
		expect(rubric).toHaveLength(1);
		expect(rubric[0].definition).toBe("first");

		// All-malformed → seeded defaults (never an empty rubric).
		expect(
			parseSeverityRubric([{ severity: "BAD", definition: "x" }]),
		).toEqual(DEFAULT_SEVERITY_RUBRIC);
	});
});

describe("parseSecurityKnowledgePacks — tolerant, capped", () => {
	it("returns an empty array for null / non-array input", () => {
		expect(parseSecurityKnowledgePacks(null)).toEqual([]);
		expect(parseSecurityKnowledgePacks("nope")).toEqual([]);
	});

	it("keeps well-formed packs and drops malformed ones", () => {
		const packs = parseSecurityKnowledgePacks([
			{ id: "p1", title: "Pack 1", content: "body one" },
			// missing content — dropped
			{ id: "p2", title: "Pack 2" },
			// empty content — dropped
			{ id: "p3", title: "Pack 3", content: "   " },
			// valid + appliesTo scope
			{
				id: "p4",
				title: "Pack 4",
				content: "body four",
				appliesTo: "ACCESSIBILITY",
			},
			"garbage",
		]);
		expect(packs).toHaveLength(2);
		expect(packs[0].id).toBe("p1");
		expect(packs[0].appliesTo).toBeUndefined();
		expect(packs[1].appliesTo).toBe("ACCESSIBILITY");
	});

	it("caps an oversized pack body so it can't blow the prompt budget", () => {
		const big = "a".repeat(20_000);
		const [pack] = parseSecurityKnowledgePacks([
			{ id: "p", title: "Big", content: big },
		]);
		expect(pack.content.length).toBeLessThan(big.length);
		expect(pack.content).toContain("[truncated]");
	});

	it("ignores an unrecognized appliesTo value", () => {
		const [pack] = parseSecurityKnowledgePacks([
			{ id: "p", title: "T", content: "c", appliesTo: "WHATEVER" },
		]);
		expect(pack.appliesTo).toBeUndefined();
	});
});

describe("scanEngineWhere — engine filter → ScanFinding where-clause", () => {
	it("maps SEMGREP to SECURITY + the Semgrep ruleSource prefix", () => {
		expect(scanEngineWhere("SEMGREP")).toEqual({
			category: "SECURITY",
			ruleSource: { startsWith: "Semgrep:" },
		});
	});

	it("maps GIT_HISTORY to SECURITY + the secret-history ruleSource prefix", () => {
		expect(scanEngineWhere("GIT_HISTORY")).toEqual({
			category: "SECURITY",
			ruleSource: { startsWith: "Secret history:" },
		});
	});

	it("maps AI_SECURITY to SECURITY findings that are NOT a repo-engine prefix", () => {
		const where = scanEngineWhere("AI_SECURITY");
		expect(where.category).toBe("SECURITY");
		expect(where.NOT).toEqual({
			OR: [
				{ ruleSource: { startsWith: "Semgrep:" } },
				{ ruleSource: { startsWith: "Secret history:" } },
			],
		});
	});

	it("maps AI_ACCESSIBILITY to the ACCESSIBILITY category", () => {
		expect(scanEngineWhere("AI_ACCESSIBILITY")).toEqual({
			category: "ACCESSIBILITY",
		});
	});
});

// Sanity: the existing custom-rules parser is untouched by the new exports.
describe("parseScanCustomRules still works alongside the new parsers", () => {
	it("parses a valid rule", () => {
		expect(
			parseScanCustomRules([
				{
					id: "1",
					name: "R",
					category: "SECURITY",
					severity: "HIGH",
					guidance: "g",
				},
			]),
		).toHaveLength(1);
	});
});
