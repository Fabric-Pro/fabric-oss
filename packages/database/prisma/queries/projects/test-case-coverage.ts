/**
 * Per-feature test-coverage rollup — the BATCHED sibling of
 * `countTestCasesForStory` (see `./test-cases`).
 *
 * Where that helper answers "how many live cases test THIS story", this one
 * answers the same question for a whole page of stories at once, plus the
 * result mix and AC-reference tally each row needs. It backs two readers: a
 * features/coverage list, and a type-ahead feature picker that shows a coverage
 * count per option on projects with hundreds of features.
 *
 * Tenant isolation mirrors `test-cases.ts`: `UserStory` carries no tenant
 * columns of its own (it is project-owned), so `projectId` IS the tenant
 * boundary here — enforced by RLS + the procedure layer's
 * `requireProjectPermission`. Every query below is project-scoped on BOTH sides
 * of the join (the story and the linked case), so a link that somehow crossed
 * projects still can't drag a foreign case's result into a row.
 */

import {
	db,
	type FeatureDraftingStage,
	type MaturationStatus,
	type Prisma,
	type StoryKind,
	type TestResult,
} from "../../client";
import { normalizeStoryIdentifierQuery } from "./normalize-story-identifier-query";

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/** A feature is COVERED once at least one live case tests it. */
export type FeatureCoverageState = "COVERED" | "UNCOVERED";

export interface FeatureCoverageRow {
	storyId: string;
	identifier: string;
	title: string;
	kind: StoryKind;
	/**
	 * The story's stage as the ROADMAP means it: `draftingStage`. Deliberately
	 * NOT the `ProjectStoryStatus` relation — that is the Kanban board's status
	 * concept, and the roadmap's stage column renders `draftingStage`.
	 */
	draftingStage: FeatureDraftingStage;
	/**
	 * Null on legacy / non-V2 rows, where the reader derives a label from
	 * `draftingStage`. Carried because the roadmap's stage cell swaps to this
	 * chip under the Maturation-V2 flag — a reader that mirrors the roadmap
	 * needs both, and this costs nothing (same row, no join).
	 */
	maturationStatus: MaturationStatus | null;
	/**
	 * The story sits in a status the project flagged `isFinal` — done/closed.
	 * `ProjectStoryStatus` is the Kanban concept, deliberately separate from
	 * `draftingStage` above: a reader that hides finished work hides by THIS.
	 */
	closed: boolean;
	/**
	 * Live (`deletedAt: null`) cases linked to this story. Equals the sum of
	 * `resultCounts` by construction: each live case contributes exactly one
	 * `currentResult`, and `@@unique([testCaseId, userStoryId])` means a case
	 * can link to a story only once.
	 */
	caseCount: number;
	/**
	 * Linked live cases bucketed by their denormalized `currentResult`. Raw
	 * counts, every bucket zero-filled (a `groupBy` omits empties) — mirrors the
	 * `TestCaseListSummary.resultCounts` convention.
	 *
	 * Deriving a pass rate from these is the READER's job, and the product has
	 * exactly one definition of that rate — `TestResultRollup` in `./test-cases`
	 * (`computePlanPassRate` / `computePlanPassRates`):
	 *
	 *     executed = caseCount - resultCounts.NOT_RUN - resultCounts.SKIPPED
	 *     passRate = executed > 0 ? resultCounts.PASSED / executed : 0
	 *
	 * Passed over *executed*, not over total, so a feature whose cases have
	 * never been run reads 0% rather than a misleading 100%. Do not derive it
	 * any other way.
	 */
	resultCounts: Record<TestResult, number>;
	/**
	 * How many DISTINCT non-empty `acceptanceCriterionRef` values this story's
	 * links carry.
	 *
	 * This is a count of what testers actually referenced — NOT a ratio against
	 * the story's acceptance criteria. `UserStory.acceptanceCriteria` is free
	 * text with no shape validation and no parser anywhere in the repo, and
	 * `acceptanceCriterionRef` is an unvalidated free-text field, so any "X of N
	 * criteria covered" would be a heuristic guess wearing the costume of a
	 * precise metric. This number is countable and honest; there is no PARTIAL
	 * coverage state for the same reason.
	 */
	distinctAcRefs: number;
	coverageState: FeatureCoverageState;
}

/**
 * How the page is ranked.
 *
 * `STABLE` is the default because a reader paging a list needs the total order
 * to hold still underneath it. `UNCOVERED_FIRST` is what a picker wants: it is
 * offering somewhere to aim, so the untested work comes first.
 */
