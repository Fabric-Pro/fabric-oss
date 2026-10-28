import { describe, expect, it } from "vitest";
import {
	extractAcceptanceCriteriaText,
	extractScopeText,
	FOCUS_SECTION_WEIGHT,
	type FocusStory,
	focusSectionName,
	MAX_FOCUS_CHARS,
	selectPairFocus,
	weightedFocusSimilarity,
} from "../prisma/queries/projects/duplicate-focus";

/** A feature spec shaped like the drafting template's output. */
const FEATURE_SPEC = [
	"# Clearer onboarding",
	"## Overview",
	"Help new users get started.",
	"## Scope",
	"### In Scope",
	"- Guided first-run checklist",
	"- Welcome tour",
	"### Out of Scope",
	"- Developer integration setup",
	"## Requirements",
	"- R1: the checklist persists progress",
].join("\n");

describe("extractScopeText", () => {
	it("captures In / Out of Scope subsections under a ## Scope heading, with their polarity", () => {
		expect(extractScopeText(FEATURE_SPEC)).toBe(
			[
				"In scope:",
				"- Guided first-run checklist",
				"- Welcome tour",
				"Out of scope:",
				"- Developer integration setup",
			].join("\n"),
		);
	});

	it("stops at the next sibling section", () => {
		const scope = extractScopeText(FEATURE_SPEC);
		expect(scope).not.toContain("R1");
		expect(scope).not.toContain("Help new users");
	});

	it("reads whole-line bold labels as subsections", () => {
		const spec = [
			"## Scope",
			"**In Scope**",
			"- Settings page toggle",
			"**Out of Scope:**",
			"- Public API changes",
			"## Dependencies",
			"- Auth service",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			[
				"In scope:",
				"- Settings page toggle",
				"Out of scope:",
				"- Public API changes",
			].join("\n"),
		);
	});

	it("ends a bold-label section at the next bold label that is not a scope label", () => {
		const spec = [
			"**In Scope**",
			"- Settings page toggle",
			"**Notes**",
			"- Unrelated aside",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			"In scope:\n- Settings page toggle",
		);
	});

	it("reads bold-wrapped headings, and keeps a scope label nested ABOVE the opening level inside the section", () => {
		// Some templates nest `## **In Scope**` under `### **Scope**`.
		const spec = [
			"### **Scope**",
			"## **In Scope**",
			"- Export to CSV",
			"## **Out of Scope**",
			"- Export to PDF",
			"## **Requirements**",
			"- R1",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			"In scope:\n- Export to CSV\nOut of scope:\n- Export to PDF",
		);
	});

	it("accepts a Scope section with no subsections, unprefixed", () => {
		const spec = [
			"## Scope",
			"- Only the settings page",
			"- No API changes",
			"## Requirements",
			"- R1",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			"- Only the settings page\n- No API changes",
		);
	});

	it("keeps an unrecognised sub-heading inside the section as content", () => {
		const spec = [
			"## Scope",
			"### Must have",
			"- Bulk edit",
			"## Requirements",
		].join("\n");
		expect(extractScopeText(spec)).toBe("Must have\n- Bulk edit");
	});

	it("normalizes numbering, hyphens, trailing colons and a trailing parenthetical", () => {
		const spec = [
			"## 5. Scope:",
			"### 8.1 In-Scope (Next Increment)",
			"- Bulk edit",
			"### out-of-scope",
			"- Bulk delete",
			"## 6. Requirements",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			"In scope:\n- Bulk edit\nOut of scope:\n- Bulk delete",
		);
	});

	it("handles CRLF line endings", () => {
		expect(
			extractScopeText("## Scope\r\n### In Scope\r\n- Bulk edit\r\n"),
		).toBe("In scope:\n- Bulk edit");
	});

	it("yields nothing for a Scope section with no body text", () => {
		const spec = [
			"## Scope",
			"### In Scope",
			"### Out of Scope",
			"---",
			"## Requirements",
			"- R1",
		].join("\n");
		expect(extractScopeText(spec)).toBe("");
	});

	it("ignores prose that merely mentions scope", () => {
		expect(
			extractScopeText("Exporting is out of scope for now.\n- Bulk edit"),
		).toBe("");
		expect(extractScopeText(null)).toBe("");
	});

	it("bounds the focus text", () => {
		const spec = `## Scope\n${"- item\n".repeat(2000)}`;
		const scope = extractScopeText(spec);
		expect(scope.length).toBeLessThanOrEqual(MAX_FOCUS_CHARS);
		expect(scope.startsWith("- item")).toBe(true);
	});

	it("only scans a bounded head of the description", () => {
		// A section well past the scan bound is not reached — the parser never
		// runs on unbounded input.
		const spec = `${"x".repeat(50000)}\n## Scope\n- Bulk edit`;
		expect(extractScopeText(spec)).toBe("");
	});

	it("reads a compound label by its first part — 'Out of Scope / Non-Goals'", () => {
		const spec = [
			"## Scope",
			"### In Scope",
			"- Bulk edit",
			"## Out of Scope / Non-Goals",
			"- Bulk delete",
			"## Requirements",
			"- R1",
		].join("\n");
		expect(extractScopeText(spec)).toBe(
			"In scope:\n- Bulk edit\nOut of scope:\n- Bulk delete",
		);
	});

	it("reads a Non-Goals section as Out of Scope", () => {
		const spec = [
			"## Goals",
			"- Faster sign-in",
			"## Non-Goals",
			"- A mobile app",
			"## Requirements",
		].join("\n");
		expect(extractScopeText(spec)).toBe("Out of scope:\n- A mobile app");
	});

	it("reads 'Scope & Boundaries' as a Scope section", () => {
		const spec = [
			"## Scope & Boundaries",
			"- Only the web app",
			"## Requirements",
		].join("\n");
		expect(extractScopeText(spec)).toBe("- Only the web app");
	});

	it("never treats 'Scope justification' as a Scope section", () => {
		const spec = [
			"**Scope justification:** Needed for the launch.",
			"## Scope justification",
			"- Needed for the launch",
			"**Scope justification**",
			"- Still not scope",
		].join("\n");
		expect(extractScopeText(spec)).toBe("");
	});
});

