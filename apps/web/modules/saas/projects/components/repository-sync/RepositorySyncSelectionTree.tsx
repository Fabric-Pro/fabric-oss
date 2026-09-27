"use client";

import { Button } from "@ui/components/button";
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
import { type ReactNode, useId, useMemo, useState } from "react";
import {
	buildRepositoryTree,
	REPOSITORY_TREE_ENTRY_LIMIT,
	REPOSITORY_TREE_SEARCH_MAX_MATCHES,
	type RepositoryTreeNode,
	searchRepositoryTreeEntries,
} from "./lib/repository-tree";
import {
	checkboxStateOf,
	type SelectionMessage,
	type SelectionRow,
	type SelectionTreeListing,
	translateSelectionMessage,
} from "./lib/selection-row";

/**
 * The repository-sync namespace whose `tree.*` copy (and whose row
 * messages) the tree reads: each feature words its own listing states.
 */
export type RepositorySyncNamespace =
	| "projects.codingInstructions.repositorySync"
	| "projects.contexts.livingMemory.repositorySync";

const CANT_TELL_YET: SelectionMessage = { key: "tree.selection.cantTellYet" };

/**
 * The one checkbox tree both repository-sync configure dialogs choose with
 * (Fizzy #2750 §3): a tick means the item syncs, a ticked folder ticks
 * everything inside it now and later, and a folder partly left out shows a
 * dash. What a row is, and what a click on it does, is the feature
 * adapter's (`row`, `onToggle`); the tree only renders it, over the whole
 * listing whatever the search shows.
 *
 * Search, Select all and Select none come first, so they are reachable from
 * the keyboard before the rows. Every row that cannot be clicked says why
 * under it, and its box points at that reason (`aria-describedby`); a
 * partial box is announced as partially checked.
 *
 * Laziness by expansion is the performance strategy (as in the browsers
 * this replaces, Fizzy #2674, #2725): a folder's children render only while
 * it is expanded, and a search shows at most
 * `REPOSITORY_TREE_SEARCH_MAX_MATCHES` matches. Whatever the listing's
 * outcome, Select all and Select none keep working; the dialog offers typed
 * paths where the tree cannot reach.
 */
