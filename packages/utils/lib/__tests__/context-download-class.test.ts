import { describe, expect, it } from "vitest";
import { classifyContext } from "../context-download-class";

describe("classifyContext", () => {
	it.each([
		["FILE", "A"],
		["IMAGE", "A"],
		["DOCUMENT", "A"],
		["SPREADSHEET", "A"],
		// An uploaded OpenAPI file is re-typed after embedding; it is still the
		// user's file and must download as such, not as extracted text.
		["API_SPEC", "A"],
	])("classifies %s as A (the original file)", (type, expected) => {
		expect(classifyContext({ type })).toBe(expected);
	});

	it.each([
		["TEXT", "B"],
		["TECH_STACK", "B"],
		["FEATURES", "B"],
		["GOALS", "B"],
		["DESCRIPTION", "B"],
		["LINK", "B"],
		["INTEGRATION", "B"],
		["MEETING_TRANSCRIPT", "B"],
	])("classifies %s as B (pulled/synthesized text)", (type, expected) => {
		expect(classifyContext({ type })).toBe(expected);
	});

	it.each([
		["CODE_FILE", "C"],
		["CODE_FILE_SUMMARY", "C"],
	])("classifies %s as C (code-specific)", (type, expected) => {
		expect(classifyContext({ type })).toBe(expected);
	});

	it("returns the defensive default B for unknown types", () => {
		expect(classifyContext({ type: "SOMETHING_NEW" })).toBe("B");
	});
});
