/**
 * Test Case run results — the append-only history, the denormalized current, and
 * the pass-rate rollups computed from it.
 *
 * Its own module because the result trail is a separate write path from
 * authoring: a result write never touches a case's authored content, only its
 * `currentResult` + `lastRun*` mirror. {@link resolveActorLabel} is shared with
 * the bulk SET_RESULT writer, which is why it is exported rather than private.
 * Sibling of `test-cases.ts` behind the same barrel.
 */

import {
	db,
	type Prisma,
	type ResultSource,
	type TestResult,
} from "../../client";

// ---------------------------------------------------------------------------
// Run results — append-only history + denormalized current
// ---------------------------------------------------------------------------
//
// Every result change (manual mark OR PM-sync ingest) appends one immutable
// `TestResultEvent` row and refreshes the parent case's denormalized current
// (`currentResult` + `lastRun*`) inside the same transaction, so the fast list
// render never disagrees with history. History rows are NEVER deleted — a reset
// appends a NOT_RUN event rather than destroying the trail.

/**
 * Provenance shape for a single history row: the result + source, who set it
 * (Fabric user for MANUAL, `actorLabel` for PM_SYNC), the optional plan run it
 * belongs to, the external run ref/link, and the note + timestamps.
 */
const testResultEventSelect = {
	id: true,
	testCaseId: true,
	result: true,
	source: true,
	occurredAt: true,
	changedByUserId: true,
	actorLabel: true,
	testPlanId: true,
	externalRunRef: true,
	externalRunUrl: true,
	note: true,
	createdAt: true,
	changedByUser: {
		select: { id: true, name: true, email: true, image: true },
	},
	testPlan: { select: { id: true, identifier: true, name: true } },
} as const;

/** Denormalized current-result view returned after a result write. */
const testCaseResultSelect = {
	id: true,
	projectId: true,
	identifier: true,
	title: true,
	currentResult: true,
	lastRunAt: true,
	lastRunSource: true,
	lastRunByLabel: true,
} as const;

export type TestResultEventListItem = Prisma.TestResultEventGetPayload<{
	select: typeof testResultEventSelect;
}>;

export type TestCaseResultView = Prisma.TestCaseGetPayload<{
	select: typeof testCaseResultSelect;
}> & { event: TestResultEventListItem };

/**
 * Resolve the human label stamped onto the denormalized `lastRunByLabel`.
 * Prefer an explicit `actorLabel` (PM_SYNC provenance, e.g. "Azure DevOps · run
 * 4821"); otherwise fall back to the acting Fabric user's display (name → email)
 * so a manual mark reads "who changed result"; else null.
 */
export async function resolveActorLabel(
	client: Prisma.TransactionClient | typeof db,
	input: { actorLabel?: string | null; changedByUserId?: string | null },
): Promise<string | null> {
	if (input.actorLabel) {
		return input.actorLabel;
	}
	if (input.changedByUserId) {
		const user = await client.user.findUnique({
			where: { id: input.changedByUserId },
			select: { name: true, email: true },
		});
		return user?.name ?? user?.email ?? null;
	}
	return null;
}

export interface RecordTestCaseResultInput {
	testCaseId: string;
	result: TestResult;
	source: ResultSource;
	/** Fabric user who set the result (MANUAL). Null/omitted for PM_SYNC. */
	changedByUserId?: string | null;
	/** PM_SYNC provenance label; overrides the resolved user display. */
	actorLabel?: string | null;
	/** The plan run this result belongs to (null = ad-hoc). */
	testPlanId?: string | null;
	externalRunRef?: string | null;
	externalRunUrl?: string | null;
	note?: string | null;
}

/**
 * Append a result event and refresh the parent case's denormalized current — in
 * ONE transaction so list/history never diverge. Guards the case is live
 * (returns null when missing/soft-deleted; the procedure maps that to
 * NOT_FOUND). Returns the updated case with the new event nested.
 *
 * PM_SYNC ingestion calls this directly with an `actorLabel` +
 * `externalRunRef/url`; the `recordResult` procedure calls it for MANUAL marks.
 */
