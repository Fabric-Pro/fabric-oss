"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { SearchInput } from "@ui/components/search-input";
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
	PlusIcon,
	SearchIcon,
	TagIcon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useDebounceValue } from "usehooks-ts";
import {
	AUTOMATION_I18N_KEY,
	AUTOMATION_STATUSES,
	PRIORITY_I18N_KEY,
	RESULT_I18N_KEY,
	SORT_I18N_KEY,
	SORT_KEYS,
	type SortKey,
	STATE_I18N_KEY,
	TEST_CASE_PRIORITIES,
	TEST_CASE_STATES,
	TEST_RESULTS,
	type TestCaseState,
} from "./constants";
import { FeaturePicker } from "./FeaturePicker";
import { FilterChip } from "./FilterChip";
import {
	addableFilters,
	type BuildableFilter,
	FILTER_LABEL_KEY,
	visibleFilters,
} from "./filter-builder";

/**
 * The cases search runs SERVER-side, and its value is part of the list query's
 * predicate — so every keystroke used to fire a request AND, because the
 * predicate changed, clear the reader's bulk selection. Ticking thirty cases and
 * then typing one character silently discarded all thirty. Matches the 300ms the
 * feature-coverage list already uses for the same reason.
 */
const SEARCH_DEBOUNCE_MS = 300;

import { useFeatureOptions } from "./use-feature-options";
import { ALL, type useTestCasesView } from "./use-test-cases-view";

/** The view state the toolbar edits — owned by `useTestCasesView`. */
type TestCasesView = ReturnType<typeof useTestCasesView>;

type Props = {
	view: TestCasesView;
	projectId: string;
	organizationId: string | null;
	stateCounts: Record<TestCaseState, number>;
	totalAllStates: number;
	/** Rows currently loaded, and how many match server-side. */
	shown: number;
	total: number;
};

