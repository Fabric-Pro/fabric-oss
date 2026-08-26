"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
	AUTOMATION_STATUSES,
	type AutomationStatus,
	SORT_DEFAULT_DIRECTION,
	SORT_KEYS,
	type SortDirection,
	type SortKey,
	TEST_CASE_PRIORITIES,
	TEST_CASE_STATES,
	TEST_RESULTS,
	type TestCasePriority,
	type TestCaseState,
	type TestResult,
} from "./constants";

export type Segment =
	| "cases"
	| "plans"
	| "features"
	| "runs"
	| "questions"
	| "reviews";

export const SEGMENTS: Segment[] = [
	"cases",
	"plans",
	"features",
	"runs",
	"reviews",
	"questions",
];

/** Sentinel for "no filter" in the Select controls (Radix needs a real value). */
export const ALL = "ALL" as const;

/** A filter value that may be unset — `ALL` collapses to `undefined` server-side. */
type Filterable<T> = T | typeof ALL;

/**
 * Rows per page. The list procedure caps `limit` at 200, so every option here
 * has to stay under it — a value it rejects would render an empty table with no
 * visible cause.
 */
export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
const DEFAULT_PAGE_SIZE: PageSize = 50;

export type TestCasesListInput = {
	projectId: string;
	organizationId: string | null;
	search?: string;
	state?: TestCaseState;
	priority?: TestCasePriority;
	tag?: string;
	linkedStoryId?: string;
	planId?: string;
	automationStatus?: AutomationStatus;
	currentResult?: TestResult;
	externalLinked?: boolean;
	sort?: SortKey;
	direction?: SortDirection;
};

export type TestCasesFilters = {
	search: string;
	state: Filterable<TestCaseState>;
	priority: Filterable<TestCasePriority>;
	tag: string | null;
	/** Feature/bug the case covers (work-item link). */
	linkedStoryId: string | null;
	/** Test plan the case belongs to. */
	planId: string | null;
	automationStatus: Filterable<AutomationStatus>;
	currentResult: Filterable<TestResult>;
	externalLinked: Filterable<boolean>;
};

/**
 * Pure derivation of the `testCases.list` oRPC input from the current filter +
 * sort state. Extracted (and exported) so it can be unit-tested without React or
 * a live oRPC client — empty/`ALL` filters collapse to `undefined` so they drop
 * out of the request (and the query key) entirely.
 */
export function buildTestCasesListInput(args: {
	projectId: string;
	organizationId: string | null;
	filters: TestCasesFilters;
	sort: SortKey;
	direction: SortDirection;
}): TestCasesListInput {
	const { filters } = args;
	const search = filters.search.trim();
	return {
		projectId: args.projectId,
		organizationId: args.organizationId,
		...(search ? { search } : {}),
		...(filters.state === ALL ? {} : { state: filters.state }),
		...(filters.priority === ALL ? {} : { priority: filters.priority }),
		// Trimmed HERE, not in the input's onChange. Trimming on every keystroke
		// against a controlled field ate the space the moment it was typed, so
		// "smoke test" became "smoket" and any tag containing a space was
		// unreachable through this filter.
		...(filters.tag?.trim() ? { tag: filters.tag.trim() } : {}),
		...(filters.linkedStoryId
			? { linkedStoryId: filters.linkedStoryId }
			: {}),
		...(filters.planId ? { planId: filters.planId } : {}),
		...(filters.automationStatus === ALL
			? {}
			: { automationStatus: filters.automationStatus }),
		...(filters.currentResult === ALL
			? {}
			: { currentResult: filters.currentResult }),
		...(filters.externalLinked === ALL
			? {}
			: { externalLinked: filters.externalLinked }),
		sort: args.sort,
		direction: args.direction,
	};
}

/**
 * The filter half of the list input — exactly the predicate a "select all N
 * matching" bulk action re-resolves server-side. Derived from the SAME
 * `buildTestCasesListInput` output so the bulk set can never drift from what
 * the list rendered; `projectId` / `organizationId` / sort are dropped because
 * they are addressing and ordering, not predicates.
 */
export function toBulkFilter(input: TestCasesListInput) {
	const {
		projectId: _projectId,
		organizationId: _organizationId,
		sort: _sort,
		direction: _direction,
		...filter
	} = input;
	return filter;
}

/** The unset toolbar — every filter's "no filter" value, and the reset target. */
export const EMPTY_FILTERS: TestCasesFilters = {
	search: "",
	state: ALL,
	priority: ALL,
	tag: null,
	linkedStoryId: null,
	planId: null,
	automationStatus: ALL,
	currentResult: ALL,
	externalLinked: ALL,
};

