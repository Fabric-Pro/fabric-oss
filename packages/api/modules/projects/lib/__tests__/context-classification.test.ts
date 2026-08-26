import { describe, expect, it } from "vitest";
import { classifyContext, dedupeFilename } from "../context-classification";

describe("classifyContext", () => {
	it.each([
		["FILE", "A"],
		["IMAGE", "A"],
		["DOCUMENT", "A"],
		["SPREADSHEET", "A"],
	])("classifies %s as A", (type, expected) => {
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

describe("dedupeFilename", () => {
	it("returns the original name on first sighting", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
	});

	it("appends numeric suffix before the extension on collision", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-1.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-2.md");
	});

	it("appends a bare suffix when the name has no extension", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "README")).toBe("README");
		expect(dedupeFilename(seen, "README")).toBe("README-1");
		expect(dedupeFilename(seen, "README")).toBe("README-2");
	});

	it("uses the last dot to split stem and extension", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "archive.tar.gz")).toBe("archive.tar.gz");
		expect(dedupeFilename(seen, "archive.tar.gz")).toBe("archive.tar-1.gz");
	});

	it("tracks independent counters per filename", () => {
		const seen = new Map<string, number>();
		expect(dedupeFilename(seen, "a.md")).toBe("a.md");
		expect(dedupeFilename(seen, "b.md")).toBe("b.md");
		expect(dedupeFilename(seen, "a.md")).toBe("a-1.md");
	});
});
