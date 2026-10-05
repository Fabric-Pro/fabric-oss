import { afterEach, describe, expect, it, vi } from "vitest";
import { listRepositoryStructure } from "../src/code-search";

/**
 * GitHub returns the whole tree with root-relative paths (`src/a.ts`) and the
 * connector keeps the entries under `directory`. A directory written with a
 * leading slash (`/src`, or `/` for the root) used to match nothing, so the
 * listing came back empty; it now names the same directory as `src`. Case is
 * kept, because `src` and `SRC` can be different directories in Git.
 */

const GITHUB = {
	provider: "GITHUB" as const,
	token: "t",
	owner: "example-org",
	repo: "app",
};

const TREE = [
	{ path: "README.md", type: "blob" },
	{ path: "src", type: "tree" },
	{ path: "src/a.ts", type: "blob" },
	{ path: "src/lib", type: "tree" },
	{ path: "src/lib/b.ts", type: "blob" },
	{ path: "SRC", type: "tree" },
	{ path: "SRC/c.ts", type: "blob" },
	{ path: "srcx/d.ts", type: "blob" },
];

async function list(directory?: string) {
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify({ tree: TREE, truncated: false }), {
			status: 200,
		}),
	);
	const structure = await listRepositoryStructure({ ...GITHUB, directory });
	return structure.entries.map((entry) => entry.path);
}

describe("listRepositoryStructure — GitHub directory filter", () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(["src", "src/", "/src", "/src/", "src//"])(
		"%s lists what is under src, and only that",
		async (directory) => {
			expect(await list(directory)).toEqual([
				"src/a.ts",
				"src/lib",
				"src/lib/b.ts",
			]);
		},
	);

	it.each([undefined, "", "/", "//"])(
		"%o lists the whole repository",
		async (directory) => {
			expect(await list(directory)).toHaveLength(TREE.length);
		},
	);

	it("keeps case: SRC is not src", async () => {
		expect(await list("/SRC")).toEqual(["SRC/c.ts"]);
	});
});
