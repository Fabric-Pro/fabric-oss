import { describe, expect, it } from "vitest";
import { buildManifest, diffManifest } from "../graph/incremental";

const v1 = [
	{ path: "a.ts", content: "const a = 1;" },
	{ path: "b.ts", content: "const b = 1;" },
	{ path: "c.ts", content: "const c = 1;" },
];

describe("manifest diff", () => {
	it("builds a stable manifest keyed by path", () => {
		const m = buildManifest(v1);
		expect(Object.keys(m).sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		// stable hash
		expect(buildManifest(v1)).toEqual(m);
	});

	it("detects added / changed / deleted / unchanged", () => {
		const prior = buildManifest(v1);
		const v2 = [
			{ path: "a.ts", content: "const a = 1;" }, // unchanged
			{ path: "b.ts", content: "const b = 2;" }, // changed
			{ path: "d.ts", content: "const d = 1;" }, // added (c.ts deleted)
		];
		const diff = diffManifest(prior, v2);
		expect(diff.unchanged).toEqual(["a.ts"]);
		expect(diff.changed).toEqual(["b.ts"]);
		expect(diff.added).toEqual(["d.ts"]);
		expect(diff.deleted).toEqual(["c.ts"]);
		expect(diff.hasChanges).toBe(true);
	});

	it("treats a null prior manifest as everything-added", () => {
		const diff = diffManifest(null, v1);
		expect(diff.added.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
		expect(diff.changed).toEqual([]);
		expect(diff.deleted).toEqual([]);
	});

	it("reports no changes when identical", () => {
		const prior = buildManifest(v1);
		const diff = diffManifest(prior, v1);
		expect(diff.hasChanges).toBe(false);
		expect(diff.unchanged.sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
	});
});
