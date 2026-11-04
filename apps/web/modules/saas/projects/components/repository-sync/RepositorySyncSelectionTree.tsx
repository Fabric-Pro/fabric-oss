"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { SearchInput } from "@ui/components/search-input";
import { cn } from "@ui/lib";
import {
	ChevronRightIcon,
	ChevronsDownUpIcon,
	FileIcon,
	FolderIcon,
	ListChecksIcon,
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
import {
	selectedOnlyTree,
	type VisibleTreeRow,
	visibleTreeRows,
} from "./lib/tree-view";
import {
	type TreeItemKeyboardProps,
	useTreeKeyboard,
} from "./lib/use-tree-keyboard";

/**
 * The repository-sync namespace whose `tree.*` copy (and whose row
 * messages) the tree reads: each feature words its own listing states.
 */
export type RepositorySyncNamespace =
	| "projects.codingInstructions.repositorySync"
	| "projects.contexts.livingMemory.repositorySync";

const CANT_TELL_YET: SelectionMessage = { key: "tree.selection.cantTellYet" };

const DEFAULT_NOTE_KEYS = {
	unsupported: "tree.unsupported",
	truncated: "tree.truncated",
};

/**
 * The one checkbox tree both repository-sync configure dialogs choose with
 * (Fizzy #2750 §3): a tick means the item syncs, a ticked folder ticks
 * everything inside it now and later, and a folder partly left out shows a
 * dash. What a row is, and what a click on it does, is the feature
 * adapter's (`row`, `onToggle`); the tree only renders it, over the whole
 * listing whatever the search shows.
 *
 * Search, "Show only selected", Collapse all, Select all and Select none
 * come first, so they are reachable from the keyboard before the rows. The
 * rows are a WAI-ARIA tree (`useTreeKeyboard`): one Tab stop, the arrow
 * keys, Home and End to move, Enter to open or close a folder, Space to
 * tick or untick, and type-ahead on names. Each row is the tree item and
 * carries its own checked state (a partial one is announced as partially
 * checked); the box drawn in it is for the pointer only, so the state is
 * announced once. Every row that cannot be clicked says why under it, and
 * the row points at that reason (`aria-describedby`).
 *
 * "Show only selected" keeps the ticked, partial and left-out rows and the
 * folders on the way to them (`selectedOnlyTree`), together with the search
 * when both are on; a ticked folder shows collapsed, since everything in it
 * syncs.
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
	noteKeys = DEFAULT_NOTE_KEYS,
	offerSelectedOnly = true,
}: {
	namespace: RepositorySyncNamespace;
	listing: SelectionTreeListing;
	/** The adapter's verdict on one row, over the whole listing. */
	row: (node: RepositoryTreeNode) => SelectionRow;
	/** A click on a row's box: `next` is the state Radix asks for. */
	onToggle: (node: RepositoryTreeNode, next: boolean) => void;
	/**
	 * Select all and Select none. Omitted by a picker that chooses one folder,
	 * where neither means anything.
	 */
	onSelectAll?: () => void;
	onSelectNone?: () => void;
	/** A save is in flight: nothing can be changed. */
	disabled: boolean;
	/** The summary line under the tree (`SelectionSummary`). */
	summary: ReactNode;
	/** Feature notices about the rules, shown above the rows. */
	notices?: ReactNode;
	/**
	 * Folders open from the start besides the top level (the way to a stored
	 * selection). A path added later (the way to something the dialog could
	 * place only once its listing and rules loaded, Fizzy #2752) opens when
	 * it arrives, once. A path removed later stays as it is: a default that
	 * followed every change would flip folders the member already toggled.
	 */
	initiallyOpen?: ReadonlySet<string>;
	/**
	 * The copy for a provider with no listing and for a truncated one. Both
	 * end by pointing at the typed input, in words about what that input takes
	 * (paths to sync, a folder); a picker whose input takes something else
	 * names its own keys.
	 */
	noteKeys?: { unsupported: string; truncated: string };
	/** Whether "Show only selected" is offered; a one-folder picker has none. */
	offerSelectedOnly?: boolean;
}) {
	const t = useTranslations(namespace);
	const [search, setSearch] = useState("");
	const [selectedOnly, setSelectedOnly] = useState(false);
	const [openedWith, setOpenedWith] = useState<ReadonlySet<string>>(
		() => initiallyOpen ?? new Set(),
	);
	// Browse-mode expansion as the folders flipped from their default, so a
	// new listing needs no reset.
	const [toggled, setToggled] = useState<ReadonlySet<string>>(new Set());
	// Paths that arrived since the last render open now, whatever the member
	// did to them before; later clicks toggle them as usual.
	const arrived = initiallyOpen
		? [...initiallyOpen].filter((path) => !openedWith.has(path))
		: [];
	if (arrived.length > 0) {
		setOpenedWith(new Set([...openedWith, ...arrived]));
		if (arrived.some((path) => toggled.has(path))) {
			setToggled(
				new Set([...toggled].filter((path) => !arrived.includes(path))),
			);
		}
	}

	const entries = listing.status === "ready" ? listing.entries : undefined;
	const query = search.trim();
	const searching = query !== "";
	const narrowed = offerSelectedOnly && selectedOnly;
	// A search or "Show only selected" is a view of its own: folders flipped
	// from that view's default, kept apart so leaving it restores `toggled`.
	const view = narrowed ? `selected\u0000${query}` : searching ? query : "";
	const [viewFlipped, setViewFlipped] = useState<{
		view: string;
		paths: ReadonlySet<string>;
	}>({ view: "", paths: new Set() });
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
	const shownRoots = searching ? searchRoots : browseRoots;
	const roots = useMemo(() => {
		if (!narrowed) {
			return shownRoots;
		}
		const needle = query.toLowerCase();
		return selectedOnlyTree(
			shownRoots,
			row,
			// What the search found, as `searchRepositoryTreeEntries` finds it.
			(node) => node.path.toLowerCase().includes(needle),
		);
	}, [narrowed, shownRoots, row, query]);

	/**
	 * Whether a folder is open before any click in the current view: in
	 * browsing, the top level and the folders asked for; in a search, every
	 * folder; showing only the selection, every folder but a ticked one.
	 */
	function openByDefault(node: RepositoryTreeNode, depth: number): boolean {
		if (view === "") {
			return depth === 0 || openedWith.has(node.path);
		}
		return searching || row(node).membership !== "in";
	}

	function isExpanded(node: RepositoryTreeNode, depth: number): boolean {
		const flipped =
			view === ""
				? toggled.has(node.path)
				: viewFlipped.view === view && viewFlipped.paths.has(node.path);
		return openByDefault(node, depth) !== flipped;
	}

	function toggleExpanded(path: string) {
		if (view !== "") {
			setViewFlipped((prev) => {
				const next = new Set(prev.view === view ? prev.paths : []);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
				}
				return { view, paths: next };
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

	/**
	 * Every folder closed, down to the top-level rows: exactly the folders
	 * open by default are flipped, so a folder opened by a click is closed
	 * too.
	 */
	function collapseAll() {
		if (view !== "") {
			setViewFlipped({
				view,
				paths: new Set(
					foldersWith(roots, 0, openByDefault).map(
						(node) => node.path,
					),
				),
			});
			return;
		}
		setToggled(
			new Set([
				...browseRoots
					.filter((node) => node.type === "dir")
					.map((node) => node.path),
				...openedWith,
			]),
		);
	}

	const rows = visibleTreeRows(roots, isExpanded);
	const isClickable = (state: SelectionRow) =>
		!disabled &&
		state.disabledReason === null &&
		state.membership !== "unknown";
	const keyboardProps = useTreeKeyboard({
		rows,
		toggleExpanded,
		onActivate: ({ node }) => {
			const state = row(node);
			if (isClickable(state)) {
				onToggle(node, checkboxStateOf(state.membership) !== true);
			}
		},
	});

	if (listing.status === "idle") {
		return null;
	}

	const rowByPath = new Map(
		rows.map((visible) => [visible.node.path, visible]),
	);
	const context: TreeRowContext = {
		namespace,
		row,
		onToggle,
		isClickable,
		toggleExpanded,
		visibleRow: (path) => rowByPath.get(path),
		keyboardProps,
	};
	const browsable = entries !== undefined && entries.length > 0;
	// Nothing below the top level shows while every top-level folder is shut.
	const anyExpanded = rows.some((visible) => visible.expanded);

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
				{browsable && offerSelectedOnly ? (
					<Button
						type="button"
						size="sm"
						variant={selectedOnly ? "outline" : "ghost"}
						aria-pressed={selectedOnly}
						onClick={() => setSelectedOnly((prev) => !prev)}
					>
						<ListChecksIcon className="size-4" aria-hidden="true" />
						{t("tree.showSelectedOnly")}
					</Button>
				) : null}
				{browsable ? (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={!anyExpanded}
						onClick={collapseAll}
					>
						<ChevronsDownUpIcon
							className="size-4"
							aria-hidden="true"
						/>
						{t("tree.collapseAll")}
					</Button>
				) : null}
				{onSelectAll && onSelectNone ? (
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
				) : null}
			</div>
			{notices}
			{listing.status === "loading" ? (
				<output className="flex items-center gap-2 text-muted-foreground text-xs">
					<Loader2Icon
						className="size-3 motion-safe:animate-spin"
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
					{t(noteKeys.unsupported)}
				</p>
			) : null}
			{listing.status === "ready" && !browsable ? (
				<p className="text-muted-foreground text-xs">
					{t("tree.empty")}
				</p>
			) : null}
			{listing.status === "ready" && listing.truncated ? (
				<p className="text-muted-foreground text-xs">
					{t(noteKeys.truncated, {
						max: REPOSITORY_TREE_ENTRY_LIMIT,
					})}
				</p>
			) : null}
			{browsable ? (
				<div className="max-h-72 overflow-y-auto rounded-md border border-input p-2">
					{roots.length === 0 ? (
						<p className="text-muted-foreground text-xs">
							{t(
								narrowed && !searching
									? "tree.noneSelected"
									: "tree.noMatches",
							)}
						</p>
					) : (
						<div
							role="tree"
							aria-label={t("tree.label")}
							className="flex flex-col"
						>
							{roots.map((node, index) => (
								<TreeRow
									key={node.path}
									node={node}
									posInSet={index + 1}
									setSize={roots.length}
									context={context}
								/>
							))}
						</div>
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

/** The folders in these trees, at any depth, that pass `test`. */
function foldersWith(
	nodes: readonly RepositoryTreeNode[],
	depth: number,
	test: (node: RepositoryTreeNode, depth: number) => boolean,
): RepositoryTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "dir"
			? [
					...(test(node, depth) ? [node] : []),
					...foldersWith(node.children, depth + 1, test),
				]
			: [],
	);
}

type TreeRowContext = {
	namespace: RepositorySyncNamespace;
	row: (node: RepositoryTreeNode) => SelectionRow;
	onToggle: (node: RepositoryTreeNode, next: boolean) => void;
	isClickable: (state: SelectionRow) => boolean;
	toggleExpanded: (path: string) => void;
	/** The row as on screen: its level, and whether it is open. */
	visibleRow: (path: string) => VisibleTreeRow | undefined;
	keyboardProps: (row: VisibleTreeRow) => TreeItemKeyboardProps;
};

/** The `aria-checked` a membership announces. */
function ariaCheckedOf(state: SelectionRow): boolean | "mixed" {
	const checked = checkboxStateOf(state.membership);
	return checked === "indeterminate" ? "mixed" : checked;
}

function TreeRow({
	node,
	posInSet,
	setSize,
	context,
}: {
	node: RepositoryTreeNode;
	posInSet: number;
	setSize: number;
	context: TreeRowContext;
}) {
	const t = useTranslations(context.namespace);
	const id = useId();
	const visible = context.visibleRow(node.path);
	if (!visible) {
		return null;
	}
	const state = context.row(node);
	const folder = node.type === "dir";
	const expanded = visible.expanded;
	const checkboxId = `${id}-checkbox`;
	const helperId = `${id}-helper`;
	const reason =
		state.disabledReason ??
		(state.membership === "unknown" ? CANT_TELL_YET : null);
	const helper = reason ?? state.note ?? null;
	const clickable = context.isClickable(state);
	const { tabIndex, ...keyboard } = context.keyboardProps(visible);

	return (
		<div
			role="treeitem"
			tabIndex={tabIndex}
			aria-label={node.path}
			aria-level={visible.level}
			aria-setsize={setSize}
			aria-posinset={posInSet}
			aria-expanded={folder ? expanded : undefined}
			aria-checked={ariaCheckedOf(state)}
			aria-disabled={clickable ? undefined : true}
			aria-describedby={helper ? helperId : undefined}
			className="rounded-sm outline-none focus-visible:[&>[data-tree-line]]:ring-2 focus-visible:[&>[data-tree-line]]:ring-ring"
			{...keyboard}
		>
			<div
				data-tree-line=""
				className="flex min-w-0 items-center gap-2 rounded-sm py-0.5"
			>
				{folder ? (
					<button
						type="button"
						tabIndex={-1}
						aria-hidden="true"
						data-tree-toggle=""
						className="rounded-sm text-muted-foreground"
						onClick={() => context.toggleExpanded(node.path)}
					>
						<ChevronRightIcon
							className={cn(
								"size-4 motion-safe:transition-transform",
								expanded && "rotate-90",
							)}
						/>
					</button>
				) : (
					<span className="size-4 shrink-0" aria-hidden="true" />
				)}
				<Checkbox
					id={checkboxId}
					tabIndex={-1}
					aria-hidden="true"
					checked={checkboxStateOf(state.membership)}
					disabled={!clickable}
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
			{helper ? (
				<p
					id={helperId}
					className="pb-0.5 pl-12 text-muted-foreground text-xs"
				>
					{translateSelectionMessage(t, helper)}
				</p>
			) : null}
			{folder && expanded ? (
				// A fieldset is a `group` by its own role: the container of a
				// folder's child items, as a WAI-ARIA tree wants.
				<fieldset className="flex min-w-0 flex-col pl-4">
					{node.children.map((child, index) => (
						<TreeRow
							key={child.path}
							node={child}
							posInSet={index + 1}
							setSize={node.children.length}
							context={context}
						/>
					))}
				</fieldset>
			) : null}
		</div>
	);
}
