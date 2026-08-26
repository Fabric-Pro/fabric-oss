/**
 * The Test Cases list read path — filter/sort compilation + the paginated query.
 *
 * Its own module because {@link buildTestCaseWhere} is shared rather than
 * private: `listTestCases` and the bulk "select all N matching" resolver both
 * compile their predicate through it, which is what keeps a bulk action provably
 * scoped to exactly the rows the list showed. Sibling of `test-cases.ts`
 * (authoring / CRUD) behind the same barrel, under the same `projectId` +
 * `deletedAt: null` scoping.
 */

import {
	type AutomationStatus,
	db,
	type Prisma,
	type TestCasePriority,
	type TestCaseState,
	type TestResult,
} from "../../client";

// ---------------------------------------------------------------------------
// Select shape
// ---------------------------------------------------------------------------

const testCaseListSelect = {
	id: true,
	identifier: true,
	title: true,
	state: true,
	priority: true,
	ownerId: true,
	tags: true,
	automationStatus: true,
	// The ref itself, not just the intent enum: the row's "automated" affordance
	// and the ref-backed automation stat both key on a ref being PRESENT, which
	// automationStatus alone cannot tell them.
	automationRef: true,
	// Denormalized current run result — backs the list Result pill +
	// the passing% stat strip without a per-row history read.
	currentResult: true,
	lastRunAt: true,
	lastRunSource: true,
	lastRunByLabel: true,
	order: true,
	externalId: true,
	externalUrl: true,
	externalMcpServerId: true,
	pmAutoSyncEnabled: true,
	lastPmSyncStatus: true,
	lastSyncedAt: true,
	contextId: true,
	createdById: true,
	createdAt: true,
	updatedAt: true,
	_count: { select: { steps: true, workItemLinks: true } },
	workItemLinks: {
		select: {
			userStoryId: true,
			acceptanceCriterionRefs: true,
			userStory: {
				select: { id: true, identifier: true, title: true, kind: true },
			},
		},
	},
} as const;

export type TestCaseListItem = Prisma.TestCaseGetPayload<{
	select: typeof testCaseListSelect;
}>;

// ---------------------------------------------------------------------------
// Filters, sort, and the list query
// ---------------------------------------------------------------------------

/**
 * The filter half of a cases-list query — every predicate that narrows WHICH
 * cases match, with no pagination/ordering. Shared verbatim by `listTestCases`
 * and `bulkMutateTestCases` so a "select all N matching" bulk action provably
 * hits exactly the rows the list showed: the two cannot drift because they
 * compile the same object through {@link buildTestCaseWhere}.
 */
export interface TestCaseFilter {
	search?: string;
	state?: TestCaseState;
	priority?: TestCasePriority;
	/** Match a single tag (array `has`). */
	tag?: string;
	/** Only cases linked to this feature/bug (work-item link). */
	linkedStoryId?: string;
	/** Only cases belonging to this test plan (join on TestPlanCase). */
	planId?: string;
	/** Automation intent. */
	automationStatus?: AutomationStatus;
	/** Denormalized current run result. */
	currentResult?: TestResult;
	/** `true` → only PM-linked cases (externalId set); `false` → only unlinked. */
	externalLinked?: boolean;
}

/**
 * Sort keys accepted by {@link listTestCases}. Ordering is applied in the DB, so
 * it holds across the WHOLE result set rather than the loaded page.
 */
export const TEST_CASE_SORT_KEYS = [
	"order",
	"priority",
	"recentRun",
	"title",
] as const;
export type TestCaseSortKey = (typeof TEST_CASE_SORT_KEYS)[number];
export type TestCaseSortDirection = "asc" | "desc";

/**
 * The direction each key sorts by when the caller doesn't pick one — chosen so
 * the default view matches what a reader expects (most urgent / most recent
 * first, but alphabetical and manual order ascending).
 */
export const TEST_CASE_SORT_DEFAULT_DIRECTION: Record<
	TestCaseSortKey,
	TestCaseSortDirection
> = {
	order: "asc",
	priority: "desc",
	recentRun: "desc",
	title: "asc",
};