export type FeatureCoverageOrder = "STABLE" | "UNCOVERED_FIRST";

export interface ListFeatureCoverageOptions {
	projectId: string;
	/** Match against identifier + title. Legacy `F-`/`B-` prefixes normalized. */
	search?: string;
	/** Narrow to FEATURE or BUG. Omit for both — callers choose their default. */
	kind?: StoryKind;
	/** Only features with zero live linked cases. */
	uncoveredOnly?: boolean;
	/**
	 * Drop stories sitting in a status flagged `isFinal`. Omit for every status
	 * — callers choose their default, same as `kind`. A picker excludes them
	 * (you rarely write a test for finished work); a coverage report does not.
	 */
	excludeClosed?: boolean;
	/** Defaults to `STABLE`. */
	order?: FeatureCoverageOrder;
	limit?: number;
	offset?: number;
}

// ---------------------------------------------------------------------------
// Shared predicates
// ---------------------------------------------------------------------------

/**
 * What counts as a case that covers a story: live, and in the same project.
 *
 * Shared by the `uncoveredOnly` filter and the tally read below so the two can
 * never disagree — otherwise a row could be filtered in as "uncovered" and then
 * tallied with a caseCount of 1.
 */
function coveringCaseFilter(projectId: string): Prisma.TestCaseWhereInput {
	return { projectId, deletedAt: null };
}

/** The two halves of a project's features, split on the SAME predicate. */
type CoverageBucket = "UNCOVERED" | "COVERED";

/**
 * Restrict to one side of the coverage split.
 *
 * Built from `coveringCaseFilter` like everything else here, so a row's bucket
 * and its tallied `caseCount` can never disagree: an UNCOVERED-bucket row is
 * matched by the same "live case in this project" test the tally then counts
 * with, so it always tallies to zero.
 */
function coverageBucketFilter(
	projectId: string,
	bucket: CoverageBucket,
): Prisma.UserStoryWhereInput {
	const testCase = coveringCaseFilter(projectId);
	return bucket === "UNCOVERED"
		? { testCaseLinks: { none: { testCase } } }
		: { testCaseLinks: { some: { testCase } } };
}

function buildStoryWhere(
	options: ListFeatureCoverageOptions,
	bucket?: CoverageBucket,
): Prisma.UserStoryWhereInput {
	const { projectId, search, kind, uncoveredOnly, excludeClosed } = options;

	// `uncoveredOnly` IS the uncovered bucket, so it wins rather than both
	// landing in one WHERE — `none` and `some` in the same clause would match
	// nothing.
	const coverage: CoverageBucket | undefined = uncoveredOnly
		? "UNCOVERED"
		: bucket;

	// Normalize legacy prefixes (`F-`/`B-`/`US-`/`TASK-`) off the needle so a
	// typed `F-12` matches both a legacy `F-012` row AND a new plain-decimal
	// `12` row. Raw + normalized are OR'd against identifier (raw keeps legacy
	// matches, normalized catches new ones); title matches the raw needle only.
	// Same construction as `listStories` in `./stories`.
	const normalizedSearch = search
		? normalizeStoryIdentifierQuery(search)
		: undefined;

	return {
		projectId,
		// Exclude stories a duplicate-merge discarded: `mergedIntoStoryId` is a
		// tombstone pointing at the survivor, so the row is not a feature anyone
		// can meaningfully cover — reporting it as UNCOVERED would invent work,
		// and offering it in the picker would link a case to a dead duplicate.
		// The merge also stamps stage CLOSED, but that is a hideable display
		// state the reader can toggle back on; this is the structural guard.
		mergedIntoStoryId: null,
		...(kind ? { kind } : {}),
		// `statusId` is required on every story, so "not closed" needs no null
		// arm — there is no story without a status to account for.
		...(excludeClosed ? { status: { isFinal: false } } : {}),
		...(coverage ? coverageBucketFilter(projectId, coverage) : {}),
		...(search
			? {
					OR: [
						{ title: { contains: search, mode: "insensitive" } },
						{
							identifier: {
								contains: search,
								mode: "insensitive",
							},
						},
						...(normalizedSearch && normalizedSearch !== search
							? [
									{
										identifier: {
											contains: normalizedSearch,
											mode: "insensitive" as const,
										},
									},
								]
							: []),
					],
				}
			: {}),
	};
}

