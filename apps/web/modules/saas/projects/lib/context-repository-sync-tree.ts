/**
 * The configure dialog's repository tree browser (Fizzy #2674): what
 * `projects.contexts.repositorySync.listTree`'s flat entries mean as a tree,
 * a search over them, and what one row may do given the chips already
 * selected. Pure, so the dialog's rendering and its tests share one answer;
 * the selection rules are the ones `validateContextSyncPathAddition` in
 * `./context-repository-sync` enforces, stated per row so the tree can
 * disable what that validation would refuse.
 */

/** One entry as `listTree` returns it, in the sync's plain path spelling. */
export type RepositoryTreeEntry = { path: string; type: "file" | "dir" };

export type RepositoryTreeNode = {
	path: string;
	name: string;
	type: "file" | "dir";
	children: RepositoryTreeNode[];
};

/**
 * Most entries one listing returns; a `truncated` listing stopped here.
 * Mirrors `MAX_REPOSITORY_TREE_ENTRIES` in `@repo/connectors`, which the web
 * app does not import; only the notice's copy depends on it.
 */
export const CONTEXT_SYNC_TREE_ENTRY_LIMIT = 20_000;

/** Most matches a search shows before asking for a narrower query. */
export const CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES = 200;

function compareTreeNodes(
	a: RepositoryTreeNode,
	b: RepositoryTreeNode,
): number {
	if (a.type !== b.type) {
		return a.type === "dir" ? -1 : 1;
	}
	return a.name.localeCompare(b.name);
}

function sortTreeLevel(nodes: RepositoryTreeNode[]): void {
	nodes.sort(compareTreeNodes);
	for (const node of nodes) {
		if (node.children.length > 0) {
			sortTreeLevel(node.children);
		}
	}
}

/**
 * Nest the flat entries by `/`. At every level folders come first, then
 * files, each sorted by name. A folder the provider did not list (only its
 * contents) is created, since its contents are only reachable through it;
 * an entry listed twice keeps one node, a folder if either listing says so.
 */
export function buildRepositoryTree(
	entries: readonly RepositoryTreeEntry[],
): RepositoryTreeNode[] {
	const roots: RepositoryTreeNode[] = [];
	const byPath = new Map<string, RepositoryTreeNode>();

	function attach(node: RepositoryTreeNode): void {
		const slash = node.path.lastIndexOf("/");
		const siblings =
			slash === -1 ? roots : folderAt(node.path.slice(0, slash)).children;
		siblings.push(node);
		byPath.set(node.path, node);
	}

	function folderAt(path: string): RepositoryTreeNode {
		const existing = byPath.get(path);
		if (existing) {
			existing.type = "dir";
			return existing;
		}
		const slash = path.lastIndexOf("/");
		const node: RepositoryTreeNode = {
			path,
			name: slash === -1 ? path : path.slice(slash + 1),
			type: "dir",
			children: [],
		};
		attach(node);
		return node;
	}

	for (const entry of entries) {
		if (entry.path === "") {
			continue;
		}
		const existing = byPath.get(entry.path);
		if (existing) {
			if (entry.type === "dir") {
				existing.type = "dir";
			}
			continue;
		}
		const slash = entry.path.lastIndexOf("/");
		attach({
			path: entry.path,
			name: slash === -1 ? entry.path : entry.path.slice(slash + 1),
			type: entry.type,
			children: [],
		});
	}

	sortTreeLevel(roots);
	return roots;
}

/**
 * The entries whose path contains `query`, case-insensitively, at most
 * `maxMatches` of them in provider order. Their ancestor folders are not
 * returned: `buildRepositoryTree` creates them, so the result nests in place.
 */
export function searchRepositoryTreeEntries(
	entries: readonly RepositoryTreeEntry[],
	query: string,
	maxMatches: number = CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
): { entries: RepositoryTreeEntry[]; capped: boolean } {
	const needle = query.trim().toLowerCase();
	const matches: RepositoryTreeEntry[] = [];
	for (const entry of entries) {
		if (!entry.path.toLowerCase().includes(needle)) {
			continue;
		}
		if (matches.length === maxMatches) {
			return { entries: matches, capped: true };
		}
		matches.push(entry);
	}
	return { entries: matches, capped: false };
}

/**
 * What one tree row may do, given the selected chips:
 *  - `selected`: its path is a chip; unchecking removes it.
 *  - `whole-repository`: `""` is selected, which covers everything.
 *  - `covered`: an ancestor folder is selected.
 *  - `contains-selected`: a folder with a selected path inside it; selecting
 *    it would overlap, and the tree does not silently replace selections.
 *  - `available`: selectable, subject to the chip validation (the cap).
 */
export type ContextSyncTreeRowState =
	| "selected"
	| "whole-repository"
	| "covered"
	| "contains-selected"
	| "available";

export function contextSyncTreeRowState(
	path: string,
	selected: readonly string[],
): ContextSyncTreeRowState {
	if (selected.includes("")) {
		return "whole-repository";
	}
	if (selected.includes(path)) {
		return "selected";
	}
	if (selected.some((other) => path.startsWith(`${other}/`))) {
		return "covered";
	}
	if (selected.some((other) => other.startsWith(`${path}/`))) {
		return "contains-selected";
	}
	return "available";
}
