/**
 * What the shared selection tree shows, as pure functions of the listing,
 * the expansion and the adapter's rows: the rows in order (what the
 * keyboard moves through, and what a WAI-ARIA tree announces of each), and
 * the tree "Show only selected" narrows the listing to.
 */
import { ancestorsOf, type RepositoryTreeNode } from "./repository-tree";
import type { SelectionRow } from "./selection-row";

/** One row on screen, top to bottom. */
export type VisibleTreeRow = {
	node: RepositoryTreeNode;
	/** 1-based, as `aria-level` counts. */
	level: number;
	/** The folder this row is in, `null` at the top level. */
	parent: string | null;
	/** Whether a folder shows its children; `false` for a file. */
	expanded: boolean;
};

/**
 * Every row on screen, in order: each node, then (while it is expanded) its
 * children, which is what renders.
 */
export function visibleTreeRows(
	roots: readonly RepositoryTreeNode[],
	isExpanded: (node: RepositoryTreeNode, depth: number) => boolean,
): VisibleTreeRow[] {
	const rows: VisibleTreeRow[] = [];
	const visit = (
		nodes: readonly RepositoryTreeNode[],
		depth: number,
		parent: string | null,
	) => {
		for (const node of nodes) {
			const expanded = node.type === "dir" && isExpanded(node, depth);
			rows.push({ node, level: depth + 1, parent, expanded });
			if (expanded) {
				visit(node.children, depth + 1, node.path);
			}
		}
	};
	visit(roots, 0, null);
	return rows;
}

/**
 * The row to keep focusable when `path` (the one last focused) is not on
 * screen any more: its nearest ancestor that is, else the first row.
 */
export function focusFallback(
	rows: readonly VisibleTreeRow[],
	path: string | null,
): string | null {
	if (path !== null) {
		const onScreen = new Set(rows.map((row) => row.node.path));
		if (onScreen.has(path)) {
			return path;
		}
		const ancestor = ancestorsOf(path)
			.reverse()
			.find((candidate) => onScreen.has(candidate));
		if (ancestor !== undefined) {
			return ancestor;
		}
	}
	return rows[0]?.node.path ?? null;
}

/**
 * The listing narrowed to what the member chose: ticked and partial rows,
 * rows they left out themselves (`leftOut`), and the folders on the way to
 * any of those. A ticked folder syncs everything inside it, so it is kept
 * whole and its contents are not judged one by one (the tree shows it
 * collapsed); everything else is judged over the whole listing, never only
 * what is expanded. Under a search, `matches` names the rows the search
 * found: a folder there only on the way to a match counts only as the way.
 */
export function selectedOnlyTree(
	nodes: readonly RepositoryTreeNode[],
	row: (node: RepositoryTreeNode) => SelectionRow,
	matches: (node: RepositoryTreeNode) => boolean = () => true,
): RepositoryTreeNode[] {
	const kept: RepositoryTreeNode[] = [];
	for (const node of nodes) {
		const state = row(node);
		const chosen =
			matches(node) &&
			(state.membership === "in" ||
				state.membership === "mixed" ||
				state.leftOut === true);
		if (chosen && state.membership === "in") {
			kept.push(node);
			continue;
		}
		const children =
			node.type === "dir"
				? selectedOnlyTree(node.children, row, matches)
				: [];
		if (chosen || children.length > 0) {
			kept.push({ ...node, children });
		}
	}
	return kept;
}
