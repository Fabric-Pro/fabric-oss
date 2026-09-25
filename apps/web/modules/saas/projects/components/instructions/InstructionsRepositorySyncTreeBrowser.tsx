"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	FolderRootIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useMemo, useState } from "react";
import { useSettledValue } from "../../hooks/use-settled-value";
import {
	buildRepositoryTree,
	CONTEXT_SYNC_TREE_ENTRY_LIMIT,
	CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
	type RepositoryTreeNode,
	searchRepositoryTreeEntries,
} from "../../lib/context-repository-sync-tree";
import {
	repositorySyncTreeErrorKey,
	repositorySyncTreeSelection,
} from "../../lib/instructions-repository-sync";

/** How long the branch must stay unchanged before the listing is fetched. */
const BRANCH_DEBOUNCE_MS = 500;
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/**
 * The radio value of the "Repository root" option. Never a folder's path: a
 * listed path never starts with `/`. Radix compares values as strings, so
 * the root gets one of its own rather than `""`.
 */
const ROOT_OPTION_VALUE = "/";

/** The folders on the way to `path`, outermost first (not `path` itself). */
function ancestorsOf(path: string): string[] {
	const segments = path.split("/");
	return segments
		.slice(0, -1)
		.map((_, i) => segments.slice(0, i + 1).join("/"));
}

/**
 * The Coding Instructions configure dialog's browser over one branch of the
 * chosen repository (Fizzy #2725, after Living Memory's #2674): one radio
 * per folder plus "Repository root", with the branch's files shown muted
 * for orientation — where CLAUDE.md or AGENTS.md live — but never
 * selectable, since the sync reads a folder. The typed folder input stays
 * the only selection state: a row is selected when the typed value, trimmed
 * and without trailing slashes, is its path, and picking a row writes to
 * that input (`onSelect`), so the two can never disagree. Whatever the
 * listing's outcome, the typed input keeps working; this only renders what
 * the listing allows.
 *
 * Laziness by expansion is the performance strategy: a folder's children
 * are rendered only while it is expanded, and a search shows at most
 * `CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES` matches.
 */