export interface ListTestCasesOptions extends TestCaseFilter {
	projectId: string;
	sort?: TestCaseSortKey;
	direction?: TestCaseSortDirection;
	limit?: number;
	offset?: number;
	/**
	 * Also return `summary` — project/filter-level tallies (state mix, automation,
	 * results) computed under the OTHER active filters (search/priority/tag/…) but
	 * INDEPENDENT of the `state` filter itself. Powers the redesigned segmented
	 * All/Ready/Draft/Closed counts AND the stat strip, both of which must be
	 * correct across pagination (they can't be tallied from a single loaded page).
	 * Off by default so internal callers (coverage lookups, etc.) don't pay for
	 * the extra aggregates.
	 */
	includeSummary?: boolean;
}

/**
 * Filter-aware, state-independent tallies for the cases-list stat strip + the
 * segmented state control. `total` is the grand count under the active filters
 * (all states); every bucket is zero-filled so an empty group still renders a 0.
 */
export type TestCaseListSummary = {
	total: number;
	stateCounts: Record<TestCaseState, number>;
	/**
	 * Tally of the automationStatus INTENT enum, as set on each case. Drives the
	 * automation breakdown; deliberately NOT the automation-% numerator — see
	 * {@link TestCaseListSummary.automatedWithRefCount}.
	 */
	automationCounts: Record<AutomationStatus, number>;
	/**
	 * The automation-% numerator: cases that are AUTOMATED *and* actually carry
	 * an `automationRef`. Narrower than `automationCounts.AUTOMATED`, because a
	 * case can be marked AUTOMATED with no ref (an older import, or intent set
	 * ahead of the link) and must not inflate the stat. Denominator is `total`.
	 */
	automatedWithRefCount: number;
	/**
	 * The CI-run-coverage numerator: cases whose latest result came from a
	 * PIPELINE run — i.e. actually exercised by real CI, not just marked
	 * automated or marked by hand. Deliberately separate from
	 * {@link TestCaseListSummary.automatedWithRefCount}: "we linked a test" and
	 * "a pipeline actually ran it" are different gaps, and conflating them hides
	 * automation that never executes. Denominator is `total`.
	 */
	pipelineCoveredCount: number;
	resultCounts: Record<TestResult, number>;
};

/**
 * Compile a {@link TestCaseFilter} into a Prisma `where`. The single source of
 * truth for "which cases match" — every caller that needs the matching set
 * (list, summary tallies, bulk-by-filter) goes through here, so a bulk action
 * over "all N matching" provably hits the rows the list rendered.
 *
 * `state` is part of the filter and is applied HERE. The one caller that needs
 * a state-independent set — the summary tallies, which must stay stable no
 * matter which state tab is active — says so explicitly by omitting it. Leaving
 * `state` for callers to re-layer made it a duty every call site had to
 * remember, and dropping it silently widened a bulk mutation from one state tab
 * to the whole project.
 */
export function buildTestCaseWhere(
	projectId: string,
	filter: TestCaseFilter,
): Prisma.TestCaseWhereInput {
	return {
		projectId,
		deletedAt: null,
		...(filter.state ? { state: filter.state } : {}),
		...(filter.priority ? { priority: filter.priority } : {}),
		...(filter.tag ? { tags: { has: filter.tag } } : {}),
		...(filter.linkedStoryId
			? { workItemLinks: { some: { userStoryId: filter.linkedStoryId } } }
			: {}),
		...(filter.planId
			? { planLinks: { some: { planId: filter.planId } } }
			: {}),
		...(filter.automationStatus
			? { automationStatus: filter.automationStatus }
			: {}),
		...(filter.currentResult
			? { currentResult: filter.currentResult }
			: {}),
		...(filter.externalLinked === undefined
			? {}
			: filter.externalLinked
				? { externalId: { not: null } }
				: { externalId: null }),
		...(filter.search
			? {
					OR: [
						{
							title: {
								contains: filter.search,
								mode: "insensitive",
							},
						},
						{
							identifier: {
								contains: filter.search,
								mode: "insensitive",
							},
						},
						{
							description: {
								contains: filter.search,
								mode: "insensitive",
							},
						},
					],
				}
			: {}),
	};
}

/**
 * Map a sort key + direction onto a Prisma `orderBy`.
 *
 * Every sort is tie-broken by `identifier` so the ordering is TOTAL. Without a
 * tiebreak, rows sharing a key (e.g. a project where every case is MEDIUM) have
 * no defined order between them, and Postgres is free to return them
 * differently per query — so a paging reader could see the same row twice, or
 * miss one entirely, as `offset` advances.
 *
 * `lastRunAt` nulls sort LAST in both directions: a never-run case has no run
 * date at all, so it belongs at the bottom whether the reader asked for newest
 * or oldest first (Postgres would otherwise put NULLs first on DESC).
 */
