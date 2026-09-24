import { describe, expect, it } from "vitest";
import {
	buildRepositoryTree,
	CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
	contextSyncTreeRowState,
	type RepositoryTreeEntry,
	type RepositoryTreeNode,
	searchRepositoryTreeEntries,
} from "../context-repository-sync-tree";

function shape(nodes: RepositoryTreeNode[]): unknown[] {
	return nodes.map((node) =>
		node.type === "dir"
			? { [`${node.name}/`]: shape(node.children) }
			: node.name,
	);
}

describe("buildRepositoryTree", () => {
	it("nests by path with folders first, each group sorted by name", () => {
		const entries: RepositoryTreeEntry[] = [
			{ path: "zeta.md", type: "file" },
			{ path: "docs", type: "dir" },
			{ path: "docs/b.md", type: "file" },
			{ path: "alpha.md", type: "file" },
			{ path: "docs/a.md", type: "file" },
			{ path: "docs/sub", type: "dir" },
			{ path: "assets", type: "dir" },
		];
		expect(shape(buildRepositoryTree(entries))).toEqual([
			{ "assets/": [] },
			{ "docs/": [{ "sub/": [] }, "a.md", "b.md"] },
			"alpha.md",
			"zeta.md",
		]);
	});

	it("creates a folder the provider only implied through its contents", () => {
		const roots = buildRepositoryTree([
			{ path: "src/lib/util.ts", type: "file" },
		]);
		expect(shape(roots)).toEqual([{ "src/": [{ "lib/": ["util.ts"] }] }]);
		expect(roots[0]?.path).toBe("src");
		expect(roots[0]?.children[0]?.path).toBe("src/lib");
	});

	it("keeps one node when a folder is listed after its contents", () => {
		const roots = buildRepositoryTree([
			{ path: "docs/a.md", type: "file" },
			{ path: "docs", type: "dir" },
		]);
		expect(shape(roots)).toEqual([{ "docs/": ["a.md"] }]);
	});

	it("never turns the whole-repository path into a node", () => {
		expect(buildRepositoryTree([{ path: "", type: "dir" }])).toEqual([]);
	});
});

describe("searchRepositoryTreeEntries", () => {
	const entries: RepositoryTreeEntry[] = [
		{ path: "docs", type: "dir" },
		{ path: "docs/Guide.md", type: "file" },
		{ path: "src/guide.ts", type: "file" },
		{ path: "README.md", type: "file" },
	];

	it("matches the path substring case-insensitively, in provider order", () => {
		expect(searchRepositoryTreeEntries(entries, "  GUIDE ")).toEqual({
			entries: [
				{ path: "docs/Guide.md", type: "file" },
				{ path: "src/guide.ts", type: "file" },
			],
			capped: false,
		});
	});

	it("caps the matches and says so only past the cap", () => {
		const many: RepositoryTreeEntry[] = Array.from(
			{ length: CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES + 1 },
			(_, i) => ({ path: `n${i}.md`, type: "file" }),
		);
		const capped = searchRepositoryTreeEntries(many, "n");
		expect(capped.capped).toBe(true);
		expect(capped.entries).toHaveLength(
			CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
		);

		const exact = searchRepositoryTreeEntries(many.slice(1), "n");
		expect(exact.capped).toBe(false);
		expect(exact.entries).toHaveLength(
			CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
		);
	});
});

describe("contextSyncTreeRowState", () => {
	it.each([
		["docs", [], "available"],
		["docs", ["docs"], "selected"],
		["docs/a.md", ["docs"], "covered"],
		["docs/deep/a.md", ["docs"], "covered"],
		["docs", ["docs/a.md"], "contains-selected"],
		// Whole segments only: `doc` is not an ancestor of `docs`.
		["docs", ["doc"], "available"],
		["doc", ["docs/a.md"], "available"],
		["docs", [""], "whole-repository"],
		["docs", ["", "docs"], "whole-repository"],
	] as const)("%s with %j selected is %s", (path, selected, expected) => {
		expect(contextSyncTreeRowState(path, selected)).toBe(expected);
	});
});