export function InstructionsRepositorySyncTreeBrowser({
	projectId,
	repositoryIntegrationId,
	branch,
	rootPath,
	disabled,
	onSelect,
}: {
	projectId: string;
	repositoryIntegrationId: string;
	/** Already trimmed. */
	branch: string;
	/** The folder input's value, as typed. */
	rootPath: string;
	disabled: boolean;
	/** A folder's path, or `""` for the repository root. */
	onSelect: (rootPath: string) => void;
}) {
	const t = useTranslations("projects.codingInstructions.repositorySync");
	const hintId = useId();
	const debouncedBranch = useSettledValue(branch, BRANCH_DEBOUNCE_MS);
	// Only a settled branch is listed: a key per keystroke would be a
	// request per keystroke, and a stale one would list the wrong branch.
	const enabled =
		repositoryIntegrationId !== "" &&
		branch !== "" &&
		debouncedBranch === branch;
	const tree = useQuery(
		orpc.projects.instructions.repositorySync.listTree.queryOptions({
			input: {
				projectId,
				repositoryIntegrationId,
				ref: debouncedBranch,
			},
			enabled,
			staleTime: LIST_TREE_STALE_MS,
			retry: false,
		}),
	);
	const listing = tree.data;

	const [search, setSearch] = useState("");
	// Browse-mode expansion as the folders flipped from their default, so a
	// new listing needs no reset. By default root folders are open, and so
	// is every folder on the way to the folder the dialog opened with, so a
	// stored configuration shows its selection. Seeded once: a default that
	// followed later picks would flip folders the member already toggled.
	const [openedWith] = useState(
		() => new Set(ancestorsOf(repositorySyncTreeSelection(rootPath))),
	);
	const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
	// Search-mode expansion: every folder open unless collapsed during this
	// query. Kept apart so clearing the search restores `toggled` untouched.
	const [searchCollapsed, setSearchCollapsed] = useState<{
		query: string;
		paths: ReadonlySet<string>;
	}>({ query: "", paths: new Set() });

	const query = search.trim();
	const searching = query !== "";
	const entries = listing?.entries;
	const browseRoots = useMemo(
		() => (entries ? buildRepositoryTree(entries) : []),
		[entries],
	);
	const searchResult = useMemo(
		() =>
			entries && searching
				? searchRepositoryTreeEntries(entries, query)
				: null,
		[entries, searching, query],
	);
	const searchRoots = useMemo(
		() => (searchResult ? buildRepositoryTree(searchResult.entries) : []),
		[searchResult],
	);

	if (repositoryIntegrationId === "" || branch === "") {
		return null;
	}

	if (!enabled || tree.isPending) {
		return (
			<output className="flex items-center gap-2 text-muted-foreground text-xs">
				<Loader2Icon
					className="size-3 animate-spin"
					aria-hidden="true"
				/>
				{t("tree.loading")}
			</output>
		);
	}

	if (tree.isError) {
		return (
			<p role="alert" className="text-destructive text-xs">
				{t(repositorySyncTreeErrorKey(tree.error), {
					ref: debouncedBranch,
				})}
			</p>
		);
	}

	if (!listing?.supported) {
		return (
			<p className="text-muted-foreground text-xs">
				{t("tree.unsupported")}
			</p>
		);
	}

	if (listing.entries.length === 0) {
		return (
			<p className="text-muted-foreground text-xs">{t("tree.empty")}</p>
		);
	}

	const selection = repositorySyncTreeSelection(rootPath);
	const roots = searching ? searchRoots : browseRoots;

	function isExpanded(path: string, depth: number): boolean {
		if (searching) {
			return !(
				searchCollapsed.query === query &&
				searchCollapsed.paths.has(path)
			);
		}
		const openByDefault = depth === 0 || openedWith.has(path);
		return openByDefault !== toggled.has(path);
	}

	function toggle(path: string) {
		if (searching) {
			setSearchCollapsed((prev) => {
				const next = new Set(prev.query === query ? prev.paths : []);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
				}
				return { query, paths: next };
			});
			return;
		}
		setToggled((prev) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}

	const rowContext: TreeRowContext = { isExpanded, toggle };
	const rootRadioId = `${hintId}-root`;

	return (
		<div className="flex flex-col gap-1.5">
			<SearchInput
				value={search}
				onChange={(e) => setSearch(e.target.value)}
				placeholder={t("tree.searchPlaceholder")}
				aria-label={t("tree.searchPlaceholder")}
			/>
			{listing.truncated ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.truncated", {
						max: CONTEXT_SYNC_TREE_ENTRY_LIMIT,
					})}
				</p>
			) : null}
			<p id={hintId} className="text-muted-foreground text-xs">
				{t("tree.hint")}
			</p>
			<RadioGroup
				value={selection === "" ? ROOT_OPTION_VALUE : selection}
				onValueChange={(value) =>
					onSelect(value === ROOT_OPTION_VALUE ? "" : value)
				}
				disabled={disabled}
				aria-label={t("tree.label")}
				aria-describedby={hintId}
				className="flex max-h-64 flex-col gap-0 overflow-y-auto rounded-md border border-input p-2"
			>
				<div className="flex min-w-0 items-center gap-2 py-0.5">
					<span className="size-4 shrink-0" aria-hidden="true" />
					<RadioGroupItem
						id={rootRadioId}
						value={ROOT_OPTION_VALUE}
						aria-label={t("tree.repositoryRoot")}
					/>
					<FolderRootIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<label htmlFor={rootRadioId} className="truncate text-xs">
						{t("tree.repositoryRoot")}
					</label>
				</div>
				{roots.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						{t("tree.noMatches")}
					</p>
				) : (
					<ul className="flex flex-col">
						{roots.map((node) => (
							<TreeRow
								key={node.path}
								node={node}
								depth={0}
								context={rowContext}
							/>
						))}
					</ul>
				)}
			</RadioGroup>
			{searchResult?.capped ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.refineSearch", {
						max: CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
					})}
				</p>
			) : null}
		</div>
	);
}

type TreeRowContext = {
	isExpanded: (path: string, depth: number) => boolean;
	toggle: (path: string) => void;
};

function TreeRow({
	node,
	depth,
	context,
}: {
	node: RepositoryTreeNode;
	depth: number;
	context: TreeRowContext;
}) {
	const id = useId();

	if (node.type !== "dir") {
		// Orientation only: the sync reads a folder, so a file is text, with
		// no control to focus or choose.
		return (
			<li className="flex min-w-0 items-center gap-2 py-0.5 text-muted-foreground">
				<span className="size-4 shrink-0" aria-hidden="true" />
				<span className="size-4 shrink-0" aria-hidden="true" />
				<FileIcon className="size-4 shrink-0" aria-hidden="true" />
				<span className="truncate font-mono text-xs" title={node.path}>
					{node.name}
				</span>
			</li>
		);
	}

	const expanded = context.isExpanded(node.path, depth);
	const radioId = `${id}-radio`;
	return (
		<li>
			<Collapsible
				open={expanded}
				onOpenChange={() => context.toggle(node.path)}
			>
				<div className="flex min-w-0 items-center gap-2 py-0.5">
					<CollapsibleTrigger asChild>
						<button
							type="button"
							aria-label={node.name}
							className="rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						>
							<ChevronRightIcon
								className={cn(
									"size-4 transition-transform",
									expanded && "rotate-90",
								)}
								aria-hidden="true"
							/>
						</button>
					</CollapsibleTrigger>
					<RadioGroupItem
						id={radioId}
						value={node.path}
						aria-label={node.path}
					/>
					<FolderIcon
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<label
						htmlFor={radioId}
						className="truncate font-mono text-xs"
						title={node.path}
					>
						{node.name}
					</label>
				</div>
				<CollapsibleContent>
					<ul className="flex flex-col pl-4">
						{node.children.map((child) => (
							<TreeRow
								key={child.path}
								node={child}
								depth={depth + 1}
								context={context}
							/>
						))}
					</ul>
				</CollapsibleContent>
			</Collapsible>
		</li>
	);
}