describe("extractAcceptanceCriteriaText", () => {
	it("prefers the acceptanceCriteria field, trimmed", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria:
					"  AC1: Given a new user, the checklist shows  ",
				description: "## Acceptance Criteria\n- something else",
			}),
		).toBe("AC1: Given a new user, the checklist shows");
	});

	it("falls back to the description's Acceptance Criteria section", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: "   ",
				description: [
					"## Overview",
					"Intro.",
					"## Acceptance Criteria (AC)",
					"- Given a new user, the checklist shows",
					"## Notes",
					"- aside",
				].join("\n"),
			}),
		).toBe("- Given a new user, the checklist shows");
	});

	it("is empty when neither the field nor the description has any", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: null,
				description: "## Overview\nIntro.",
			}),
		).toBe("");
	});

	/** Shaped like a legacy stub import: template metadata lines first. */
	const STUB_METADATA = [
		"**Feature ID:** F-003 **Scope justification:** Needed for the launch",
		"**System of record:** Tracker **Feature links:** [link](https://example.com/1)",
		"- System of record: Tracker",
		"- Feature link / ID: https://example.com/f-003",
	].join("\n");

	it("reads the criteria section inside a legacy stub field, not its metadata", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: [
					STUB_METADATA,
					"",
					"### Functional Acceptance Criteria",
					"- Given a new user, when they sign in, then the checklist shows",
					"- Given a returning user, the checklist stays hidden",
					"### Notes",
					"- aside",
				].join("\n"),
				description: "## Acceptance Criteria\n- something else",
			}),
		).toBe(
			[
				"- Given a new user, when they sign in, then the checklist shows",
				"- Given a returning user, the checklist stays hidden",
			].join("\n"),
		);
	});

	it("falls back to the description when the field holds only metadata", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: STUB_METADATA,
				description:
					"## Acceptance Criteria\n- Given a new user, the checklist shows",
			}),
		).toBe("- Given a new user, the checklist shows");
	});

	it("drops metadata lines from a field without a criteria section", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: [
					"**Feature ID:** F-007",
					"AC1: Given a new user, the checklist shows",
					"- **Feature links:** https://example.com/f-007",
					"AC2: Given a returning user, it stays hidden",
				].join("\n"),
			}),
		).toBe(
			"AC1: Given a new user, the checklist shows\nAC2: Given a returning user, it stays hidden",
		);
	});

	it("keeps criteria that merely start with similar words", () => {
		expect(
			extractAcceptanceCriteriaText({
				acceptanceCriteria: "Feature identification works offline",
			}),
		).toBe("Feature identification works offline");
	});
});

