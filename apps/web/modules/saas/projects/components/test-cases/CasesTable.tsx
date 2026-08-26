"use client";

import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ArrowDownIcon,
	ArrowUpIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	ClipboardCheckIcon,
	PlusIcon,
	SearchXIcon,
	SparklesIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
	CASES_COL_COVERS,
	CASES_COL_LASTRUN,
	CASES_GRID_COLS,
	PAGE_GAP,
	pageCount,
	pageRange,
	paginationPages,
} from "./cases-table";
import type { SortDirection, SortKey } from "./constants";
import { PAGE_SIZES, type PageSize } from "./use-test-cases-view";

/**
 * Column headers, in template order. A `sort` key makes the header a button:
 * the four sorts the server supports are exactly the four columns worth
 * ordering by, so exposing them here removes a trip to the toolbar's sort menu
 * for the common case. The rest are labels, and the two icon-only columns
 * (owner, actions) carry their name for screen readers only.
 */
const COLUMNS: {
	id: string;
	labelKey: string;
	sort?: SortKey;
	srOnly?: boolean;
	/** What each column means — the header explains itself on hover/focus. */
	hintKey?: string;
	/** Container-query visibility, shared with the row so they can't diverge. */
	visibility?: string;
}[] = [
	{ id: "select", labelKey: "columns.select", srOnly: true },
	{ id: "identifier", labelKey: "columns.id", hintKey: "columns.idHint" },
	{
		id: "title",
		labelKey: "columns.testCase",
		sort: "title",
		hintKey: "columns.testCaseHint",
	},
	{
		id: "covers",
		labelKey: "columns.covers",
		hintKey: "columns.coversHint",
		visibility: CASES_COL_COVERS,
	},
	{ id: "result", labelKey: "columns.result", hintKey: "columns.resultHint" },
	{ id: "state", labelKey: "columns.state", hintKey: "columns.stateHint" },
	{
		id: "priority",
		labelKey: "columns.priority",
		sort: "priority",
		hintKey: "columns.priorityHint",
	},
	{ id: "owner", labelKey: "columns.owner", srOnly: true },
	{
		id: "lastRun",
		labelKey: "columns.lastRun",
		sort: "recentRun",
		hintKey: "columns.lastRunHint",
		visibility: CASES_COL_LASTRUN,
	},
	{ id: "actions", labelKey: "columns.actions", srOnly: true },
];

type HeaderProps = {
	/** Distance from the viewport top the sticky page head occupies. */
	stickyTop: number;
	selectable: boolean;
	allSelected: boolean;
	someSelected: boolean;
	onToggleAll: (checked: boolean) => void;
	sort: SortKey;
	direction: SortDirection;
	onSort: (key: SortKey) => void;
	onToggleDirection: () => void;
	/**
	 * Columns the reader switched off. The row takes the SAME predicate, so a
	 * column cannot be hidden from one and kept in the other — which would slide
	 * every value after it under the wrong heading.
	 */
	isHidden?: (column: string) => boolean;
	compact?: boolean;
};

export function CasesTableHeader({
	stickyTop,
	selectable,
	allSelected,
	someSelected,
	onToggleAll,
	sort,
	direction,
	onSort,
	onToggleDirection,
	isHidden,
	compact = false,
}: HeaderProps) {
	const t = useTranslations("projects.testCases");
	// Wins over the container-query tier: a column switched off must not come
	// back when the window widens.
	const hidden = (column: string) =>
		isHidden?.(column) ? "!hidden" : undefined;

	return (
		<div
			// Pins under the measured page head, so the reader always knows which
			// column they are reading however far down the table they are. This
			// only works while no ancestor between here and the document is a
			// scroll container — see the note in `cases-table.ts` about
			// `overflow-x` silently capturing sticky descendants.
			style={{ top: stickyTop }}
			className={cn(
				"sticky z-20 hidden rounded-t-xl border-border border-b px-3 @[670px]:grid @[670px]:gap-x-2",
				// OPAQUE. `bg-muted/55` let every row scroll straight through the
				// header — two sets of text drawn over each other, which is what
				// the table looked "corrupted" by. A sticky bar has to actually
				// cover what passes under it.
				"bg-muted",
				CASES_GRID_COLS,
				"items-center font-semibold text-[11px] text-muted-foreground uppercase tracking-[0.08em]",
				compact ? "h-[30px]" : "h-[38px]",
			)}
		>
			{COLUMNS.map((col) => {
				if (col.id === "select") {
					return (
						<span key={col.id} className="flex items-center gap-1">
							<span className="w-5" />
							{selectable && (
								<Checkbox
									checked={
										allSelected
											? true
											: someSelected
												? "indeterminate"
												: false
									}
									onCheckedChange={(c) =>
										onToggleAll(c === true)
									}
									aria-label={t("bulk.selectAllAria")}
								/>
							)}
						</span>
					);
				}

				const label = t(col.labelKey);
				if (!col.sort) {
					const plain = (
						<span
							className={cn("truncate", col.srOnly && "sr-only")}
						>
							{label}
						</span>
					);
					// Screen-reader-only headings have nothing to hover.
					if (col.srOnly || !col.hintKey) {
						return (
							<span
								key={col.id}
								className={cn(
									"flex min-w-0 items-center",
									col.visibility,
									hidden(col.id),
								)}
							>
								{plain}
							</span>
						);
					}
					return (
						<span
							key={col.id}
							className={cn(
								"flex min-w-0 items-center",
								col.visibility,
								hidden(col.id),
							)}
						>
							<Tooltip>
								<TooltipTrigger asChild>
									<span className="min-w-0 cursor-help truncate border-b border-dotted border-muted-foreground/40">
										{label}
									</span>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{t(col.hintKey)}
								</TooltipContent>
							</Tooltip>
						</span>
					);
				}

				const active = sort === col.sort;
				const sortButton = (
					<button
						type="button"
						onClick={() =>
							active
								? onToggleDirection()
								: onSort(col.sort as SortKey)
						}
						aria-label={t(
							active
								? direction === "asc"
									? "columns.sortedAscAria"
									: "columns.sortedDescAria"
								: "columns.sortByAria",
							{ column: label },
						)}
						className={cn(
							"inline-flex min-w-0 items-center gap-1 rounded text-left uppercase tracking-[0.08em] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
							active && "text-foreground",
						)}
					>
						<span className="truncate">{label}</span>
						{active &&
							(direction === "asc" ? (
								<ArrowUpIcon
									aria-hidden="true"
									className="size-3 shrink-0"
								/>
							) : (
								<ArrowDownIcon
									aria-hidden="true"
									className="size-3 shrink-0"
								/>
							))}
					</button>
				);

				return (
					<span
						key={col.id}
						className={cn(
							"flex min-w-0 items-center",
							col.visibility,
							hidden(col.id),
						)}
					>
						{col.hintKey ? (
							<Tooltip>
								<TooltipTrigger asChild>
									{sortButton}
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{t(col.hintKey)}
									<span className="mt-1 block text-muted-foreground">
										{t("columns.sortHint")}
									</span>
								</TooltipContent>
							</Tooltip>
						) : (
							sortButton
						)}
					</span>
				);
			})}
		</div>
	);
}