export async function recordTestCaseResult(
	input: RecordTestCaseResultInput,
): Promise<TestCaseResultView | null> {
	return db.$transaction(async (tx) => {
		const existing = await tx.testCase.findFirst({
			where: { id: input.testCaseId, deletedAt: null },
			select: { id: true },
		});
		if (!existing) {
			return null;
		}

		const label = await resolveActorLabel(tx, {
			actorLabel: input.actorLabel,
			changedByUserId: input.changedByUserId,
		});
		const now = new Date();

		const event = await tx.testResultEvent.create({
			data: {
				testCaseId: input.testCaseId,
				result: input.result,
				source: input.source,
				occurredAt: now,
				changedByUserId: input.changedByUserId ?? null,
				actorLabel: input.actorLabel ?? null,
				testPlanId: input.testPlanId ?? null,
				externalRunRef: input.externalRunRef ?? null,
				externalRunUrl: input.externalRunUrl ?? null,
				note: input.note ?? null,
			},
			select: testResultEventSelect,
		});

		const testCase = await tx.testCase.update({
			where: { id: input.testCaseId },
			data: {
				currentResult: input.result,
				lastRunAt: now,
				lastRunSource: input.source,
				lastRunByLabel: label,
			},
			select: testCaseResultSelect,
		});

		return { ...testCase, event };
	});
}

export interface ResetProjectTestResultsInput {
	projectId: string;
	organizationId: string | null;
	changedByUserId: string;
}

/**
 * Reset every live case in the project whose current result is not already
 * NOT_RUN: append a MANUAL NOT_RUN event (attributed to the resetter) and set
 * the denormalized current back to NOT_RUN — in one transaction. Prior history
 * is preserved (a reset only appends). Tenant XOR (org vs personal) mirrors the
 * other project-scoped queries. Returns the number of cases reset (0 when there
 * was nothing to reset).
 */
export async function resetProjectTestResults(
	input: ResetProjectTestResultsInput,
): Promise<{ reset: number }> {
	return db.$transaction(async (tx) => {
		const cases = await tx.testCase.findMany({
			where: {
				projectId: input.projectId,
				deletedAt: null,
				currentResult: { not: "NOT_RUN" },
				...(input.organizationId
					? { organizationId: input.organizationId }
					: { organizationId: null }),
			},
			select: { id: true },
		});
		if (cases.length === 0) {
			return { reset: 0 };
		}

		const label = await resolveActorLabel(tx, {
			changedByUserId: input.changedByUserId,
		});
		const now = new Date();
		const ids = cases.map((c) => c.id);

		const events: Prisma.TestResultEventCreateManyInput[] = ids.map(
			(id) => ({
				testCaseId: id,
				result: "NOT_RUN",
				source: "MANUAL",
				occurredAt: now,
				changedByUserId: input.changedByUserId,
			}),
		);
		await tx.testResultEvent.createMany({ data: events });

		await tx.testCase.updateMany({
			where: { id: { in: ids } },
			data: {
				currentResult: "NOT_RUN",
				lastRunAt: now,
				lastRunSource: "MANUAL",
				lastRunByLabel: label,
			},
		});

		return { reset: ids.length };
	});
}

/**
 * The append-only result history for a case, newest first, with provenance
 * joined in: the Fabric user who set it (id/name/email/image) and the plan run
 * (id/identifier/name). Powers the drawer's Runs history list.
 *
 * Paged like the other case histories: `total` is the untruncated count, so a
 * capped page is never mistaken for the whole history. This list has the
 * highest churn of the four — every PM run pull and every manual mark appends
 * an event — so it is the one that most needs a ceiling.
 */
export async function listTestCaseResultHistory(input: {
	testCaseId: string;
	limit?: number;
	offset?: number;
}): Promise<{ items: TestResultEventListItem[]; total: number }> {
	const where = { testCaseId: input.testCaseId };
	const [items, total] = await Promise.all([
		db.testResultEvent.findMany({
			where,
			// Stable tiebreaker — see listTestCaseActivity: an unbroken tie
			// makes offset paging drop or repeat rows at a page boundary.
			orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
			take: input.limit ?? 50,
			skip: input.offset ?? 0,
			select: testResultEventSelect,
		}),
		db.testResultEvent.count({ where }),
	]);
	return { items, total };
}

// ---------------------------------------------------------------------------
// Result rollups — plan pass-rate + project passing% for the stat strip
// ---------------------------------------------------------------------------

/**
 * Current-result tally for a set of cases. `passRate` is passed over *executed*
 * so a plan full of unrun cases reads 0% rather than a misleading 100%.
 *
 * A SKIPPED case is deliberately NOT executed: the suite chose not to run it, so
 * counting it in the denominator would drag the pass rate down for tests nobody
 * asked to run. It is excluded alongside notRun, and surfaced on its own so the
 * two reasons for "no result" stay distinguishable.
 */