describe("selectPairFocus", () => {
	const featureWithScope = (inScope: string): FocusStory => ({
		kind: "FEATURE",
		description: `## Scope\n### In Scope\n- ${inScope}`,
		acceptanceCriteria: "AC1: works",
	});

	it("compares two features on their Scope sections", () => {
		expect(
			selectPairFocus(
				featureWithScope("Guided checklist"),
				featureWithScope("MCP configuration"),
			),
		).toEqual({
			kind: "scope",
			textA: "In scope:\n- Guided checklist",
			textB: "In scope:\n- MCP configuration",
		});
	});

	it("falls back to acceptance criteria for BOTH sides when one feature lacks Scope", () => {
		expect(
			selectPairFocus(featureWithScope("Guided checklist"), {
				kind: "FEATURE",
				description: "## Overview\nNo scope here.",
				acceptanceCriteria: "AC1: the MCP server connects",
			}),
		).toEqual({
			kind: "acceptance_criteria",
			textA: "AC1: works",
			textB: "AC1: the MCP server connects",
		});
	});

	it("keeps the whole-document comparison when neither section is comparable", () => {
		expect(
			selectPairFocus(featureWithScope("Guided checklist"), {
				kind: "FEATURE",
				description: "## Overview\nNo scope here.",
				acceptanceCriteria: null,
			}),
		).toBeNull();
		expect(
			selectPairFocus(
				{ kind: "FEATURE", description: "Plain text" },
				{ kind: "FEATURE", description: "Plain text too" },
			),
		).toBeNull();
	});

	it("never focuses a pair involving a bug, or a row without a kind", () => {
		const bug: FocusStory = {
			...featureWithScope("Guided checklist"),
			kind: "BUG",
		};
		const feature = featureWithScope("Guided checklist");
		expect(selectPairFocus(bug, bug)).toBeNull();
		expect(selectPairFocus(feature, bug)).toBeNull();
		expect(selectPairFocus(bug, feature)).toBeNull();
		expect(
			selectPairFocus({ ...feature, kind: undefined }, feature),
		).toBeNull();
	});
});

describe("weightedFocusSimilarity", () => {
	it("weights the focus cosine by FOCUS_SECTION_WEIGHT and the document cosine by the rest", () => {
		expect(FOCUS_SECTION_WEIGHT).toBe(0.75);
		expect(weightedFocusSimilarity(0.2, 0.9)).toBeCloseTo(0.375, 10);
		expect(weightedFocusSimilarity(1, 0.8)).toBeCloseTo(0.95, 10);
	});

	it("pulls a topic-alike pair with non-overlapping sections below the candidate band", () => {
		// Near-identical documents, orthogonal Scope sections.
		expect(weightedFocusSimilarity(0, 0.99)).toBeLessThan(0.7);
	});

	it("accepts an explicit weight", () => {
		expect(weightedFocusSimilarity(0.5, 1, 0.5)).toBeCloseTo(0.75, 10);
	});
});

describe("focusSectionName", () => {
	it("names each focus kind", () => {
		expect(focusSectionName("scope")).toBe("Scope");
		expect(focusSectionName("acceptance_criteria")).toBe(
			"Acceptance criteria",
		);
	});
});
