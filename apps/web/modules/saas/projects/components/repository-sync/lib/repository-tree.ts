/**
 * A repository listing as the shared selection tree shows it (Fizzy #2674,
 * #2725, #2750): what either `listTree` procedure's flat entries mean as a
 * tree, and a search over them. Pure, so the tree's rendering, both feature
 * adapters (`./instructions-selection`, `./context-selection`) and their
 * tests share one answer.
 */

/**
 * One entry as `listTree` returns it, in the sync's plain path spelling.
 * `regular: false` marks a file that is not a regular file (a symbolic
 * link), which no sync reads (Fizzy #2726).
 */
export type RepositoryTreeEntry = {
	path: string;
	type: "file" | "dir";
	regular?: false;
};

export type RepositoryTreeNode = {
	path: string;
	name: string;
	type: "file" | "dir";
	/** The entry's `regular: false`, kept on a file node only. */
	regular?: false;
	children: RepositoryTreeNode[];
};

/**
 * Most entries one listing returns; a `truncated` listing stopped here.
 * Mirrors `MAX_REPOSITORY_TREE_ENTRIES` in `@repo/connectors`, which the web
 * app does not import; only the notice's copy depends on it.
 */
export const REPOSITORY_TREE_ENTRY_LIMIT = 20_000;

/** Most matches a search shows before asking for a narrower query. */
export const REPOSITORY_TREE_SEARCH_MAX_MATCHES = 200;

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
 * A file node keeps its entry's `regular: false`; a folder never has one.
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
			delete existing.regular;
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
				delete existing.regular;
			}
			continue;
		}
		const slash = entry.path.lastIndexOf("/");
		attach({
			path: entry.path,
			name: slash === -1 ? entry.path : entry.path.slice(slash + 1),
			type: entry.type,
			...(entry.type === "file" && entry.regular === false
				? { regular: false as const }
				: {}),
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
	maxMatches: number = REPOSITORY_TREE_SEARCH_MAX_MATCHES,
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

/** The folders on the way to `path`, outermost first (not `path` itself). */
export function ancestorsOf(path: string): string[] {
	const segments = path.split("/");
	return segments
		.slice(0, -1)
		.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** `path` is strictly inside `folder`, by whole segments; `""` is the repository. */
export function isStrictlyInside(folder: string, path: string): boolean {
	return folder === "" ? path !== "" : path.startsWith(`${folder}/`);
}

/**
 * A whole listing, nested once: the adapters judge every row against it,
 * whatever the search shows or the member expanded (Fizzy #2750 §3.1).
 * `nodes` holds every node by path, folders the provider only implied
 * included; `files` every file node; `entryByPath` each listed entry as the
 * provider returned it, with whatever the feature's `listTree` adds.
 */
export type RepositoryTreeIndex<
	TEntry extends RepositoryTreeEntry = RepositoryTreeEntry,
> = {
	roots: RepositoryTreeNode[];
	nodes: ReadonlyMap<string, RepositoryTreeNode>;
	files: readonly RepositoryTreeNode[];
	entryByPath: ReadonlyMap<string, TEntry>;
};

export function indexRepositoryTree<TEntry extends RepositoryTreeEntry>(
	entries: readonly TEntry[],
): RepositoryTreeIndex<TEntry> {
	const roots = buildRepositoryTree(entries);
	const nodes = new Map<string, RepositoryTreeNode>();
	const files: RepositoryTreeNode[] = [];
	const stack = [...roots];
	while (stack.length > 0) {
		const node = stack.pop() as RepositoryTreeNode;
		nodes.set(node.path, node);
		if (node.type === "file") {
			files.push(node);
		} else {
			stack.push(...node.children);
		}
	}
	const entryByPath = new Map<string, TEntry>();
	for (const entry of entries) {
		if (!entryByPath.has(entry.path)) {
			entryByPath.set(entry.path, entry);
		}
	}
	return { roots, nodes, files, entryByPath };
}
