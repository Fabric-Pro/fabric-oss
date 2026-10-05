import { describe, expect, it } from "vitest";
import {
	excludedPathSchema,
	MAX_EXCLUDED_PATHS,
	mergeExcludedPaths,
} from "../src";

function entries(
	count: number,
	prefix = "dir",
): { path: string; rule: string }[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `${prefix}/file-${i}.txt`,
		rule: `${prefix}/`,
	}));
}

describe("mergeExcludedPaths", () => {
	it("keeps the order of the lists, so what the server judged comes first", () => {
		const server = [{ path: "tasks/a.md", rule: "tasks/" }];
		const client = [{ path: "build/out.js", rule: "build/" }];

		expect(mergeExcludedPaths(server, client)).toEqual([
			...server,
			...client,
		]);
	});

	it("keeps one entry per path, the first one", () => {
		const merged = mergeExcludedPaths(
			[{ path: "tasks/a.md", rule: "tasks/" }],
			[{ path: "tasks/a.md", rule: "*.md" }],
		);

		expect(merged).toEqual([{ path: "tasks/a.md", rule: "tasks/" }]);
	});

	it("stops at the cap however many entries come in", () => {
		const merged = mergeExcludedPaths(
			entries(MAX_EXCLUDED_PATHS - 1, "one"),
			entries(10, "two"),
		);

		expect(merged).toHaveLength(MAX_EXCLUDED_PATHS);
		expect(merged.at(-1)?.path).toBe("two/file-0.txt");
	});

	it("reads an absent list as empty", () => {
		expect(mergeExcludedPaths(undefined, [])).toEqual([]);
	});

	it("drops the extra fields a caller attached to an entry", () => {
		const withLayer = { path: "a", rule: "r", layer: "default" };

		expect(mergeExcludedPaths([withLayer])).toEqual([
			{ path: "a", rule: "r" },
		]);
	});
});

describe("excludedPathSchema", () => {
	it("refuses an empty path", () => {
		expect(
			excludedPathSchema.safeParse({ path: "", rule: "tasks/" }).success,
		).toBe(false);
	});

	it("accepts a path with the rule that left it out", () => {
		expect(
			excludedPathSchema.safeParse({ path: "tasks/a.md", rule: "tasks/" })
				.success,
		).toBe(true);
	});
});
