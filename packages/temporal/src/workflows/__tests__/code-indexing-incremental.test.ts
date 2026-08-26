import { describe, expect, it } from "vitest";
import {
	isIncrementalRun,
	selectChangedFiles,
} from "../code-indexing-incremental";

describe("isIncrementalRun", () => {
	it("is true only when incremental AND a non-empty changed list are given", () => {
		expect(isIncrementalRun(true, ["a.ts"])).toBe(true);
		expect(isIncrementalRun(true, [])).toBe(false);
		expect(isIncrementalRun(true, undefined)).toBe(false);
		expect(isIncrementalRun(false, ["a.ts"])).toBe(false);
		expect(isIncrementalRun(undefined, ["a.ts"])).toBe(false);
	});
});

describe("selectChangedFiles", () => {
	const files = [
		{ relativePath: "src/a.ts", absolutePath: "/x/src/a.ts" },
		{ relativePath: "src/b.ts", absolutePath: "/x/src/b.ts" },
		{ relativePath: "README.md", absolutePath: "/x/README.md" },
	];

	it("keeps only files whose path is in the changed set, preserving order", () => {
		expect(selectChangedFiles(files, ["README.md", "src/a.ts"])).toEqual([
			files[0],
			files[2],
		]);
	});

	it("ignores changed paths not in the checkout (e.g. deleted files)", () => {
		expect(selectChangedFiles(files, ["src/gone.ts"])).toEqual([]);
	});

	it("returns nothing for an empty changed set", () => {
		expect(selectChangedFiles(files, [])).toEqual([]);
	});

	it("re-derives identically for the same inputs (deterministic across continueAsNew)", () => {
		const a = selectChangedFiles(files, ["src/b.ts", "src/a.ts"]);
		const b = selectChangedFiles(files, ["src/b.ts", "src/a.ts"]);
		expect(a).toEqual(b);
		expect(a).toEqual([files[0], files[1]]);
	});
});
