/**
 * Tests for the section-preservation guard.
 *
 * Run with: pnpm --filter @repo/agent-prompts test
 */

import { describe, expect, it } from "vitest";
import { detectDroppedSections } from "../src/validation/section-preservation";

// A realistic multi-section spec with a substantial Acceptance Criteria section.
const AC_BODY = [
	"GIVEN a page containing a primary button WHEN the page is rendered THEN the button displays the green accent color and not the old blue.",
	"",
	"GIVEN a page containing a link WHEN the page is rendered THEN the link displays the green accent color and not the old blue.",
	"",
	"GIVEN a UI element with an active state WHEN that state is active THEN the element displays the green accent color and not the old blue.",
].join("\n");

const BASELINE = [
	"## Feature Narrative",
	"",
	"As a product user, I want the primary UI elements to reflect the new brand accent color so the identity matches the rebrand direction and stays consistent across surfaces.",
	"",
	"## Use Cases",
	"",
	"UC1: user views a screen with primary UI elements and sees the updated green accent applied consistently across buttons, links, and highlights.",
	"",
	"## Acceptance Criteria",
	"",
	AC_BODY,
	"",
	"## Release Notes",
	"",
	"The primary accent color across the app is now green, matching the finalized brand direction.",
].join("\n");

describe("detectDroppedSections", () => {
	it("returns nothing when the document is unchanged", () => {
		expect(detectDroppedSections(BASELINE, BASELINE)).toEqual([]);
	});

	it("flags a GUTTED section (heading kept, body collapsed to a stub) — the reported bug", () => {
		const gutted = BASELINE.replace(
			AC_BODY,
			"Enable Initiatives in Settings",
		);
		// guard against a bad replace in the fixture
		expect(gutted).not.toBe(BASELINE);
		const result = detectDroppedSections(BASELINE, gutted);
		expect(result).toHaveLength(1);
		expect(result[0].heading).toBe("Acceptance Criteria");
		expect(result[0].reason).toBe("gutted");
		expect(result[0].resultChars).toBeLessThan(result[0].baselineChars);
	});

	it("flags a REMOVED section (heading + body gone, content not elsewhere)", () => {
		const removed = [
			"## Feature Narrative",
			"",
			"As a product user, I want the primary UI elements to reflect the new brand accent color so the identity matches the rebrand direction and stays consistent across surfaces.",
			"",
			"## Use Cases",
			"",
			"UC1: user views a screen with primary UI elements and sees the updated green accent applied consistently across buttons, links, and highlights.",
			"",
			"## Release Notes",
			"",
			"The primary accent color across the app is now green, matching the finalized brand direction.",
		].join("\n");
		const result = detectDroppedSections(BASELINE, removed);
		expect(result).toHaveLength(1);
		expect(result[0].heading).toBe("Acceptance Criteria");
		expect(result[0].reason).toBe("removed");
	});

	it("does NOT flag a rename when the content survives under the new heading", () => {
		const renamed = BASELINE.replace(
			"## Acceptance Criteria",
			"## Success Criteria",
		);
		expect(detectDroppedSections(BASELINE, renamed)).toEqual([]);
	});

	it("does NOT flag a legitimate condense that keeps most of the content", () => {
		// Shorten the AC body but keep the same distinctive words and stay above
		// the gut ratio.
		const condensed = BASELINE.replace(
			AC_BODY,
			[
				"GIVEN a primary button, link, or active element WHEN the page is rendered THEN it displays the green accent color and not the old blue.",
			].join("\n"),
		);
		expect(detectDroppedSections(BASELINE, condensed)).toEqual([]);
	});

	it("does NOT flag when new content is added (nothing lost)", () => {
		const expanded = `${BASELINE}\n\n## Dependencies\n\nDesign team sign-off is required before release.`;
		expect(detectDroppedSections(BASELINE, expanded)).toEqual([]);
	});

	it("returns nothing for a first-generation document (empty baseline)", () => {
		expect(detectDroppedSections("", BASELINE)).toEqual([]);
		expect(detectDroppedSections("   ", BASELINE)).toEqual([]);
	});

	it("ignores sections below the substantial-size threshold", () => {
		const base = `## Notes\n\nShort note.\n\n## Body\n\n${AC_BODY}`;
		// Drop the tiny Notes section — too small to guard.
		const edited = `## Body\n\n${AC_BODY}`;
		expect(detectDroppedSections(base, edited)).toEqual([]);
	});

	it("flags only the gutted section among several", () => {
		const gutted = BASELINE.replace(AC_BODY, "TBD");
		const result = detectDroppedSections(BASELINE, gutted);
		expect(result.map((r) => r.heading)).toEqual(["Acceptance Criteria"]);
	});

	it("names the inner content section, not a wrapping document title, when a section collapses", () => {
		const withTitle = `# Rebrand Primary Accent Color\n\n${BASELINE}`;
		const gutted = withTitle.replace(AC_BODY, "TBD");
		const result = detectDroppedSections(withTitle, gutted);
		expect(result.map((r) => r.heading)).toContain("Acceptance Criteria");
		// The wrapping H1 title is not reported (it would be coarse).
		expect(result.map((r) => r.heading)).not.toContain(
			"Rebrand Primary Accent Color",
		);
	});

	it("de-noises nested flags to the outermost section", () => {
		const longBody = AC_BODY;
		const base = [
			"## Acceptance Criteria",
			"",
			"### Visual Update",
			"",
			longBody,
			"",
			"### Sign-off",
			"",
			longBody,
		].join("\n");
		// Gut the whole thing — both the parent and the subsections collapse.
		const gutted = "## Acceptance Criteria\n\nTBD";
		const result = detectDroppedSections(base, gutted);
		// Only the outermost section is reported, not each subsection.
		expect(result).toHaveLength(1);
		expect(result[0].heading).toBe("Acceptance Criteria");
	});
});
