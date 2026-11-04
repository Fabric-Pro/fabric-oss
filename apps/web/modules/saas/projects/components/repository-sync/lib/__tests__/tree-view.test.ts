/**
 * What the shared selection tree shows: the rows on screen in order (what
 * the keyboard walks and each row's level announces), where focus goes when
 * its row disappears, and the listing "Show only selected" narrows to.
 */
import { describe, expect, it } from "vitest";
import {
	indexRepositoryTree,
	type RepositoryTreeNode,
} from "../repository-tree";
import type { SelectionMembership, SelectionRow } from "../selection-row";
import { focusFallback, selectedOnlyTree, visibleTreeRows } from "../tree-view";

const TREE = indexRepositoryTree([
	{ path: "docs", type: "dir" },
	{ path: "docs/guide.md", type: "file" },
	{ path: "docs/old", type: "dir" },
	{ path: "docs/old/notes.md", type: "file" },
	{ path: "tools", type: "dir" },
	{ path: "tools/run.md", type: "file" },
	{ path: "README.md", type: "file" },
]);

const paths = (nodes: readonly RepositoryTreeNode[]): string[] =>
	nodes.flatMap((node) => [node.path, ...paths(node.children)]);

describe("visibleTreeRows", () => {
	it("lists each row, then an expanded folder's children, with its level and folder", () => {
		const open = new Set(["docs"]);
		const rows = visibleTreeRows(TREE.roots, (node) => open.has(node.path));
		expect(
			rows.map(({ node, level, parent, expanded }) => [
				node.path,
				level,
				parent,
				expanded,
			]),
		).toEqual([
			["docs", 1, null, true],
			["docs/old", 2, "docs", false],
			["docs/guide.md", 2, "docs", false],
			["tools", 1, null, false],
			["README.md", 1, null, false],
		]);
	});

	it("passes the depth, so a tree can open only its top level", () => {
		const rows = visibleTreeRows(TREE.roots, (_, depth) => depth === 0);
		expect(rows.map((row) => row.node.path)).toEqual([
			"docs",
			"docs/old",
			"docs/guide.md",
			"tools",
			"tools/run.md",
			"README.md",
		]);
	});
});

describe("focusFallback", () => {
	const rows = visibleTreeRows(TREE.roots, () => false);

	it("keeps a row that is still on screen", () => {
		expect(focusFallback(rows, "tools")).toBe("tools");
	});

	it("moves to the nearest ancestor on screen when a folder closed over the row", () => {
		expect(focusFallback(rows, "docs/old/notes.md")).toBe("docs");
	});

	it("moves to the first row when nothing on the way is on screen, or nothing was focused", () => {
		expect(focusFallback(rows, "gone/away.md")).toBe("docs");
		expect(focusFallback(rows, null)).toBe("docs");
		expect(focusFallback([], "docs")).toBeNull();
	});
});

describe("selectedOnlyTree", () => {
	const rowFor =
		(
			memberships: Record<string, SelectionMembership>,
			leftOut: string[] = [],
		) =>
		(node: RepositoryTreeNode): SelectionRow => ({
			membership: memberships[node.path] ?? "out",
			disabledReason: null,
			...(leftOut.includes(node.path) ? { leftOut: true as const } : {}),
		});

	it("keeps a ticked folder whole, and a partial one with only what was chosen inside it", () => {
		const row = rowFor({
			tools: "in",
			"tools/run.md": "in",
			docs: "mixed",
			"docs/guide.md": "in",
		});
		expect(paths(selectedOnlyTree(TREE.roots, row))).toEqual([
			"docs",
			"docs/guide.md",
			"tools",
			"tools/run.md",
		]);
	});

	it("keeps what the member left out, with the folders on the way", () => {
		const row = rowFor({ docs: "mixed", "docs/guide.md": "in" }, [
			"docs/old/notes.md",
		]);
		expect(paths(selectedOnlyTree(TREE.roots, row))).toEqual([
			"docs",
			"docs/old",
			"docs/old/notes.md",
			"docs/guide.md",
		]);
	});

	it("is empty when nothing is chosen", () => {
		expect(selectedOnlyTree(TREE.roots, rowFor({}))).toEqual([]);
	});

	it("under a search, keeps a folder only as the way to a chosen match", () => {
		const row = rowFor({
			docs: "in",
			"docs/guide.md": "in",
			"docs/old": "in",
			"docs/old/notes.md": "in",
		});
		const matches = (node: RepositoryTreeNode) =>
			node.name.includes("notes");
		const kept = selectedOnlyTree(TREE.roots, row, matches);
		expect(paths(kept)).toEqual(["docs", "docs/old", "docs/old/notes.md"]);
		// `docs` is only the way there, so it does not keep all of itself.
		expect(kept[0]?.children.map((child) => child.path)).toEqual([
			"docs/old",
		]);
	});
});
