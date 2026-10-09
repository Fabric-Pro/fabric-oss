"use client";

import type { ExcludedPath } from "@repo/instructions";
import { Input } from "@ui/components/input";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	EyeIcon,
	EyeOffIcon,
	FileIcon,
	FolderIcon,
	SearchIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { ChangeMark } from "../../lib/instructions-base-changes";

export type TreeFile = {
	path: string;
	kind: string;
	name?: string | null;
	description?: string | null;
};

type Node = {
	name: string;
	path: string;
	children: Map<string, Node>;
	file?: TreeFile;
	/** Set on a row for a file the version left out: shown greyed and never selectable. */
	leftOut?: { rule: string };
	/** The files beneath a folder that the version keeps; left-out rows are not counted. */
	count: number;
	/** A file beneath this folder differs from the base version. */
	changed: boolean;
};

/**
 * Rows are a fixed height so a long tree can be windowed: above
 * `VIRTUALIZE_ABOVE_ROWS` visible rows only the rows in (and just around) the
 * scroll viewport are mounted, so a search that opens every folder of a
 * five-thousand-file repository costs a screenful of DOM, not five thousand
 * buttons.
 */
const ROW_HEIGHT_PX = 24;
const VIRTUALIZE_ABOVE_ROWS = 200;
const OVERSCAN_ROWS = 12;
const FALLBACK_VIEWPORT_PX = 600;

type TreeRow = { node: Node; depth: number };

function emptyNode(name: string, path: string): Node {
	return { name, path, children: new Map(), count: 0, changed: false };
}

/**
 * Whether a left-out path can be given a row without disturbing the files: a
 * path a file (or an earlier left-out row) already holds, or one that would
 * have to pass through a file as if it were a folder, is skipped.
 */
function canPlaceLeftOut(root: Node, segs: string[]): boolean {
	let node = root;
	for (const [i, seg] of segs.entries()) {
		const child = node.children.get(seg);
		if (!child) {
			return true;
		}
		if (i === segs.length - 1 || child.file || child.leftOut) {
			return false;
		}
		node = child;
	}
	return false;
}

function buildTree(
	files: TreeFile[],
	leftOut: readonly ExcludedPath[],
	marks: ReadonlyMap<string, ChangeMark>,
): Node {
	const root = emptyNode("", "");
	for (const f of files) {
		const changed = marks.has(f.path);
		let node = root;
		const segs = f.path.split("/");
		segs.forEach((seg, i) => {
			node.count += 1;
			node.changed ||= changed;
			const path = segs.slice(0, i + 1).join("/");
			let child = node.children.get(seg);
			if (!child) {
				child = emptyNode(seg, path);
				node.children.set(seg, child);
			}
			node = child;
		});
		node.file = f;
		node.count = 1;
	}
	for (const entry of leftOut) {
		const segs = entry.path.split("/");
		if (!canPlaceLeftOut(root, segs)) {
			continue;
		}
		let node = root;
		segs.forEach((seg, i) => {
			const path = segs.slice(0, i + 1).join("/");
			let child = node.children.get(seg);
			if (!child) {
				child = emptyNode(seg, path);
				node.children.set(seg, child);
			}
			node = child;
		});
		node.leftOut = { rule: entry.rule };
		node.count = 1;
	}
	return root;
}

function sortedChildren(n: Node): Node[] {
	return [...n.children.values()].sort(
		(a, b) =>
			(a.file || a.leftOut ? 1 : 0) - (b.file || b.leftOut ? 1 : 0) ||
			a.name.localeCompare(b.name),
	);
}

/** `open` with every folder above `path` added. */
function withAncestors(open: Set<string>, path: string): Set<string> {
	const segs = path.split("/").slice(0, -1);
	const folders = segs.map((_, i) => segs.slice(0, i + 1).join("/"));
	if (folders.every((folder) => open.has(folder))) {
		return open;
	}
	return new Set([...open, ...folders]);
}

/**
 * Renders the published snapshot's files exactly as they sit on disk —
 * folders collapsed by default, opened by click or by a search match, and
 * opened down to the selected file whichever way it was chosen. The search
 * box filters by path, name, and description at once so a skill's frontmatter
 * description is as searchable as its filename.
 *
 * `changes` marks what the published version changed from the version it was
 * edited from: `A` and `M` on files, a dot on a closed folder that holds any.
 * `leftOut` lists the files the version left out as greyed rows, on request.
 */