export function RepositorySyncSelectionTree({
	namespace,
	listing,
	row,
	onToggle,
	onSelectAll,
	onSelectNone,
	disabled,
	summary,
	notices,
	initiallyOpen,
}: {
	namespace: RepositorySyncNamespace;
	listing: SelectionTreeListing;
	/** The adapter's verdict on one row, over the whole listing. */
	row: (node: RepositoryTreeNode) => SelectionRow;
	/** A click on a row's box: `next` is the state Radix asks for. */
	onToggle: (node: RepositoryTreeNode, next: boolean) => void;
	onSelectAll: () => void;
	onSelectNone: () => void;
	/** A save is in flight: nothing can be changed. */
	disabled: boolean;
	/** The summary line under the tree (`SelectionSummary`). */
	summary: ReactNode;
	/** Feature notices about the rules, shown above the rows. */
	notices?: ReactNode;
	/**
	 * Folders open from the start besides the top level (the way to a stored
	 * selection). Seeded once: a default that followed later clicks would
	 * flip folders the member already toggled.
	 */
	initiallyOpen?: ReadonlySet<string>;
}) {
	const t = useTranslations(namespace);
	const [search, setSearch] = useState("");
	const [openedWith] = useState<ReadonlySet<string>>(
		() => initiallyOpen ?? new Set(),
	);
	// Browse-mode expansion as the folders flipped from their default, so a
	// new listing needs no reset.
	const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
	// Search-mode expansion: every folder open unless collapsed during this
	// query. Kept apart so clearing the search restores `toggled` untouched.
	const [searchCollapsed, setSearchCollapsed] = useState<{
		query: string;
		paths: ReadonlySet<string>;
	}>({ query: "", paths: new Set() });

	const entries = listing.status === "ready" ? listing.entries : undefined;
	const query = search.trim();
	const searching = query !== "";
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

	if (listing.status === "idle") {
		return null;
	}

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

	function toggleExpanded(path: string) {
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

	const context: TreeRowContext = {
		namespace,
		row,
		onToggle,
		disabled,
		isExpanded,
		toggleExpanded,
	};
	const roots = searching ? searchRoots : browseRoots;
	const browsable = entries !== undefined && entries.length > 0;

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex flex-wrap items-center gap-2">
				{browsable ? (
					<SearchInput
						className="min-w-0 flex-1"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder={t("tree.searchPlaceholder")}
						aria-label={t("tree.searchPlaceholder")}
					/>
				) : null}
				<fieldset
					aria-label={t("tree.selectionActions")}
					className="ml-auto flex gap-1.5"
				>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={disabled}
						onClick={onSelectAll}
					>
						{t("tree.selectAll")}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="outline"
						disabled={disabled}
						onClick={onSelectNone}
					>
						{t("tree.selectNone")}
					</Button>
				</fieldset>
			</div>
			{notices}
			{listing.status === "loading" ? (
				<output className="flex items-center gap-2 text-muted-foreground text-xs">
					<Loader2Icon
						className="size-3 animate-spin"
						aria-hidden="true"
					/>
					{t("tree.loading")}
				</output>
			) : null}
			{listing.status === "error" ? (
				<p role="alert" className="text-destructive text-xs">
					{translateSelectionMessage(t, listing.message)}
				</p>
			) : null}
			{listing.status === "unsupported" ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.unsupported")}
				</p>
			) : null}
			{listing.status === "ready" && !browsable ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.empty")}
				</p>
			) : null}
			{listing.status === "ready" && listing.truncated ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.truncated", { max: REPOSITORY_TREE_ENTRY_LIMIT })}
				</p>
			) : null}
			{browsable ? (
				<div className="max-h-72 overflow-y-auto rounded-md border border-input p-2">
					{roots.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							{t("tree.noMatches")}
						</p>
					) : (
						<ul
							aria-label={t("tree.label")}
							className="flex flex-col"
						>
							{roots.map((node) => (
								<TreeRow
									key={node.path}
									node={node}
									depth={0}
									context={context}
								/>
							))}
						</ul>
					)}
				</div>
			) : null}
			{searchResult?.capped ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.refineSearch", {
						max: REPOSITORY_TREE_SEARCH_MAX_MATCHES,
					})}
				</p>
			) : null}
			{summary}
		</div>
	);
}

type TreeRowContext = {
	namespace: RepositorySyncNamespace;
	row: (node: RepositoryTreeNode) => SelectionRow;
	onToggle: (node: RepositoryTreeNode, next: boolean) => void;
	disabled: boolean;
	isExpanded: (path: string, depth: number) => boolean;
	toggleExpanded: (path: string) => void;
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
	const t = useTranslations(context.namespace);
	const id = useId();
	const state = context.row(node);
	const folder = node.type === "dir";
	const expanded = folder && context.isExpanded(node.path, depth);
	const checkboxId = `${id}-checkbox`;
	const helperId = `${id}-helper`;
	const reason =
		state.disabledReason ??
		(state.membership === "unknown" ? CANT_TELL_YET : null);
	const helper = reason ?? state.note ?? null;

	const line = (
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
				aria-describedby={helper ? helperId : undefined}
				checked={checkboxStateOf(state.membership)}
				disabled={context.disabled || reason !== null}
				onCheckedChange={(checked) =>
					context.onToggle(node, checked === true)
				}
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
				className={cn(
					"min-w-0 truncate font-mono text-xs",
					state.membership !== "in" &&
						state.membership !== "mixed" &&
						"text-muted-foreground",
				)}
				title={node.path}
			>
				{node.name}
			</label>
		</div>
	);
	const helperLine = helper ? (
		<p id={helperId} className="pb-0.5 pl-12 text-muted-foreground text-xs">
			{translateSelectionMessage(t, helper)}
		</p>
	) : null;

	if (!folder) {
		return (
			<li>
				{line}
				{helperLine}
			</li>
		);
	}
	return (
		<li>
			<Collapsible
				open={expanded}
				onOpenChange={() => context.toggleExpanded(node.path)}
			>
				{line}
				{helperLine}
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