/** Shimmering placeholder rows, at the real row height so nothing jumps. */
export function CasesTableSkeleton({ rows = 8 }: { rows?: number }) {
	const t = useTranslations("projects.testCases");
	const widths = ["62%", "48%", "71%", "55%", "66%", "42%", "58%", "50%"];
	return (
		// `<output>` and not a bare div: an aria-label on an element with no role
		// is dropped, so the skeleton announced nothing at all — the one moment a
		// screen-reader user has no other signal that anything is happening.
		// `<output>` carries role="status" natively and is polite, so it does not
		// interrupt whatever is being read.
		<output
			aria-busy="true"
			aria-label={t("loadingCases")}
			className="block"
		>
			{Array.from({ length: rows }, (_, i) => (
				<div
					key={widths[i % widths.length] + String(i)}
					className="flex h-[46px] items-center gap-3 border-border/55 border-b px-3 last:border-b-0"
				>
					<span className="h-3 w-5 rounded bg-muted motion-safe:animate-pulse" />
					<span className="h-3 w-12 rounded bg-muted motion-safe:animate-pulse" />
					<span
						className="h-3 rounded bg-muted motion-safe:animate-pulse"
						style={{ width: widths[i % widths.length] }}
					/>
					<span className="ml-auto h-4 w-16 rounded-full bg-muted motion-safe:animate-pulse" />
				</div>
			))}
		</output>
	);
}

/**
 * Nothing here at all — a genuinely empty project, which is a different problem
 * from a filter that matched nothing and therefore gets different copy and
 * different buttons.
 */
export function CasesEmpty({
	canEdit,
	onCreate,
	onDraft,
	onImport,
}: {
	canEdit: boolean;
	onCreate: () => void;
	onDraft: () => void;
	onImport?: () => void;
}) {
	const t = useTranslations("projects.testCases");
	return (
		<div className="flex flex-col items-center gap-2.5 px-6 py-16 text-center">
			<span className="inline-flex size-13 items-center justify-center rounded-2xl border bg-muted p-3">
				<ClipboardCheckIcon
					aria-hidden="true"
					className="size-6 text-muted-foreground"
				/>
			</span>
			<h3 className="font-serif text-xl font-normal">
				{t("empty.cases")}
			</h3>
			<p className="max-w-lg text-muted-foreground text-sm leading-relaxed">
				{t("empty.casesHint")}
			</p>
			{canEdit && (
				<div className="mt-1.5 flex flex-wrap justify-center gap-2">
					<Button onClick={onDraft}>
						<SparklesIcon
							aria-hidden="true"
							className="mr-2 size-4"
						/>
						{t("empty.draftFromFeature")}
					</Button>
					<Button variant="outline" onClick={onCreate}>
						<PlusIcon aria-hidden="true" className="mr-2 size-4" />
						{t("actions.new")}
					</Button>
					{onImport && (
						<Button variant="outline" onClick={onImport}>
							{t("actions.importFromPm")}
						</Button>
					)}
				</div>
			)}
		</div>
	);
}