export interface TestResultRollup {
	total: number;
	notRun: number;
	passed: number;
	failed: number;
	blocked: number;
	/** Deliberately skipped by the suite — not queued, not attempted. */
	skipped: number;
	/** total − notRun − skipped (cases that actually ran). */
	executed: number;
	/** passed / executed, in [0, 1]; 0 when nothing has been executed. */
	passRate: number;
}

function tallyResultRollup(
	rows: Array<{ result: TestResult; count: number }>,
): TestResultRollup {
	let notRun = 0;
	let passed = 0;
	let failed = 0;
	let blocked = 0;
	let skipped = 0;
	for (const { result, count } of rows) {
		switch (result) {
			case "PASSED":
				passed += count;
				break;
			case "FAILED":
				failed += count;
				break;
			case "BLOCKED":
				blocked += count;
				break;
			case "SKIPPED":
				skipped += count;
				break;
			default:
				notRun += count;
				break;
		}
	}
	const total = notRun + passed + failed + blocked + skipped;
	// Neither queued nor skipped cases ran, so neither belongs in the
	// denominator of "of the tests that ran, how many passed".
	const executed = total - notRun - skipped;
	return {
		total,
		notRun,
		passed,
		failed,
		blocked,
		skipped,
		executed,
		passRate: executed > 0 ? passed / executed : 0,
	};
}

/**
 * Pass-rate rollup for a plan, computed from its member cases' denormalized
 * `currentResult` (soft-deleted cases excluded). Cheap single `groupBy`.
 */
export async function computePlanPassRate(
	planId: string,
): Promise<TestResultRollup> {
	const rows = await db.testCase.groupBy({
		by: ["currentResult"],
		where: { deletedAt: null, planLinks: { some: { planId } } },
		_count: { _all: true },
	});
	return tallyResultRollup(
		rows.map((r) => ({ result: r.currentResult, count: r._count._all })),
	);
}

/**
 * Batched pass-rate rollups for many plans at once — ONE query over the plan↔case
 * link table (soft-deleted cases excluded), tallied per plan in memory. Use this
 * for a plans LIST (the card grid) instead of looping {@link computePlanPassRate},
 * which would be N+1. Every requested plan id is present in the result — a plan
 * with no live cases maps to an all-zero rollup (0% passing, not a missing entry).
 */
export async function computePlanPassRates(
	planIds: string[],
): Promise<Map<string, TestResultRollup>> {
	const result = new Map<string, TestResultRollup>();
	if (planIds.length === 0) {
		return result;
	}
	const links = await db.testPlanCase.findMany({
		where: { planId: { in: planIds }, testCase: { deletedAt: null } },
		select: { planId: true, testCase: { select: { currentResult: true } } },
	});
	const perPlan = new Map<string, Map<TestResult, number>>();
	for (const link of links) {
		let counts = perPlan.get(link.planId);
		if (!counts) {
			counts = new Map();
			perPlan.set(link.planId, counts);
		}
		const r = link.testCase.currentResult;
		counts.set(r, (counts.get(r) ?? 0) + 1);
	}
	// Zero-fill EVERY requested plan so the caller always gets a rollup.
	for (const planId of planIds) {
		const counts = perPlan.get(planId);
		const rows = counts
			? Array.from(counts, ([result, count]) => ({ result, count }))
			: [];
		result.set(planId, tallyResultRollup(rows));
	}
	return result;
}

export interface ComputeProjectResultRollupInput {
	projectId: string;
	organizationId?: string | null;
}

/**
 * Project-wide current-result rollup (counts + passing%) for the Cases stat
 * strip. Tenant XOR mirrors the other project-scoped queries; omit
 * `organizationId` to skip the tenant narrowing (project scope already isolates).
 */
export async function computeProjectResultRollup(
	input: ComputeProjectResultRollupInput,
): Promise<TestResultRollup> {
	const rows = await db.testCase.groupBy({
		by: ["currentResult"],
		where: {
			projectId: input.projectId,
			deletedAt: null,
			...(input.organizationId === undefined
				? {}
				: input.organizationId
					? { organizationId: input.organizationId }
					: { organizationId: null }),
		},
		_count: { _all: true },
	});
	return tallyResultRollup(
		rows.map((r) => ({ result: r.currentResult, count: r._count._all })),
	);
}