export function InstructionsTree({
	files,
	selectedPath,
	onSelect,
	changes,
	leftOut,
}: {
	files: TreeFile[];
	selectedPath: string | null;
	onSelect: (path: string) => void;
	changes?: {
		baseVersion: number;
		marks: ReadonlyMap<string, ChangeMark>;
	};
	leftOut?: {
		files: readonly ExcludedPath[];
		shown: boolean;
		onToggle: () => void;
	};
}) {
	const t = useTranslations("projects.codingInstructions.tree");
	// Reuses `fileView.kindLabels` rather than a second copy of the same
	// kind → label map under a new namespace.
	const kindLabels = useTranslations(
		"projects.codingInstructions.fileView",
	).raw("kindLabels") as Record<string, string>;
	const marks = changes?.marks;
	const [query, setQuery] = useState("");
	const [kindFilter, setKindFilter] = useState<string | null>(null);
	const [open, setOpen] = useState<Set<string>>(() => new Set());
	// The selection a reveal was last made for. Adjusted during render, not in
	// an effect: the folders above a newly selected file open in the same
	// render the file turns selected in, and a folder closed afterwards stays
	// closed until the selection changes again.
	const [revealed, setRevealed] = useState<string | null>(null);
	if (selectedPath !== revealed) {
		setRevealed(selectedPath);
		if (selectedPath?.includes("/")) {
			setOpen((previous) => withAncestors(previous, selectedPath));
		}
	}
	// While a search or kind filter is on, every folder with a match is open
	// unless it was closed during THAT search. Kept apart from `open` so
	// clearing the search gives back the folders as the person left them.
	const [searchCollapsed, setSearchCollapsed] = useState<{
		key: string;
		paths: ReadonlySet<string>;
	}>({ key: "", paths: new Set() });
	const kindCounts = useMemo(() => {
		const counts = new Map<string, number>();
		for (const f of files) {
			counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
		}
		return counts;
	}, [files]);
	const kindsPresent = useMemo(
		() => [...kindCounts.keys()].sort(),
		[kindCounts],
	);
	const hasMarks = useMemo(
		() => (marks ? files.some((f) => marks.has(f.path)) : false),
		[files, marks],
	);
	const visible = useMemo(() => {
		const q = query.trim().toLowerCase();
		return files.filter((f) => {
			if (kindFilter && f.kind !== kindFilter) {
				return false;
			}
			if (!q) {
				return true;
			}
			return (
				f.path.toLowerCase().includes(q) ||
				f.name?.toLowerCase().includes(q) ||
				f.description?.toLowerCase().includes(q)
			);
		});
	}, [files, query, kindFilter]);
	const leftOutFiles = leftOut?.files;
	// A left-out file has no kind, name or description: it answers only the
	// path of a text search, and no kind filter.
	const visibleLeftOut = useMemo(() => {
		if (!leftOut?.shown || !leftOutFiles || kindFilter) {
			return [];
		}
		const q = query.trim().toLowerCase();
		return leftOutFiles.filter(
			(f) => !q || f.path.toLowerCase().includes(q),
		);
	}, [leftOut?.shown, leftOutFiles, kindFilter, query]);
	const tree = useMemo(
		() => buildTree(visible, visibleLeftOut, marks ?? new Map()),
		[visible, visibleLeftOut, marks],
	);
	// A kind filter narrows the tree the same way a text search does, so both
	// auto-expand every folder that still has a match rather than requiring
	// the user to also click open every ancestor folder by hand.
	const searching = query.trim().length > 0 || kindFilter !== null;
	const searchKey = `${query.trim()}\u0000${kindFilter ?? ""}`;
	const noMatches =
		searching && visible.length === 0 && visibleLeftOut.length === 0;

	const toggle = (path: string) => {
		if (searching) {
			setSearchCollapsed((prev) => {
				const next = new Set(prev.key === searchKey ? prev.paths : []);
				if (next.has(path)) {
					next.delete(path);
				} else {
					next.add(path);
				}
				return { key: searchKey, paths: next };
			});
			return;
		}
		setOpen((s) => {
			const n = new Set(s);
			if (n.has(path)) {
				n.delete(path);
			} else {
				n.add(path);
			}
			return n;
		});
	};

	const isOpen = (node: Node): boolean =>
		searching
			? !(
					searchCollapsed.key === searchKey &&
					searchCollapsed.paths.has(node.path)
				)
			: open.has(node.path);

	const rows = useMemo(() => {
		const out: TreeRow[] = [];
		const walk = (node: Node, depth: number) => {
			out.push({ node, depth });
			if (!node.file && !node.leftOut && isOpen(node)) {
				for (const child of sortedChildren(node)) {
					walk(child, depth + 1);
				}
			}
		};
		for (const child of sortedChildren(tree)) {
			walk(child, 0);
		}
		return out;
	}, [tree, searching, searchKey, searchCollapsed, open]);

	const scrollRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState({
		top: 0,
		height: FALLBACK_VIEWPORT_PX,
	});
	useEffect(() => {
		const element = scrollRef.current;
		if (!element || typeof ResizeObserver === "undefined") {
			return;
		}
		const observer = new ResizeObserver(() =>
			setViewport((previous) => ({
				...previous,
				height: element.clientHeight || FALLBACK_VIEWPORT_PX,
			})),
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const windowed = rows.length > VIRTUALIZE_ABOVE_ROWS;
	const first = windowed
		? Math.max(0, Math.floor(viewport.top / ROW_HEIGHT_PX) - OVERSCAN_ROWS)
		: 0;
	const last = windowed
		? Math.min(
				rows.length,
				Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT_PX) +
					OVERSCAN_ROWS,
			)
		: rows.length;

	// The rows that stay mounted wherever the window is: the selected row and
	// the one holding keyboard focus, so neither is lost to a scroll.
	const [focusedPath, setFocusedPath] = useState<string | null>(null);
	// Arrow keys move focus from row to row, and only one row is a tab stop
	// (the one last focused, else the selected one, else the first), so Tab
	// crosses the tree in one step instead of once per file. A row outside the
	// window is scrolled to and mounted first; the focus lands once it is there.
	const [pendingFocus, setPendingFocus] = useState<string | null>(null);
	const focusableRows = useMemo(
		() => rows.filter((row) => !row.node.leftOut),
		[rows],
	);
	const tabStopPath =
		[focusedPath, selectedPath].find((path) =>
			focusableRows.some((row) => row.node.path === path),
		) ??
		focusableRows[0]?.node.path ??
		null;
	const rowElement = (path: string): HTMLElement | null =>
		[
			...(scrollRef.current?.querySelectorAll<HTMLElement>(
				"[data-tree-path]",
			) ?? []),
		].find((element) => element.dataset.treePath === path) ?? null;
	// Re-runs when the window moves, so a row the scroll has just mounted gets
	// its focus.
	useEffect(() => {
		if (pendingFocus === null) {
			return;
		}
		const element = rowElement(pendingFocus);
		if (element) {
			element.focus();
			setPendingFocus(null);
		}
	}, [pendingFocus, viewport.top, rows]);
	const focusRow = (path: string) => {
		setFocusedPath(path);
		setPendingFocus(path);
		if (windowed && !rowElement(path)) {
			const top =
				rows.findIndex((row) => row.node.path === path) * ROW_HEIGHT_PX;
			if (scrollRef.current) {
				scrollRef.current.scrollTop = top;
			}
			setViewport((previous) => ({ ...previous, top }));
		}
	};
	const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const path =
			event.target instanceof HTMLElement
				? event.target.dataset.treePath
				: undefined;
		if (
			path === undefined ||
			event.altKey ||
			event.ctrlKey ||
			event.metaKey
		) {
			return;
		}
		const index = focusableRows.findIndex((row) => row.node.path === path);
		const row = focusableRows[index];
		if (!row) {
			return;
		}
		const isFolder = !row.node.file;
		let next: TreeRow | undefined;
		switch (event.key) {
			case "ArrowDown":
				next = focusableRows[index + 1];
				break;
			case "ArrowUp":
				next = focusableRows[index - 1];
				break;
			case "Home":
				next = focusableRows[0];
				break;
			case "End":
				next = focusableRows.at(-1);
				break;
			case "ArrowRight":
				if (!isFolder) {
					return;
				}
				if (!isOpen(row.node)) {
					event.preventDefault();
					toggle(row.node.path);
					return;
				}
				next = focusableRows[index + 1];
				if (next && next.depth <= row.depth) {
					next = undefined;
				}
				break;
			case "ArrowLeft":
				if (isFolder && isOpen(row.node)) {
					event.preventDefault();
					toggle(row.node.path);
					return;
				}
				next = focusableRows
					.slice(0, index)
					.findLast((candidate) => candidate.depth < row.depth);
				break;
			default:
				return;
		}
		event.preventDefault();
		if (next) {
			focusRow(next.node.path);
		}
	};
	const pinned = windowed
		? rows.flatMap((row, index) =>
				(row.node.path === selectedPath ||
					row.node.path === focusedPath) &&
				(index < first || index >= last)
					? [index]
					: [],
			)
		: [];
	const visibleIndexes = windowed
		? [
				...new Set([
					...pinned,
					...Array.from(
						{ length: last - first },
						(_, i) => first + i,
					),
				]),
			].sort((a, b) => a - b)
		: [];

	const renderRow = (
		{ node, depth }: TreeRow,
		index: number,
	): React.ReactNode => {
		const position: React.CSSProperties = windowed
			? {
					position: "absolute",
					top: index * ROW_HEIGHT_PX,
					left: 0,
					right: 0,
				}
			: {};
		// Depth is unbounded (a tree can nest arbitrarily deep), so no fixed
		// Tailwind spacing scale can cover every level — the indent has to be
		// computed, not a class.
		if (node.leftOut) {
			return (
				<div
					key={node.path}
					title={t("leftOutTitle", { rule: node.leftOut.rule })}
					className="flex w-full shrink-0 items-center gap-1.5 rounded-md px-2.5 font-mono text-foreground/40 text-xs"
					style={{
						...position,
						height: ROW_HEIGHT_PX,
						paddingLeft: `${10 + depth * 16 + 17}px`,
					}}
				>
					<FileIcon
						className="size-3.5 shrink-0"
						aria-hidden="true"
					/>
					<span className="truncate">{node.name}</span>
					<span className="ml-auto shrink-0 pl-2 text-[10.5px] text-muted-foreground">
						{t("leftOutTag", { rule: node.leftOut.rule })}
					</span>
				</div>
			);
		}
		if (node.file) {
			const active = node.path === selectedPath;
			const mark = marks?.get(node.path);
			const markTitle =
				mark && changes
					? t(mark === "added" ? "addedTitle" : "changedTitle", {
							version: changes.baseVersion,
						})
					: undefined;
			return (
				<button
					key={node.path}
					type="button"
					data-tree-path={node.path}
					onClick={() => onSelect(node.path)}
					aria-current={active ? "true" : undefined}
					tabIndex={node.path === tabStopPath ? 0 : -1}
					className={cn(
						"flex w-full shrink-0 items-center gap-1.5 rounded-md px-2.5 text-left font-mono text-xs",
						active
							? "bg-primary/10 font-medium text-primary shadow-[inset_2px_0_0_var(--primary)]"
							: "hover:bg-accent",
					)}
					style={{
						...position,
						height: ROW_HEIGHT_PX,
						paddingLeft: `${10 + depth * 16 + 17}px`,
					}}
				>
					<FileIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
					<span className="truncate">{node.name}</span>
					{mark ? (
						<span
							title={markTitle}
							className={`ml-auto w-3 shrink-0 text-center font-medium ${mark === "added" ? "text-success" : "text-highlight-ink"}`}
						>
							<span aria-hidden="true">
								{t(
									mark === "added"
										? "markAdded"
										: "markChanged",
								)}
							</span>
							<span className="sr-only">{markTitle}</span>
						</span>
					) : null}
				</button>
			);
		}
		const folderOpen = isOpen(node);
		const changesTitle =
			changes && node.changed && !folderOpen
				? t("folderChangesTitle", { version: changes.baseVersion })
				: null;
		return (
			<button
				key={node.path}
				type="button"
				data-tree-path={node.path}
				onClick={() => toggle(node.path)}
				aria-expanded={folderOpen}
				tabIndex={node.path === tabStopPath ? 0 : -1}
				className="flex w-full shrink-0 items-center gap-1.5 rounded-md px-2.5 text-left font-mono text-xs hover:bg-accent"
				style={{
					...position,
					height: ROW_HEIGHT_PX,
					paddingLeft: `${10 + depth * 16}px`,
				}}
			>
				{folderOpen ? (
					<ChevronDownIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
				) : (
					<ChevronRightIcon
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden="true"
					/>
				)}
				<FolderIcon
					className="size-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
				{/* A folder that holds only left-out files reads like them. */}
				<span
					className={cn(
						"truncate",
						node.count === 0 && "text-muted-foreground",
					)}
				>
					{node.name}
				</span>
				{node.count > 0 ? (
					<span className="ml-auto text-muted-foreground">
						{node.count}
					</span>
				) : null}
				{changesTitle ? (
					<span
						role="img"
						aria-label={changesTitle}
						title={changesTitle}
						className="size-1.5 shrink-0 rounded-full bg-highlight"
					/>
				) : null}
			</button>
		);
	};

	const leftOutToggle =
		leftOut && leftOut.files.length > 0 ? leftOut : undefined;

	return (
		<div
			data-testid="instructions-tree-panel"
			// The tour anchor sits on the panel, not its column: the column
			// stretches to the file view's height (the room the panel sticks
			// in), so a spotlight on it framed empty space below the tree.
			data-onboarding-target="coding-instructions-tree"
			// svh, not dvh: a dvh cap follows the mobile address bar and would
			// push the file view below up and down as the bar collapses.
			className="flex max-h-[60svh] min-h-0 flex-col rounded-lg border border-border lg:sticky lg:top-4 lg:max-h-[calc(100svh-8rem)]"
		>
			<div className="flex flex-col gap-2 border-border border-b p-2.5">
				{/* Visual grouping only — the input below carries its own
				`aria-label`, so a `<label>` wrapper here would just be a
				second, unassociated label for the same control. */}
				<div className="flex h-9 items-center gap-2 rounded-md border border-input px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
					<SearchIcon className="size-4" aria-hidden="true" />
					<Input
						type="search"
						aria-label={t("searchLabel")}
						placeholder={t("searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						className="h-auto border-0 p-0 shadow-none focus-visible:ring-0"
					/>
				</div>
				{kindsPresent.length > 1 ? (
					/* Named by a visually-hidden <legend>, not `aria-label`:
					   both are valid accessible names for a <fieldset>, but
					   the repo already has this exact chip-group shape in
					   `qa-settings/QaCiSetupSection.tsx` and it uses a
					   <legend>. One pattern for one UI shape. */
					<fieldset className="flex flex-wrap gap-1.5 border-0 p-0 m-0">
						<legend className="sr-only">
							{t("kindFilterLabel")}
						</legend>
						<button
							type="button"
							aria-pressed={kindFilter === null}
							onClick={() => setKindFilter(null)}
							className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs ${kindFilter === null ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
						>
							{t("allKinds")}
							<span className="font-mono opacity-70">
								{files.length}
							</span>
						</button>
						{kindsPresent.map((kind) => (
							<button
								key={kind}
								type="button"
								aria-pressed={kindFilter === kind}
								onClick={() => setKindFilter(kind)}
								className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium text-xs ${kindFilter === kind ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent"}`}
							>
								{kindLabels[kind] ?? kind}
								<span className="font-mono opacity-70">
									{kindCounts.get(kind)}
								</span>
							</button>
						))}
					</fieldset>
				) : null}
			</div>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: focus bubbles up from the row buttons */}
			<div
				ref={scrollRef}
				onScroll={(event) => {
					const top = event.currentTarget.scrollTop;
					setViewport((previous) => ({ ...previous, top }));
				}}
				onKeyDown={onTreeKeyDown}
				onFocus={(event) =>
					setFocusedPath(
						event.target instanceof HTMLElement
							? (event.target.dataset.treePath ?? null)
							: null,
					)
				}
				className="flex min-h-0 flex-1 flex-col overflow-auto p-2"
			>
				{windowed ? (
					<div
						className="relative shrink-0"
						style={{ height: rows.length * ROW_HEIGHT_PX }}
					>
						{visibleIndexes.map((index) => {
							const row = rows[index];
							return row ? renderRow(row, index) : null;
						})}
					</div>
				) : (
					rows.map(renderRow)
				)}
				{/* Always mounted, so the change from results to none is
				    announced: a live region inserted already holding its text
				    is often missed. */}
				<output
					className={
						noMatches
							? "block px-2.5 py-1 text-muted-foreground text-xs"
							: "sr-only"
					}
				>
					{noMatches ? t("noMatches") : null}
				</output>
			</div>
			{leftOutToggle || hasMarks ? (
				<div className="flex items-center justify-between gap-3 border-border border-t px-3 py-2 text-xs">
					{leftOutToggle ? (
						<button
							type="button"
							aria-pressed={leftOutToggle.shown}
							onClick={leftOutToggle.onToggle}
							className="inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
						>
							{leftOutToggle.shown ? (
								<EyeOffIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							) : (
								<EyeIcon
									className="size-3.5"
									aria-hidden="true"
								/>
							)}
							{leftOutToggle.shown
								? t("hideLeftOut")
								: t("showLeftOut", {
										count: leftOutToggle.files.length,
									})}
						</button>
					) : (
						<span />
					)}
					{hasMarks ? (
						<span
							data-testid="instructions-tree-legend"
							className="font-mono text-[10.5px] text-muted-foreground"
						>
							<span className="font-medium text-success">
								{t("markAdded")}
							</span>{" "}
							{t("legendAdded")}{" "}
							<span className="ml-2 font-medium text-highlight-ink">
								{t("markChanged")}
							</span>{" "}
							{t("legendChanged")}
						</span>
					) : null}
				</div>
			) : null}
		</div>
	);
}
