"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Checkbox } from "@ui/components/checkbox";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	Loader2Icon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useMemo, useState } from "react";
import { contextSyncTreeErrorMessage } from "../lib/context-repository-sync";
import {
	buildRepositoryTree,
	CONTEXT_SYNC_TREE_ENTRY_LIMIT,
	CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES,
	type ContextSyncTreeRowState,
	contextSyncTreeRowState,
	type RepositoryTreeNode,
	searchRepositoryTreeEntries,
} from "../lib/context-repository-sync-tree";

/** How long the branch must stay unchanged before the listing is fetched. */
const BRANCH_DEBOUNCE_MS = 500;
const LIST_TREE_STALE_MS = 5 * 60 * 1000;

/**
 * `value` once it has stopped changing for `delayMs`; the first value is
 * settled at once. Not `usehooks-ts`'s `useDebounceValue`: that one leaves
 * its timer running after unmount, and the test setup replaces it with a
 * synchronous stub, so the debounce this listing depends on would go
 * unverified. This timer is cleared on every change and on unmount.
 */
function useSettledValue<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		if (Object.is(value, settled)) {
			return;
		}
		const timer = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, settled, delayMs]);
	return settled;
}

/**
 * The configure dialog's browser over one branch of the chosen repository
 * (Fizzy #2674): its folders and files as checkboxes, with a search. The
 * dialog's chip list stays the only selection state — a row is checked when
 * its path is a chip, and checking one goes through the same validation as
 * a typed path (`onSelect`) — so removing a chip unchecks its row with no
 * state of the tree's own. Whatever the listing's outcome, the typed input
 * beside it keeps working; this only renders what the listing allows.
 *
 * Laziness by expansion is the performance strategy: a folder's children
 * are rendered only while it is expanded, and a search shows at most
 * `CONTEXT_SYNC_TREE_SEARCH_MAX_MATCHES` matches.
 */
export function ContextRepositorySyncTreeBrowser({
	projectId,
	repositoryIntegrationId,
	branch,
	paths,
	disabled,
	onSelect,
	onDeselect,
}: {
	projectId: string;
	repositoryIntegrationId: string;
	/** Already trimmed. */
	branch: string;
	paths: readonly string[];
	disabled: boolean;
	onSelect: (path: string) => void;
	onDeselect: (path: string) => void;
}) {
	const t = useTranslations("projects.contexts.livingMemory.repositorySync");
	const debouncedBranch = useSettledValue(branch, BRANCH_DEBOUNCE_MS);
	// Only a settled branch is listed: a key per keystroke would be a
	// request per keystroke, and a stale one would list the wrong branch.
	const enabled =
		repositoryIntegrationId !== "" &&
		branch !== "" &&
		debouncedBranch === branch;
	const tree = useQuery(
		orpc.projects.contexts.repositorySync.listTree.queryOptions({
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
	// Browse-mode expansion as the folders flipped from their default (roots
	// open, deeper folders closed), so a new listing needs no reset.
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
		const message = contextSyncTreeErrorMessage(
			tree.error,
			debouncedBranch,
		);
		return (
			<p role="alert" className="text-destructive text-xs">
				{t(message.key, message.values)}
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

	const wholeRepository = paths.includes("");
	const roots = searching ? searchRoots : browseRoots;

	function isExpanded(path: string, depth: number): boolean {
		if (searching) {
			return !(
				searchCollapsed.query === query &&
				searchCollapsed.paths.has(path)
			);
		}
		return (depth === 0) !== toggled.has(path);
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

	const rowContext: TreeRowContext = {
		paths,
		disabled,
		isExpanded,
		toggle,
		onSelect,
		onDeselect,
	};

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
			{wholeRepository ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.wholeRepository")}
				</p>
			) : null}
			<div className="max-h-64 overflow-y-auto rounded-md border border-input p-2">
				{roots.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						{t("tree.noMatches")}
					</p>
				) : (
					<ul aria-label={t("tree.label")} className="flex flex-col">
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
			</div>
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
	paths: readonly string[];
	disabled: boolean;
	isExpanded: (path: string, depth: number) => boolean;
	toggle: (path: string) => void;
	onSelect: (path: string) => void;
	onDeselect: (path: string) => void;
};

const ROW_HELPER_KEYS: Partial<Record<ContextSyncTreeRowState, string>> = {
	covered: "tree.coveredByParent",
	"contains-selected": "tree.containsSelected",
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
	const t = useTranslations("projects.contexts.livingMemory.repositorySync");
	const id = useId();
	const state = contextSyncTreeRowState(node.path, context.paths);
	const helperKey = ROW_HELPER_KEYS[state];
	const folder = node.type === "dir";
	const expanded = folder && context.isExpanded(node.path, depth);
	const checkboxId = `${id}-checkbox`;
	const helperId = `${id}-helper`;

	const row = (
		<div className="flex min-w-0 items-center gap-2 py-0.5">
			{folder ? (
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
			) : (
				<span className="size-4 shrink-0" aria-hidden="true" />
			)}
			<Checkbox
				id={checkboxId}
				aria-label={node.path}
				aria-describedby={helperKey ? helperId : undefined}
				checked={state === "selected"}
				disabled={
					context.disabled ||
					(state !== "selected" && state !== "available")
				}
				onCheckedChange={(checked) => {
					if (checked === true) {
						context.onSelect(node.path);
					} else {
						context.onDeselect(node.path);
					}
				}}
			/>
			{folder ? (
				<FolderIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			) : (
				<FileIcon
					className="size-4 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			)}
			<label
				htmlFor={checkboxId}
				className="truncate font-mono text-xs"
				title={node.path}
			>
				{node.name}
			</label>
			{helperKey ? (
				<span
					id={helperId}
					className="shrink-0 text-muted-foreground text-xs"
				>
					{t(helperKey)}
				</span>
			) : null}
		</div>
	);

	if (!folder) {
		return <li>{row}</li>;
	}
	return (
		<li>
			<Collapsible
				open={expanded}
				onOpenChange={() => context.toggle(node.path)}
			>
				{row}
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