/**
 * Filtered to nothing. Distinct from empty, and — crucially — shows the way
 * back: each active filter is offered for removal individually, because the
 * reader usually wants to loosen one, not throw away the four they set.
 */
export function CasesNoMatches({
	totalInProject,
	activeFilters,
	onClearAll,
}: {
	totalInProject: number;
	activeFilters: { id: string; label: string; onRemove: () => void }[];
	onClearAll: () => void;
}) {
	const t = useTranslations("projects.testCases");
	return (
		<div className="flex flex-col items-center gap-2.5 px-6 py-14 text-center">
			<span className="inline-flex size-11 items-center justify-center rounded-xl border bg-muted p-2.5">
				<SearchXIcon
					aria-hidden="true"
					className="size-5 text-muted-foreground"
				/>
			</span>
			<h3 className="font-medium text-base">
				{t("empty.casesFiltered")}
			</h3>
			{totalInProject > 0 && (
				<p className="text-muted-foreground text-sm">
					{t("empty.casesFilteredHint", { total: totalInProject })}
				</p>
			)}
			{activeFilters.length > 0 && (
				<div className="mt-0.5 flex flex-wrap justify-center gap-1.5">
					{activeFilters.map((f) => (
						<Button
							key={f.id}
							type="button"
							variant="outline"
							size="sm"
							className="h-7 rounded-full text-xs"
							onClick={f.onRemove}
						>
							{t("filters.removeOne", { filter: f.label })}
						</Button>
					))}
				</div>
			)}
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="mt-1.5"
				onClick={onClearAll}
			>
				{t("filters.clearAll")}
			</Button>
		</div>
	);
}

type PaginationProps = {
	page: number;
	pageSize: PageSize;
	total: number;
	/** Extra context for this page, e.g. "6 failing, 2 blocked". */
	note?: ReactNode;
	onPage: (page: number) => void;
	onPageSize: (size: PageSize) => void;
};

/**
 * The table's footer. Always answers "where am I in what" — a list that only
 * offers "Load more" can say how many rows are on screen but never where they
 * sit in the whole, so a reader has no way to reach the end or to come back to
 * the same place tomorrow.
 */
export function CasesPagination({
	page,
	pageSize,
	total,
	note,
	onPage,
	onPageSize,
}: PaginationProps) {
	const t = useTranslations("projects.testCases");
	const pages = pageCount(total, pageSize);
	const range = pageRange(page, pageSize, total);
	const tokens = paginationPages(page, pages);

	return (
		<nav
			data-onboarding-target="test-cases-pagination"
			aria-label={t("pagination.aria")}
			className="flex flex-wrap items-center justify-between gap-3 border-border border-t bg-muted/45 px-3 py-2.5"
		>
			<p className="text-muted-foreground text-xs tabular-nums">
				{range
					? t("pagination.range", {
							from: range.from,
							to: range.to,
							total,
						})
					: t("pagination.none")}
				{note && (
					<>
						{" · "}
						{note}
					</>
				)}
			</p>

			<div className="flex flex-wrap items-center gap-3">
				{/* A span, not a label: Radix's trigger is a button, and a button
				    is not a labelable element — the <label> wrapped it without
				    naming it, so the visible "Rows" text was decoration and the
				    trigger's own aria-label was doing all the work. */}
				<span className="inline-flex items-center gap-2 text-muted-foreground text-xs">
					{t("pagination.rows")}
					<Select
						value={String(pageSize)}
						onValueChange={(v) => onPageSize(Number(v) as PageSize)}
					>
						<SelectTrigger
							className="h-7 w-[4.5rem]"
							aria-label={t("pagination.rowsAria")}
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{PAGE_SIZES.map((size) => (
								<SelectItem key={size} value={String(size)}>
									{size}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</span>

				{pages > 1 && (
					<div className="flex items-center gap-1">
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							className="size-7"
							disabled={page <= 1}
							onClick={() => onPage(page - 1)}
							aria-label={t("pagination.previous")}
						>
							<ChevronLeftIcon
								aria-hidden="true"
								className="size-3.5"
							/>
						</Button>
						{tokens.map((token, i) =>
							token === PAGE_GAP ? (
								<span
									// Position is the only identity a gap has.
									key={`gap-${i}`}
									aria-hidden="true"
									className="px-1 text-muted-foreground text-xs"
								>
									…
								</span>
							) : (
								<Button
									key={token}
									type="button"
									variant={
										token === page ? "primary" : "outline"
									}
									size="sm"
									className="h-7 min-w-7 px-2 text-xs tabular-nums"
									aria-label={t("pagination.goToPage", {
										page: token,
									})}
									aria-current={
										token === page ? "page" : undefined
									}
									onClick={() => onPage(token)}
								>
									{token}
								</Button>
							),
						)}
						<Button
							type="button"
							variant="outline"
							size="icon-sm"
							className="size-7"
							disabled={page >= pages}
							onClick={() => onPage(page + 1)}
							aria-label={t("pagination.next")}
						>
							<ChevronRightIcon
								aria-hidden="true"
								className="size-3.5"
							/>
						</Button>
					</div>
				)}
			</div>
		</nav>
	);
}