/**
 * Whether the reader has narrowed the list at all — gates the "Clear" button and
 * picks the filtered vs. empty copy.
 *
 * Derived from `EMPTY_FILTERS` rather than re-listing the filters, so a new
 * filter is active-aware the moment it gets an unset default. Hand-enumerating
 * it a second time is how "Clear" silently stops offering itself for whichever
 * filter the next author forgets. `search` is the one field whose unset value
 * isn't reachable by equality — whitespace is still no search.
 */
export function hasActiveFilters(filters: TestCasesFilters): boolean {
	const keys = Object.keys(EMPTY_FILTERS) as (keyof TestCasesFilters)[];
	return keys.some((key) =>
		key === "search"
			? filters.search.trim() !== ""
			: filters[key] !== EMPTY_FILTERS[key],
	);
}

/**
 * The whole view, as it appears in the URL.
 *
 * Filters, sort and page are addressable rather than component state so the
 * view is shareable and the browser's Back button returns to it. A reader who
 * narrows to "failing, critical, page 3", opens a case and presses Back used to
 * land on an unfiltered page 1 — the narrowing they did was simply gone.
 */
export type TestCasesViewState = {
	segment: Segment;
	filters: TestCasesFilters;
	sort: SortKey;
	direction: SortDirection;
	/** 1-based, as it reads in the URL and in the pagination control. */
	page: number;
	pageSize: PageSize;
};

/** Query-param names. Short, because they all share one address bar. */
const PARAM = {
	segment: "seg",
	search: "q",
	state: "state",
	priority: "pri",
	tag: "tag",
	linkedStoryId: "story",
	planId: "plan",
	automationStatus: "auto",
	currentResult: "result",
	externalLinked: "linked",
	sort: "sort",
	direction: "dir",
	page: "page",
	pageSize: "size",
} as const;

/** Every param this view owns — the set a reset has to clear. */
export const VIEW_PARAM_NAMES: string[] = Object.values(PARAM);

export const DEFAULT_VIEW_STATE: TestCasesViewState = {
	segment: "cases",
	filters: EMPTY_FILTERS,
	sort: "order",
	direction: SORT_DEFAULT_DIRECTION.order,
	page: 1,
	pageSize: DEFAULT_PAGE_SIZE,
};

