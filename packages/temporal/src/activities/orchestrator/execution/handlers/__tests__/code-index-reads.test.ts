import { describe, expect, it } from "vitest";
import {
	FILE_WINDOW_LINES,
	fileOutline,
	fileWindow,
	indexedStructure,
	manifestPaths,
	readLineArgument,
} from "../code-index-reads";

describe("indexedStructure", () => {
	const paths = ["src/Api/Booking.cs", "src/Api/Users.cs", "README.md"];

	it("lists files and the folders between them, like a provider tree", () => {
		const tree = indexedStructure(paths);
		expect(tree.entries.map((e) => `${e.type}:${e.path}`)).toEqual([
			"file:README.md",
			"directory:src",
			"directory:src/Api",
			"file:src/Api/Booking.cs",
			"file:src/Api/Users.cs",
		]);
		expect(tree.totalFiles).toBe(3);
		expect(tree.totalDirectories).toBe(2);
	});

	it("keeps to a directory", () => {
		const tree = indexedStructure(paths, "src/");
		expect(tree.entries.map((e) => e.path)).toEqual([
			"src/Api",
			"src/Api/Booking.cs",
			"src/Api/Users.cs",
		]);
	});
});

describe("fileWindow", () => {
	const long = Array.from({ length: 900 }, (_, i) =>
		i % 100 === 0 ? `public class Part${i} {` : `  line ${i + 1}`,
	).join("\n");

	it("returns a short file whole", () => {
		expect(fileWindow("a\nb\n", {})).toEqual({ text: "a\nb\n", note: "" });
	});

	it("returns a long file's first lines, its outline and how to read on", () => {
		const window = fileWindow(long, {});
		expect(window.text.split("\n")).toHaveLength(FILE_WINDOW_LINES);
		expect(window.note).toContain(`Lines 1–${FILE_WINDOW_LINES} of 900`);
		expect(window.note).toContain(`startLine=${FILE_WINDOW_LINES + 1}`);
		expect(window.note).toContain("101: public class Part100 {");
	});

	it("reads the asked lines, numbered", () => {
		const window = fileWindow(long, { startLine: 402, endLine: 403 });
		expect(window.text).toBe("402    line 402\n403    line 403");
		expect(window.note).toContain("Lines 402–403 of 900");
	});
});

describe("helpers", () => {
	it("reads manifest paths and line arguments", () => {
		expect(manifestPaths([{ path: "a.cs" }, { nope: 1 }])).toEqual([
			"a.cs",
		]);
		expect(manifestPaths(null)).toBeNull();
		expect(readLineArgument("12")).toBe(12);
		expect(readLineArgument(0)).toBeUndefined();
	});

	it("outlines declarations, not control flow", () => {
		expect(
			fileOutline([
				"public sealed class A",
				"  if (x) {",
				"  def run(self):",
			]),
		).toEqual(["1: public sealed class A", "3: def run(self):"]);
	});
});