function buildTestCaseOrderBy(
	sort: TestCaseSortKey,
	direction: TestCaseSortDirection,
): Prisma.TestCaseOrderByWithRelationInput[] {
	const tiebreak = { identifier: "asc" } as const;
	switch (sort) {
		case "priority":
			return [{ priority: direction }, tiebreak];
		case "recentRun":
			return [
				{ lastRunAt: { sort: direction, nulls: "last" } },
				tiebreak,
			];
		case "title":
			return [{ title: direction }, tiebreak];
		case "order":
			return [{ order: direction }, tiebreak];
		default: {
			const exhaustive: never = sort;
			return exhaustive;
		}
	}
}

export async function listTestCases(options: ListTestCasesOptions): Promise<{
	items: TestCaseListItem[];
	total: number;
	summary?: TestCaseListSummary;
}> {
	const {
		projectId,
		sort = "order",
		direction = TEST_CASE_SORT_DEFAULT_DIRECTION[sort],
		limit = 100,
		offset = 0,
		includeSummary = false,
		...filter
	} = options;

	const where = buildTestCaseWhere(projectId, filter);
	// The tallies are deliberately state-INDEPENDENT: they feed the segmented
	// All/Ready/Draft/Closed counts, which must not collapse to the tab you are
	// already standing on. Dropping `state` is the only difference from `where`.
	const baseWhere = buildTestCaseWhere(projectId, {
		...filter,
		state: undefined,
	});

	const [items, total, summaryRows] = await Promise.all([
		db.testCase.findMany({
			where,
			orderBy: buildTestCaseOrderBy(sort, direction),
			take: limit,
			skip: offset,
			select: testCaseListSelect,
		}),
		db.testCase.count({ where }),
		includeSummary
			? Promise.all([
					db.testCase.groupBy({
						by: ["state"],
						where: baseWhere,
						_count: { _all: true },
					}),
					db.testCase.groupBy({
						by: ["automationStatus"],
						where: baseWhere,
						_count: { _all: true },
					}),
					db.testCase.groupBy({
						by: ["currentResult"],
						where: baseWhere,
						_count: { _all: true },
					}),
					// Counted in the DB rather than derived from the groupBy above:
					// "automated" for the stat means AUTOMATED *and* ref-backed, a
					// conjunction the automationStatus tally cannot express.
					db.testCase.count({
						where: {
							...baseWhere,
							automationStatus: "AUTOMATED",
							automationRef: { not: null },
						},
					}),
					// CI-run coverage: cases whose latest result actually came
					// from a pipeline. Distinct from automation % — a case can be
					// marked automated (intent + ref) and still never have been
					// exercised by a real run, which is the gap this surfaces.
					db.testCase.count({
						where: { ...baseWhere, lastRunSource: "PIPELINE" },
					}),
				])
			: Promise.resolve(null),
	]);

	if (!summaryRows) {
		return { items, total };
	}
	const [
		stateRows,
		automationRows,
		resultRows,
		automatedWithRefCount,
		pipelineCoveredCount,
	] = summaryRows;
	// Zero-fill so an empty bucket still renders a "0" (groupBy omits empties).
	const stateCounts: Record<TestCaseState, number> = {
		PROPOSED: 0,
		DRAFT: 0,
		READY: 0,
		CLOSED: 0,
	};
	let summaryTotal = 0;
	for (const row of stateRows) {
		stateCounts[row.state] = row._count._all;
		summaryTotal += row._count._all;
	}
	const automationCounts: Record<AutomationStatus, number> = {
		NOT_AUTOMATED: 0,
		PLANNED: 0,
		AUTOMATED: 0,
	};
	for (const row of automationRows) {
		automationCounts[row.automationStatus] = row._count._all;
	}
	const resultCounts: Record<TestResult, number> = {
		NOT_RUN: 0,
		PASSED: 0,
		FAILED: 0,
		BLOCKED: 0,
		SKIPPED: 0,
	};
	for (const row of resultRows) {
		resultCounts[row.currentResult] = row._count._all;
	}
	return {
		items,
		total,
		summary: {
			total: summaryTotal,
			stateCounts,
			automationCounts,
			automatedWithRefCount,
			pipelineCoveredCount,
			resultCounts,
		},
	};
}