export function CasesToolbar({
	view,
	projectId,
	organizationId,
	stateCounts,
	totalAllStates,
	shown,
	total,
}: Props) {
	const t = useTranslations("projects.testCases");
	const { filters, setFilter } = view;

	// The field stays fully responsive; only the PREDICATE waits.
	const [searchDraft, setSearchDraft] = useState(filters.search);
	const searchRef = useRef<HTMLInputElement>(null);

	/**
	 * ⌘K / Ctrl-K focuses the search.
	 *
	 * Scoped to this component, so it only binds while the Cases segment is on
	 * screen. Ignored while the reader is already typing somewhere else — a
	 * shortcut that steals focus out of a textarea is worse than no shortcut —
	 * and `preventDefault` stops Firefox opening its own quick-find.
	 */
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "k" || !(e.metaKey || e.ctrlKey)) {
				return;
			}
			const el = document.activeElement;
			const typing =
				el instanceof HTMLElement &&
				(el.tagName === "INPUT" ||
					el.tagName === "TEXTAREA" ||
					el.isContentEditable);
			if (typing && el !== searchRef.current) {
				return;
			}
			e.preventDefault();
			searchRef.current?.focus();
			searchRef.current?.select();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
	const [debouncedSearch] = useDebounceValue(searchDraft, SEARCH_DEBOUNCE_MS);

	useEffect(() => {
		if (debouncedSearch !== filters.search) {
			setFilter("search", debouncedSearch);
		}
	}, [debouncedSearch, filters.search, setFilter]);

	// Keep the field in step when the search is cleared from OUTSIDE the
	// toolbar (the "Clear" button, or a segment switch that resets filters).
	useEffect(() => {
		setSearchDraft((draft) =>
			filters.search === draft ? draft : filters.search,
		);
	}, [filters.search]);

	/**
	 * Filters the reader added from the menu but has not given a value yet.
	 *
	 * Deliberately component state and not URL state: an empty control is a
	 * half-finished thought, not part of the view. Putting it in the address bar
	 * would mean a link, or a saved view, restoring somebody else's blank
	 * dropdowns — and `captureView` would have to learn to strip them.
	 */
	const [revealed, setRevealed] = useState<ReadonlySet<BuildableFilter>>(
		() => new Set(),
	);
	/** The last filter added, so its control can take focus as it appears. */
	const [justAdded, setJustAdded] = useState<BuildableFilter | null>(null);

	const shownFilters = visibleFilters(filters, revealed);
	const addable = addableFilters(shownFilters);

	const addFilter = (key: BuildableFilter) => {
		setRevealed((prev) => new Set(prev).add(key));
		setJustAdded(key);
	};

	/**
	 * Removing a filter clears its value as well as hiding the control — the two
	 * have to happen together. Hiding a control while its predicate kept
	 * narrowing the list is the exact failure the builder is supposed to prevent,
	 * and `visibleFilters` would put it straight back anyway.
	 */
	const removeFilter = (key: BuildableFilter) => {
		setRevealed((prev) => {
			const next = new Set(prev);
			next.delete(key);
			return next;
		});
		setJustAdded((current) => (current === key ? null : current));
		clearFilterValue(key);
	};

	// Written out per key rather than driven off the union: `setFilter` narrows
	// its value to the key it was given, and one call with a union key would have
	// to widen that to whatever every filter accepts.
	function clearFilterValue(key: BuildableFilter) {
		switch (key) {
			case "priority":
				return setFilter("priority", ALL);
			case "automationStatus":
				return setFilter("automationStatus", ALL);
			case "currentResult":
				return setFilter("currentResult", ALL);
			case "externalLinked":
				return setFilter("externalLinked", ALL);
			case "linkedStoryId":
				return setFilter("linkedStoryId", null);
			case "tag":
				return setFilter("tag", null);
			default: {
				const exhaustive: never = key;
				return exhaustive;
			}
		}
	}

	const clearAll = () => {
		setRevealed(new Set());
		setJustAdded(null);
		view.resetFilters();
	};

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative w-full sm:max-w-xs">
					<SearchIcon
						aria-hidden="true"
						className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground"
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<SearchInput
								ref={searchRef}
								value={searchDraft}
								onChange={(e) => setSearchDraft(e.target.value)}
								placeholder={t("filters.searchPlaceholder")}
								aria-label={t("filters.searchAria")}
								className="h-9 pl-9"
							/>
						</TooltipTrigger>
						<TooltipContent className="max-w-xs">
							{t("filters.searchHint")}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Segmented All / Ready / Draft / Closed with live counts */}
				<fieldset className="m-0 inline-flex min-w-0 flex-wrap rounded-lg border border-border/60 p-0.5">
					<legend className="sr-only">
						{t("filters.stateAria")}
					</legend>
					<StateSegment
						active={filters.state === ALL}
						label={t("filters.stateAll")}
						count={totalAllStates}
						ariaLabel={t("filters.segmentAria", {
							label: t("filters.stateAll"),
							count: totalAllStates,
						})}
						hint={t("filters.stateAllHint")}
						onClick={() => setFilter("state", ALL)}
					/>
					{TEST_CASE_STATES.map((s) => (
						<StateSegment
							key={s}
							active={filters.state === s}
							label={t(STATE_I18N_KEY[s])}
							count={stateCounts[s]}
							ariaLabel={t("filters.segmentAria", {
								label: t(STATE_I18N_KEY[s]),
								count: stateCounts[s],
							})}
							hint={t(`filters.stateHint.${s.toLowerCase()}`)}
							onClick={() => setFilter("state", s)}
						/>
					))}
				</fieldset>

				<span className="ml-auto text-muted-foreground text-xs tabular-nums">
					{shown < total
						? t("filters.showingOfTotal", { shown, total })
						: t("caseCount", { count: total })}
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{shownFilters.includes("priority") && (
					<BuilderSlot
						label={t("filters.priorityLabel")}
						focusOnMount={justAdded === "priority"}
						onRemove={() => removeFilter("priority")}
					>
						<FilterSelect
							value={filters.priority}
							options={TEST_CASE_PRIORITIES}
							i18nKey={PRIORITY_I18N_KEY}
							allLabel={t("filters.allPriorities")}
							ariaLabel={t("filters.priorityAria")}
							hint={t("filters.priorityFilterHint")}
							width="w-[8.5rem]"
							onChange={(v) => setFilter("priority", v)}
						/>
					</BuilderSlot>
				)}

				{shownFilters.includes("automationStatus") && (
					<BuilderSlot
						label={t("filters.automationLabel")}
						focusOnMount={justAdded === "automationStatus"}
						onRemove={() => removeFilter("automationStatus")}
					>
						<FilterSelect
							value={filters.automationStatus}
							options={AUTOMATION_STATUSES}
							i18nKey={AUTOMATION_I18N_KEY}
							allLabel={t("filters.allAutomation")}
							ariaLabel={t("filters.automationAria")}
							hint={t("filters.automationFilterHint")}
							width="w-[9.5rem]"
							onChange={(v) => setFilter("automationStatus", v)}
						/>
					</BuilderSlot>
				)}

				{shownFilters.includes("currentResult") && (
					<BuilderSlot
						label={t("filters.resultLabel")}
						focusOnMount={justAdded === "currentResult"}
						onRemove={() => removeFilter("currentResult")}
					>
						<FilterSelect
							value={filters.currentResult}
							options={TEST_RESULTS}
							i18nKey={RESULT_I18N_KEY}
							allLabel={t("filters.allResults")}
							ariaLabel={t("filters.resultAria")}
							hint={t("filters.resultFilterHint")}
							width="w-[9rem]"
							onChange={(v) => setFilter("currentResult", v)}
						/>
					</BuilderSlot>
				)}

				{shownFilters.includes("externalLinked") && (
					<BuilderSlot
						label={t("filters.linkedLabel")}
						focusOnMount={justAdded === "externalLinked"}
						onRemove={() => removeFilter("externalLinked")}
					>
						<ExternalLinkedFilter
							value={filters.externalLinked}
							onChange={(v) => setFilter("externalLinked", v)}
						/>
					</BuilderSlot>
				)}

				{shownFilters.includes("linkedStoryId") && (
					<BuilderSlot
						label={t("filters.featureLabel")}
						focusOnMount={justAdded === "linkedStoryId"}
						onRemove={() => removeFilter("linkedStoryId")}
					>
						<FeatureFilterControl
							projectId={projectId}
							organizationId={organizationId}
							value={filters.linkedStoryId}
							onChange={(id) => setFilter("linkedStoryId", id)}
						/>
					</BuilderSlot>
				)}

				{filters.planId && (
					<PlanFilterChip
						projectId={projectId}
						organizationId={organizationId}
						value={filters.planId}
						onChange={(id) => setFilter("planId", id)}
					/>
				)}

				{shownFilters.includes("tag") && (
					<BuilderSlot
						label={t("filters.tagLabel")}
						focusOnMount={justAdded === "tag"}
						onRemove={() => removeFilter("tag")}
					>
						<div className="relative w-full sm:w-40">
							<TagIcon
								aria-hidden="true"
								className="-translate-y-1/2 absolute top-1/2 left-2.5 size-3.5 text-muted-foreground"
							/>
							<Tooltip>
								<TooltipTrigger asChild>
									<Input
										value={filters.tag ?? ""}
										onChange={(e) =>
											setFilter(
												"tag",
												e.target.value || null,
											)
										}
										placeholder={t(
											"filters.tagPlaceholder",
										)}
										aria-label={t("filters.tagAria")}
										className="h-9 pl-8"
									/>
								</TooltipTrigger>
								<TooltipContent className="max-w-xs">
									{t("filters.tagHint")}
								</TooltipContent>
							</Tooltip>
						</div>
					</BuilderSlot>
				)}

				<AddFilterMenu
					options={addable}
					onAdd={addFilter}
					labelFor={(key) => t(FILTER_LABEL_KEY[key])}
				/>

				<div className="flex items-center gap-1">
					<Select
						value={view.sort}
						onValueChange={(v) => view.selectSort(v as SortKey)}
					>
						<Tooltip>
							<TooltipTrigger asChild>
								<SelectTrigger
									className="h-9 w-[9.5rem]"
									aria-label={t("sort.aria")}
								>
									<SelectValue />
								</SelectTrigger>
							</TooltipTrigger>
							<TooltipContent className="max-w-xs">
								{t("sort.hint")}
							</TooltipContent>
						</Tooltip>
						<SelectContent>
							{SORT_KEYS.map((k) => (
								<SelectItem key={k} value={k}>
									{t(SORT_I18N_KEY[k])}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<SortDirectionToggle
						direction={view.direction}
						onToggle={() =>
							view.setDirection(
								view.direction === "asc" ? "desc" : "asc",
							)
						}
					/>
				</div>

				{view.hasActiveFilters && (
					<Button variant="ghost" size="sm" onClick={clearAll}>
						{t("filters.clear")}
					</Button>
				)}
			</div>
		</div>
	);
}

/**
 * One enum filter: an `ALL` sentinel plus an item per value, labelled through the
 * enum's i18n map. Every enum filter in the toolbar is this control, so Radix's
 * `string` is narrowed back to the enum once — here — rather than at each call
 * site. `options` is what makes that narrowing sound: the items rendered and the
 * values accepted are the same list, so anything else was never selectable.
 */
function FilterSelect<T extends string>({
	value,
	options,
	i18nKey,
	allLabel,
	ariaLabel,
	width,
	hint,
	onChange,
}: {
	value: T | typeof ALL;
	options: readonly T[];
	/** Option → i18n key suffix under `projects.testCases.*`. */
	i18nKey: Record<T, string>;
	/** Copy for the `ALL` item ("All priorities", …). */
	allLabel: string;
	ariaLabel: string;
	/** Trigger width — each filter is sized to its longest label. */
	width: string;
	/**
	 * What this filter actually selects on. Every enum filter in the toolbar is
	 * this control, so wrapping the trigger here explains all of them at once
	 * rather than needing a Tooltip bolted onto each call site.
	 */
	hint?: string;
	onChange: (value: T | typeof ALL) => void;
}) {
	const t = useTranslations("projects.testCases");
	return (
		<Select
			value={value}
			onValueChange={(v) => {
				if (v === ALL) {
					onChange(ALL);
					return;
				}
				const option = options.find((o) => o === v);
				if (option) {
					onChange(option);
				}
			}}
		>
			{hint ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<SelectTrigger
							className={cn("h-9", width)}
							aria-label={ariaLabel}
						>
							<SelectValue />
						</SelectTrigger>
					</TooltipTrigger>
					<TooltipContent className="max-w-xs">{hint}</TooltipContent>
				</Tooltip>
			) : (
				<SelectTrigger
					className={cn("h-9", width)}
					aria-label={ariaLabel}
				>
					<SelectValue />
				</SelectTrigger>
			)}
			<SelectContent>
				<SelectItem value={ALL}>{allLabel}</SelectItem>
				{options.map((option) => {
					// `t` infers its arg types from the key, so it needs a plain
					// `string`; while `T` is generic `Record<T, string>[T]` hasn't
					// reduced to one. Naming it widens it, as the non-generic call
					// sites did implicitly.
					const key: string = i18nKey[option];
					return (
						<SelectItem key={option} value={option}>
							{t(key)}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}

/** Radix items are strings, so the boolean coverage filter rides as these two. */
const EXTERNAL_LINKED_OPTIONS = ["true", "false"] as const;
type ExternalLinkedOption = (typeof EXTERNAL_LINKED_OPTIONS)[number];
const EXTERNAL_LINKED_I18N_KEY: Record<ExternalLinkedOption, string> = {
	true: "filters.externalLinked",
	false: "filters.externalNotLinked",
};

/**
 * The coverage filter is the only one whose value is a boolean, not a string
 * enum. Mapping it at the edge keeps that special case out of the shared control.
 */
function ExternalLinkedFilter({
	value,
	onChange,
}: {
	value: boolean | typeof ALL;
	onChange: (value: boolean | typeof ALL) => void;
}) {
	const t = useTranslations("projects.testCases");
	return (
		<FilterSelect
			value={value === ALL ? ALL : value ? "true" : "false"}
			options={EXTERNAL_LINKED_OPTIONS}
			i18nKey={EXTERNAL_LINKED_I18N_KEY}
			allLabel={t("filters.allExternal")}
			ariaLabel={t("filters.externalAria")}
			hint={t("filters.externalFilterHint")}
			width="w-[9.5rem]"
			onChange={(v) => onChange(v === ALL ? ALL : v === "true")}
		/>
	);
}

/**
 * Icon-only, so the accessible name has to carry the current direction — an
 * unlabelled arrow tells a screen-reader user nothing about which way the list
 * is ordered right now.
 */
function SortDirectionToggle({
	direction,
	onToggle,
}: {
	direction: "asc" | "desc";
	onToggle: () => void;
}) {
	const t = useTranslations("projects.testCases");
	const Icon = direction === "asc" ? ArrowUpIcon : ArrowDownIcon;
	return (
		<Button
			type="button"
			variant="outline"
			size="icon"
			className="size-9 shrink-0"
			onClick={onToggle}
			aria-label={t("sort.directionAria", {
				direction: t(`sort.${direction}`),
			})}
		>
			<Icon className="size-4" aria-hidden="true" />
		</Button>
	);
}

/**
 * The feature filter: the picker until one is chosen, then a removable chip.
 * The chip resolves its own label from the shared options cache — `filters`
 * carries only the id.
 */
function FeatureFilterControl({
	projectId,
	organizationId,
	value,
	onChange,
}: {
	projectId: string;
	organizationId: string | null;
	value: string | null;
	onChange: (id: string | null) => void;
}) {
	const t = useTranslations("projects.testCases");
	const { byId } = useFeatureOptions({
		projectId,
		organizationId,
		enabled: Boolean(value),
	});

	if (!value) {
		return (
			<FeaturePicker
				projectId={projectId}
				organizationId={organizationId}
				value={[]}
				onChange={(selected) => onChange(selected[0]?.id ?? null)}
				ariaLabel={t("filters.featureAria")}
				placeholder={t("filters.featureFilter")}
				triggerClassName="h-9 w-[11rem]"
			/>
		);
	}

	// Until the options land the id is all there is to show — an honest
	// placeholder beats an empty chip that looks like it filters by nothing.
	const option = byId.get(value);
	const identifier = option?.identifier ?? value;
	return (
		<FilterChip
			label={t("filters.featureChipLabel")}
			identifier={identifier}
			title={option?.title}
			onRemove={() => onChange(null)}
			removeAriaLabel={t("filters.featureRemoveAria", { identifier })}
		/>
	);
}

/**
 * The plan filter has no picker: it is only ever set by "View in Cases" on a
 * plan, so the toolbar's job is to say the list is narrowed to that plan and
 * give the reader a way out.
 *
 * The input deliberately matches the plans segment's own list query
 * (`includePassRate`), so the chip resolves its name from that cache entry
 * rather than firing a second copy of the same read — arriving here from a plan
 * means the list is already loaded.
 */
function PlanFilterChip({
	projectId,
	organizationId,
	value,
	onChange,
}: {
	projectId: string;
	organizationId: string | null;
	value: string;
	onChange: (id: string | null) => void;
}) {
	const t = useTranslations("projects.testCases");
	const { data } = useQuery({
		...orpc.projects.testCases.plans.list.queryOptions({
			input: { projectId, organizationId, includePassRate: true },
		}),
		staleTime: 60_000,
	});

	const plan = data?.items.find((p) => p.id === value);
	const identifier = plan?.identifier ?? value;
	return (
		<FilterChip
			label={t("filters.planChipLabel")}
			identifier={identifier}
			title={plan?.name}
			onRemove={() => onChange(null)}
			removeAriaLabel={t("filters.planRemoveAria", { identifier })}
		/>
	);
}

function StateSegment({
	active,
	label,
	count,
	ariaLabel,
	hint,
	onClick,
}: {
	active: boolean;
	label: string;
	count: number;
	ariaLabel: string;
	/** What this state means in a case's life, and what the count covers. */
	hint?: string;
	onClick: () => void;
}) {
	const button = (
		<button
			type="button"
			aria-pressed={active}
			aria-label={ariaLabel}
			onClick={onClick}
			className={cn(
				"inline-flex items-center gap-1.5 rounded-md px-3 py-1 font-medium text-sm transition-colors",
				active
					? "bg-primary text-primary-foreground"
					: "text-muted-foreground hover:bg-accent hover:text-foreground",
			)}
		>
			{label}
			<span
				className={cn(
					"rounded-full px-1.5 text-xs tabular-nums",
					active
						? "bg-primary-foreground/20"
						: "bg-muted text-muted-foreground",
				)}
			>
				{count}
			</span>
		</button>
	);

	if (!hint) {
		return button;
	}
	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent className="max-w-xs">{hint}</TooltipContent>
		</Tooltip>
	);
}

/**
 * One filter in the row, with the control to remove it again.
 *
 * The X is what makes the builder reversible, and it has to be a real button
 * rather than "set it back to All": half the filters have no All — clearing a
 * tag means emptying a text field, and a reader who had to guess which gesture
 * retires which control would keep the row full of ones they were done with.
 */
function BuilderSlot({
	label,
	focusOnMount,
	onRemove,
	children,
}: {
	/** Names the filter, so the icon-only remove button can say what it removes. */
	label: string;
	/** Take focus as this appears — it was just added from the menu. */
	focusOnMount?: boolean;
	onRemove: () => void;
	children: React.ReactNode;
}) {
	const t = useTranslations("projects.testCases");
	const ref = useRef<HTMLDivElement>(null);

	// Adding a filter and leaving focus on the "Add filter" button makes the new
	// control reachable only by tabbing past everything already in the row —
	// worst for the keyboard reader the menu is most useful to. The control is
	// whatever comes first inside the slot, so this does not care which kind it is.
	//
	// Deferred a frame because the menu that added this slot has not finished
	// closing: Radix returns focus to its own trigger on close, and it does so
	// AFTER the new slot has mounted. Focusing synchronously here looked correct
	// and was silently undone a moment later, leaving focus on "Add filter".
	useEffect(() => {
		if (!focusOnMount) {
			return;
		}
		const frame = requestAnimationFrame(() => {
			ref.current
				?.querySelector<HTMLElement>("input, button, [role='combobox']")
				?.focus();
		});
		return () => cancelAnimationFrame(frame);
	}, [focusOnMount]);

	return (
		// No border or padding of its own: every other control in this row is
		// exactly h-9, and a wrapper with a border and p-0.5 would make each
		// filter 42px against its 36px neighbours — a row that no longer lines up,
		// plus a second border 2px outside the control's own.
		<div ref={ref} className="inline-flex h-9 items-center gap-0.5">
			{children}
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						onClick={onRemove}
						aria-label={t("filters.removeFilterAria", { label })}
						className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
					>
						<XIcon className="size-3.5" aria-hidden="true" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{t("filters.removeFilterAria", { label })}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}

/**
 * "Add filter" — the menu of everything not currently on screen.
 *
 * The button stays put once all six are in use — the menu then says so rather
 * than the control disappearing. A control that vanishes reads as a bug, and
 * its absence is the one moment a reader would go looking for it. It also stays
 * clickable: a disabled trigger swallows the pointer events its own tooltip
 * needs, so "why can I not add anything?" would have gone unanswered.
 */
function AddFilterMenu({
	options,
	onAdd,
	labelFor,
}: {
	options: BuildableFilter[];
	onAdd: (key: BuildableFilter) => void;
	labelFor: (key: BuildableFilter) => string;
}) {
	const t = useTranslations("projects.testCases");

	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-9 border border-border/60 border-dashed text-muted-foreground hover:text-foreground"
						>
							<PlusIcon className="size-3.5" aria-hidden="true" />
							{t("filters.addFilter")}
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent className="max-w-xs">
					{t("filters.addFilterHint")}
				</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="start" className="w-52">
				{options.length === 0 && (
					<DropdownMenuItem disabled>
						{t("filters.addFilterAllShown")}
					</DropdownMenuItem>
				)}
				{options.map((key) => (
					<DropdownMenuItem key={key} onSelect={() => onAdd(key)}>
						{labelFor(key)}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