const featureCoverageStorySelect = {
	id: true,
	identifier: true,
	title: true,
	kind: true,
	draftingStage: true,
	maturationStatus: true,
	status: { select: { isFinal: true } },
} as const;

type CoverageStoryRow = Prisma.UserStoryGetPayload<{
	select: typeof featureCoverageStorySelect;
}>;

/**
 * Stable paging order. `createdAt` approximates identifier order without
 * string-sorting it (identifiers are allocated monotonically with creation, so
 * "10" never sorts before "9" the way the raw string would). `identifier` is
 * UNIQUE per project, so it tiebreaks into a TOTAL order — without that, rows
 * sharing a createdAt have no defined order between them and a paging reader
 * could see one twice, or miss one, as `offset` advances.
 */
const STABLE_ORDER: Prisma.UserStoryOrderByWithRelationInput[] = [
	{ createdAt: "asc" },
	{ identifier: "asc" },
];

/**
 * Rank WITHIN a coverage bucket: what the team touched most recently first.
 * `identifier` only has to make the order total and repeatable for rows sharing
 * a timestamp — it sorts as a string, which is why it is the tiebreak and not a
 * ranking key of its own.
 *
 * KNOWN LIMITATION: this compound order is not the same ranking as
 * `lastEditedAt ?? createdAt` — it places every edited feature above every
 * never-edited one, so a feature created today can sort below one last touched
 * years ago. Correcting it needs the partitioned read in
 * `story-activity-ranking.ts`, which this bucketed pager cannot use directly
 * because each bucket is already its own capped query.
 *
 * `createdAt desc` sits between them because the previous key here was
 * `updatedAt`, which is never null — so ties were rare and `identifier` was a
 * sufficient tiebreak. `lastEditedAt` IS null for every feature nobody has
 * edited, and with `nulls: "last"` that whole group ties. Falling straight to
 * `identifier` would order it by a string rather than by recency, which on a
 * backlog where most features are unedited is the majority of the list.
 */
const RECENT_FIRST: Prisma.UserStoryOrderByWithRelationInput[] = [
	{ lastEditedAt: { sort: "desc", nulls: "last" } },
	{ createdAt: "desc" },
	{ identifier: "asc" },
];

function emptyResultCounts(): Record<TestResult, number> {
	return { NOT_RUN: 0, PASSED: 0, FAILED: 0, BLOCKED: 0, SKIPPED: 0 };
}

/**
 * One page of stories in the requested rank.
 *
 * `STABLE` is a plain ordered page. `UNCOVERED_FIRST` cannot be, and the reason
 * is worth stating: `caseCount` is tallied in memory AFTER the page is chosen,
 * so sorting a fetched page by it would rank an arbitrary window rather than
 * the result set — the top of a picker would depend on which rows happened to
 * be fetched. Postgres can't be handed the rank directly either: Prisma's
 * relation `_count` orderBy takes no filter, so it would count links to
 * soft-deleted cases and rank rows into a bucket their own `caseCount`
 * contradicts.
 *
 * So the buckets are read in rank order and paged as if they were one
 * concatenated list: the uncovered bucket answers the offset first, and the
 * covered bucket fills whatever room the page has left. Postgres orders and
 * paginates each bucket, so the result matches a single ORDER BY over the union
 * — for a bounded number of queries (one per bucket, not one per story).
 */
