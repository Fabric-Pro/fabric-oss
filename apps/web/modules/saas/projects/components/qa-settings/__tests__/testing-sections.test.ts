import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	ALL_SECTION_FIELDS,
	dirtySections,
	isTestingSectionId,
	SECTION_FIELDS,
	TESTING_SECTIONS,
} from "../testing-sections";

describe("TESTING_SECTIONS", () => {
	it("has a unique id, label and blurb per section", () => {
		const ids = TESTING_SECTIONS.map((s) => s.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const section of TESTING_SECTIONS) {
			expect(section.label.length).toBeGreaterThan(0);
			// The blurb is the section's whole explanation — the page header and
			// the About popover both render it, so a placeholder would ship as
			// the only description the reader gets.
			expect(section.blurb.length).toBeGreaterThan(60);
		}
	});

	it("guards its id union at the boundary", () => {
		expect(isTestingSectionId("depth")).toBe(true);
		expect(isTestingSectionId("nonsense")).toBe(false);
		expect(isTestingSectionId(null)).toBe(false);
	});

	it("gives every section a field list", () => {
		for (const section of TESTING_SECTIONS) {
			expect(SECTION_FIELDS[section.id]).toBeDefined();
		}
	});

	it("assigns each draft field to exactly one section", () => {
		expect(new Set(ALL_SECTION_FIELDS).size).toBe(
			ALL_SECTION_FIELDS.length,
		);
	});

	/**
	 * The real guard. `SECTION_FIELDS` is what tells the save bar WHERE an
	 * unsaved change is; a field added to `Draft` without a home here produces a
	 * bar that says "Unsaved changes" with no section named — which is exactly
	 * the state sectioning the page was meant to remove. Read from the source so
	 * the mapping cannot quietly fall behind the type.
	 */
	it("covers every field of the form's Draft type", () => {
		const source = readFileSync(
			path.resolve(__dirname, "../ProjectQaSettingsForm.tsx"),
			"utf8",
		);
		const block = source.slice(
			source.indexOf("type Draft = {"),
			source.indexOf("};", source.indexOf("type Draft = {")),
		);
		const draftFields = [...block.matchAll(/^\t(\w+)\??:/gm)].map(
			(m) => m[1],
		);

		expect(draftFields.length).toBeGreaterThan(10);
		expect([...draftFields].sort()).toEqual([...ALL_SECTION_FIELDS].sort());
	});
});

describe("dirtySections", () => {
	const saved = {
		strategyDepth: "AVERAGE",
		confidenceThreshold: 80,
		coverageTarget: 80,
		indexCoverageEnabled: true,
		scepticRoles: ["security", "a11y"],
		resolutions: ["1920x1080"],
	};

	it("is empty before anything has loaded", () => {
		expect(dirtySections({ ...saved }, null)).toEqual([]);
	});

	it("is empty when the draft matches what was saved", () => {
		expect(dirtySections({ ...saved }, saved)).toEqual([]);
	});

	it("names the section a changed field belongs to", () => {
		expect(
			dirtySections({ ...saved, strategyDepth: "HARD" }, saved),
		).toEqual(["depth"]);
	});

	it("names several sections at once", () => {
		expect(
			dirtySections(
				{ ...saved, strategyDepth: "HARD", coverageTarget: 90 },
				saved,
			),
		).toEqual(["depth", "coverage"]);
	});

	it("ignores list re-ordering — these fields are sets in all but type", () => {
		// Toggling a sceptic role off and back on re-appends it at the end. That
		// must not leave the rail showing an unsaved dot for a change nobody
		// made.
		expect(
			dirtySections(
				{ ...saved, scepticRoles: ["a11y", "security"] },
				saved,
			),
		).toEqual([]);
	});

	it("still catches a real list change", () => {
		expect(
			dirtySections({ ...saved, scepticRoles: ["security"] }, saved),
		).toEqual(["sceptics"]);
	});
});