/** Narrow an untrusted param to a known member, else fall back. */
function oneOf<T extends string>(
	raw: string | null,
	allowed: readonly T[],
	fallback: T | typeof ALL,
): T | typeof ALL {
	if (!raw) {
		return fallback;
	}
	return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/**
 * Read the view out of the URL. Total: an unknown or malformed value falls back
 * to its default rather than throwing, because these params are hand-editable
 * and arrive from links other people wrote.
 */
export function parseViewFromParams(
	params: URLSearchParams,
): TestCasesViewState {
	const segmentRaw = params.get(PARAM.segment);
	const segment: Segment = SEGMENTS.includes(segmentRaw as Segment)
		? (segmentRaw as Segment)
		: "cases";

	const externalRaw = params.get(PARAM.externalLinked);
	const filters: TestCasesFilters = {
		search: params.get(PARAM.search) ?? "",
		state: oneOf(params.get(PARAM.state), TEST_CASE_STATES, ALL),
		priority: oneOf(params.get(PARAM.priority), TEST_CASE_PRIORITIES, ALL),
		tag: params.get(PARAM.tag),
		linkedStoryId: params.get(PARAM.linkedStoryId),
		planId: params.get(PARAM.planId),
		automationStatus: oneOf(
			params.get(PARAM.automationStatus),
			AUTOMATION_STATUSES,
			ALL,
		),
		currentResult: oneOf(
			params.get(PARAM.currentResult),
			TEST_RESULTS,
			ALL,
		),
		externalLinked:
			externalRaw === "true"
				? true
				: externalRaw === "false"
					? false
					: ALL,
	};

	const sortRaw = params.get(PARAM.sort);
	const sort: SortKey = SORT_KEYS.includes(sortRaw as SortKey)
		? (sortRaw as SortKey)
		: DEFAULT_VIEW_STATE.sort;
	const dirRaw = params.get(PARAM.direction);
	const direction: SortDirection =
		dirRaw === "asc" || dirRaw === "desc"
			? dirRaw
			: SORT_DEFAULT_DIRECTION[sort];

	const pageRaw = Number.parseInt(params.get(PARAM.page) ?? "", 10);
	const page =
		Number.isFinite(pageRaw) && pageRaw >= 1
			? pageRaw
			: DEFAULT_VIEW_STATE.page;

	const sizeRaw = Number.parseInt(params.get(PARAM.pageSize) ?? "", 10);
	const pageSize = (PAGE_SIZES as readonly number[]).includes(sizeRaw)
		? (sizeRaw as PageSize)
		: DEFAULT_PAGE_SIZE;

	return { segment, filters, sort, direction, page, pageSize };
}

/**
 * Write the view back into a param set, dropping anything at its default so the
 * common case stays a clean URL. Mutates a COPY of `base` so params this view
 * does not own (`?case=`, and anything a future feature adds) survive.
 */
export function applyViewToParams(
	base: URLSearchParams,
	view: TestCasesViewState,
): URLSearchParams {
	const next = new URLSearchParams(base);
	const set = (key: string, value: string | null | undefined) => {
		if (value === null || value === undefined || value === "") {
			next.delete(key);
		} else {
			next.set(key, value);
		}
	};

	set(PARAM.segment, view.segment === "cases" ? null : view.segment);
	set(PARAM.search, view.filters.search.trim() || null);
	set(PARAM.state, view.filters.state === ALL ? null : view.filters.state);
	set(
		PARAM.priority,
		view.filters.priority === ALL ? null : view.filters.priority,
	);
	set(PARAM.tag, view.filters.tag?.trim() || null);
	set(PARAM.linkedStoryId, view.filters.linkedStoryId);
	set(PARAM.planId, view.filters.planId);
	set(
		PARAM.automationStatus,
		view.filters.automationStatus === ALL
			? null
			: view.filters.automationStatus,
	);
	set(
		PARAM.currentResult,
		view.filters.currentResult === ALL ? null : view.filters.currentResult,
	);
	set(
		PARAM.externalLinked,
		view.filters.externalLinked === ALL
			? null
			: String(view.filters.externalLinked),
	);
	set(PARAM.sort, view.sort === DEFAULT_VIEW_STATE.sort ? null : view.sort);
	set(
		PARAM.direction,
		view.direction === SORT_DEFAULT_DIRECTION[view.sort]
			? null
			: view.direction,
	);
	set(PARAM.page, view.page > 1 ? String(view.page) : null);
	set(
		PARAM.pageSize,
		view.pageSize === DEFAULT_PAGE_SIZE ? null : String(view.pageSize),
	);

	return next;
}

/**
 * Which changes send the reader back to page 1.
 *
 * Any change to the matching SET has to, or page 3 of a 5-page list becomes an
 * empty table the moment a filter narrows it to one page — the reader sees "no
 * cases match" for a filter that matched plenty. Re-ordering does not: the same
 * rows are there, in a different order, and someone who re-sorts while reading
 * page 3 means page 3 of the new order.
 */
export function shouldResetPage(
	prev: TestCasesViewState,
	next: TestCasesViewState,
): boolean {
	return (
		JSON.stringify(prev.filters) !== JSON.stringify(next.filters) ||
		prev.pageSize !== next.pageSize
	);
}

/**
 * View state for the Testing tab: the active segment, the Cases filter toolbar,
 * the sort and the page — all held in the URL. Returns the derived `list` oRPC
 * input + its query key so the list query and post-mutation invalidations stay
 * in lock-step.
 *
 * Every filter, the sort AND the page are applied SERVER-SIDE so pagination
 * stays correct. A client-side sort could only order the rows it had loaded —
 * with paginated results that silently ordered one page and called it the
 * answer.
 */
export function useTestCasesView(
	projectId: string,
	organizationId: string | null,
) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();

	const state = useMemo(
		() => parseViewFromParams(new URLSearchParams(searchParams.toString())),
		[searchParams],
	);

	/**
	 * The state a commit should build on.
	 *
	 * `state` is derived from `useSearchParams()`, which only reflects a
	 * `router.replace` once React has re-rendered — the router update is
	 * dispatched in a transition, not synchronously. So two setters called
	 * before that re-render both read the SAME `state`, each write a complete
	 * param set, and the later `replace` silently discards the earlier one. The
	 * concrete loss: the 300ms search debounce fires while the reader clicks a
	 * state filter, and the URL ends up with the filter but no search — the
	 * search box still showing text that is not being applied.
	 *
	 * Holding the just-committed state in a ref closes that window: a second
	 * commit in the same tick composes on top of the first instead of racing it.
	 */
	const pendingRef = useRef<TestCasesViewState | null>(null);

	// The URL is the source of truth. Once it has caught up — or diverged,
	// because the reader pressed Back — the pending write has served its purpose
	// and must not keep shadowing it.
	useEffect(() => {
		pendingRef.current = null;
	}, [state]);

	/**
	 * `replace`, not `push`: every keystroke in the search box would otherwise
	 * become its own history entry, and Back would walk the reader letter by
	 * letter out of a search rather than out of the page. `scroll: false` keeps
	 * the reader where they were — a filter change must not jump them to the top
	 * of a table they were reading half-way down.
	 */
	const commit = useCallback(
		(update: (prev: TestCasesViewState) => TestCasesViewState) => {
			const prev = pendingRef.current ?? state;
			const next = update(prev);
			const resolved = shouldResetPage(prev, next)
				? { ...next, page: 1 }
				: next;
			// Set BEFORE the navigation, so a commit later in this same tick
			// reads it rather than the URL that has not moved yet.
			pendingRef.current = resolved;

			const params = applyViewToParams(
				new URLSearchParams(searchParams.toString()),
				resolved,
			);
			const query = params.toString();
			router.replace(query ? `${pathname}?${query}` : pathname, {
				scroll: false,
			});
		},
		[pathname, router, searchParams, state],
	);

	const setSegment = useCallback(
		(segment: Segment) => commit((prev) => ({ ...prev, segment })),
		[commit],
	);

	const setFilter = useCallback(
		<K extends keyof TestCasesFilters>(
			key: K,
			value: TestCasesFilters[K],
		) =>
			commit((prev) => ({
				...prev,
				filters: { ...prev.filters, [key]: value },
			})),
		[commit],
	);

	/** Apply several filters as one navigation. */
	const setFilters = useCallback(
		(patch: Partial<TestCasesFilters>) =>
			commit((prev) => ({
				...prev,
				filters: { ...prev.filters, ...patch },
			})),
		[commit],
	);

	/**
	 * Picking a new sort key resets the direction to that key's natural default
	 * (priority → highest first, title → A-Z). Carrying the previous key's
	 * direction over would silently invert the new one.
	 */
	const selectSort = useCallback(
		(sort: SortKey) =>
			commit((prev) => ({
				...prev,
				sort,
				direction: SORT_DEFAULT_DIRECTION[sort],
			})),
		[commit],
	);
	const setDirection = useCallback(
		(direction: SortDirection) =>
			commit((prev) => ({ ...prev, direction })),
		[commit],
	);

	const setPage = useCallback(
		(page: number) =>
			commit((prev) => ({ ...prev, page: Math.max(1, page) })),
		[commit],
	);
	const setPageSize = useCallback(
		(pageSize: PageSize) => commit((prev) => ({ ...prev, pageSize })),
		[commit],
	);

	/**
	 * Replace the whole view with a saved query string.
	 *
	 * Goes through the same `router.replace` as every other change, and keeps
	 * params this view does not own (`?case=`) — applying a saved view must not
	 * close a case the reader had opened.
	 */
	const applyQuery = useCallback(
		(query: string) => {
			const incoming = new URLSearchParams(query);
			const params = new URLSearchParams(searchParams.toString());
			for (const name of VIEW_PARAM_NAMES) {
				params.delete(name);
			}
			for (const [k, v] of incoming) {
				if (VIEW_PARAM_NAMES.includes(k)) {
					params.set(k, v);
				}
			}
			// A saved view is a destination, so the ref must not keep shadowing
			// it with whatever was committed a moment ago.
			pendingRef.current = null;
			const next = params.toString();
			router.replace(next ? `${pathname}?${next}` : pathname, {
				scroll: false,
			});
		},
		[pathname, router, searchParams],
	);

	const resetFilters = useCallback(
		() => commit((prev) => ({ ...prev, filters: EMPTY_FILTERS })),
		[commit],
	);

	const listInput = useMemo(
		() =>
			buildTestCasesListInput({
				projectId,
				organizationId,
				filters: state.filters,
				sort: state.sort,
				direction: state.direction,
			}),
		[projectId, organizationId, state.filters, state.sort, state.direction],
	);

	const listQueryKey = useMemo(
		() => orpc.projects.testCases.list.queryKey({ input: listInput }),
		[listInput],
	);

	return {
		segment: state.segment,
		setSegment,
		filters: state.filters,
		setFilter,
		setFilters,
		sort: state.sort,
		selectSort,
		direction: state.direction,
		setDirection,
		page: state.page,
		setPage,
		pageSize: state.pageSize,
		setPageSize,
		listInput,
		listQueryKey,
		hasActiveFilters: hasActiveFilters(state.filters),
		resetFilters,
		applyQuery,
	};
}

export type TestCasesView = ReturnType<typeof useTestCasesView>;