async function selectStoryPage(
	options: ListFeatureCoverageOptions,
	limit: number,
	offset: number,
): Promise<CoverageStoryRow[]> {
	if (options.order !== "UNCOVERED_FIRST") {
		return db.userStory.findMany({
			where: buildStoryWhere(options),
			orderBy: STABLE_ORDER,
			take: limit,
			skip: offset,
			select: featureCoverageStorySelect,
		});
	}

	// `uncoveredOnly` has already narrowed the whole result set to one bucket:
	// there is nothing to fall through to, and reading the covered bucket would
	// hand back the very rows the caller filtered out.
	const buckets: CoverageBucket[] = options.uncoveredOnly
		? ["UNCOVERED"]
		: ["UNCOVERED", "COVERED"];

	const rows: CoverageStoryRow[] = [];
	let skip = offset;
	for (const bucket of buckets) {
		if (rows.length >= limit) {
			break;
		}
		const where = buildStoryWhere(options, bucket);
		if (skip > 0) {
			// A bucket the page starts past contributes only its size, so count
			// it rather than reading rows that get thrown away.
			const size = await db.userStory.count({ where });
			if (skip >= size) {
				skip -= size;
				continue;
			}
		}
		rows.push(
			...(await db.userStory.findMany({
				where,
				orderBy: RECENT_FIRST,
				take: limit - rows.length,
				skip,
				select: featureCoverageStorySelect,
			})),
		);
		skip = 0;
	}
	return rows;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Coverage rollup for one page of a project's features.
 *
 * A FIXED number of queries, regardless of page size — never one per feature:
 *
 *   1. the page of stories (see `selectStoryPage`: one read under the default
 *      order, one per coverage bucket under `UNCOVERED_FIRST`),
 *   2. `count` for the same predicate (drives pagination),
 *   3. ONE `findMany` over the link table for every story id on the page.
 *
 * Step 3 is the whole point. It is shaped exactly like `computePlanPassRates`
 * (`./test-cases`): read the link rows joined to their case's `currentResult`,
 * then tally per parent in memory. A `groupBy` can't replace it — Prisma groups
 * only by the model's OWN scalars, and the two things being tallied
 * (`testCase.currentResult`, on the far side of the join, and DISTINCT
 * `acceptanceCriterionRef`) don't both live on `TestCaseWorkItemLink`. Reading
 * the links once yields caseCount, the result mix, AND the AC-ref tally in a
 * single pass, so the alternative — a groupBy per story, or a count per story —
 * would be N+1 for exactly zero benefit.
 *
 * Rows are paginated FIRST so step 3's `IN` list is bounded by `limit`, not by
 * the project's feature count.
 *
 * Every story on the page is present in the result: a feature with no live
 * linked cases maps to an all-zero, UNCOVERED row, not a missing entry.
 */
export async function listFeatureCoverage(
	options: ListFeatureCoverageOptions,
): Promise<{ items: FeatureCoverageRow[]; total: number }> {
	const { projectId, limit = 100, offset = 0 } = options;

	const [stories, total] = await Promise.all([
		selectStoryPage(options, limit, offset),
		// Counted with no bucket: the total spans the whole result set however
		// the page above was ranked.
		db.userStory.count({ where: buildStoryWhere(options) }),
	]);

	if (stories.length === 0) {
		return { items: [], total };
	}

	const links = await db.testCaseWorkItemLink.findMany({
		where: {
			userStoryId: { in: stories.map((s) => s.id) },
			testCase: coveringCaseFilter(projectId),
		},
		select: {
			userStoryId: true,
			acceptanceCriterionRefs: true,
			testCase: { select: { currentResult: true } },
		},
	});

	const counts = new Map<string, Record<TestResult, number>>();
	const acRefs = new Map<string, Set<string>>();
	for (const link of links) {
		let byResult = counts.get(link.userStoryId);
		if (!byResult) {
			byResult = emptyResultCounts();
			counts.set(link.userStoryId, byResult);
		}
		byResult[link.testCase.currentResult] += 1;

		// Every reference on the link, not just the first: a case covering AC 1
		// and AC 3 proves two criteria, and counting one under-reports what the
		// suite actually does.
		//
		// Trimmed before counting, because these are free-text boxes and a
		// whitespace-only value is a blank somebody left behind rather than a
		// reference. The Set below already handles the other half — one case
		// naming the same criterion twice must not count it twice.
		for (const raw of link.acceptanceCriterionRefs) {
			const ref = raw.trim();
			if (!ref) {
				continue;
			}
			let refs = acRefs.get(link.userStoryId);
			if (!refs) {
				refs = new Set();
				acRefs.set(link.userStoryId, refs);
			}
			refs.add(ref);
		}
	}

	const items = stories.map((story): FeatureCoverageRow => {
		const resultCounts = counts.get(story.id) ?? emptyResultCounts();
		const caseCount =
			resultCounts.NOT_RUN +
			resultCounts.PASSED +
			resultCounts.FAILED +
			resultCounts.BLOCKED +
			resultCounts.SKIPPED;
		return {
			storyId: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
			draftingStage: story.draftingStage,
			maturationStatus: story.maturationStatus,
			closed: story.status.isFinal,
			caseCount,
			resultCounts,
			distinctAcRefs: acRefs.get(story.id)?.size ?? 0,
			coverageState: caseCount >= 1 ? "COVERED" : "UNCOVERED",
		};
	});

	return { items, total };
}
