/**
 * Queries for TestCaseDraftJob — the durable ledger of one "draft test cases
 * with AI" run.
 *
 * Drafting N features is N multi-second LLM calls, so it runs in a Temporal
 * workflow rather than on the request thread. This row is what makes that
 * durable: the dialog closes the moment the job is created, and the run outlives
 * the page. A client rediscovers an in-flight run by querying this table for the
 * project (see `listTestCaseDraftJobs`) — never by remembering a workflow id,
 * which a reload would lose.
 *
 * Reads scope by `projectId`; the calling procedure gates project access. The
 * `organizationId`/`userId` columns are denormalized from the parent Project for
 * RLS and cascade delete, mirroring TestCase.
 */

import { db } from "../../client";
import type { TestCaseDraftJob } from "../../generated/client";
import type {
	TestCaseDraftJobStatus,
	TestCasePriority,
	TestCaseState,
} from "../../generated/enums";

/**
 * Why a requested feature did or didn't produce cases. Every requested story
 * gets exactly one of these, so a partially-successful run is fully explainable
 * — one feature failing never aborts the others.
 */
export type TestCaseDraftFeatureOutcomeStatus =
	/** Cases were drafted and persisted. */
	| "DRAFTED"
	/** The feature has no acceptance criteria — nothing falsifiable to test. */
	| "NO_ACCEPTANCE_CRITERIA"
	/** No AI provider is configured for this tenant. */
	| "NO_AI_PROVIDER"
	/** The model ran but produced nothing usable. */
	| "NO_CASES"
	/** The story id didn't resolve inside this project. */
	| "NOT_FOUND"
	/** The generation call itself failed (billing, rate limit, upstream). */
	| "FAILED";

/**
 * One feature's result within a run.
 *
 * Declared as a type alias rather than an interface on purpose: TypeScript only
 * grants an implicit index signature to type aliases, which is what lets this be
 * handed to a Prisma `Json` column directly instead of laundering it through an
 * `as unknown as InputJsonValue` cast.
 */
export type TestCaseDraftFeatureOutcome = {
	storyId: string;
	/** Snapshot so the results view reads correctly even if the feature moves. */
	storyIdentifier: string;
	storyTitle: string;
	status: TestCaseDraftFeatureOutcomeStatus;
	/** Cases this feature produced. Empty for every non-DRAFTED status. */
	caseIds: string[];
	/** Present only for FAILED — the reason, already bounded by the caller. */
	error?: string;
};

const FEATURE_OUTCOME_STATUSES: readonly TestCaseDraftFeatureOutcomeStatus[] = [
	"DRAFTED",
	"NO_ACCEPTANCE_CRITERIA",
	"NO_AI_PROVIDER",
	"NO_CASES",
	"NOT_FOUND",
	"FAILED",
];

function isOutcomeStatus(
	value: unknown,
): value is TestCaseDraftFeatureOutcomeStatus {
	return (
		typeof value === "string" &&
		FEATURE_OUTCOME_STATUSES.some((status) => status === value)
	);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

/**
 * Narrow one stored ledger entry back to its type. Rows are written by this
 * module alone, but `Json` is `unknown` at the type level, so the shape is
 * re-checked on read rather than asserted — a malformed entry is dropped instead
 * of crashing the results view.
 */
function parseFeatureOutcome(
	value: unknown,
): TestCaseDraftFeatureOutcome | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record: Record<string, unknown> = { ...value };
	if (
		typeof record.storyId !== "string" ||
		typeof record.storyIdentifier !== "string" ||
		typeof record.storyTitle !== "string" ||
		!isOutcomeStatus(record.status) ||
		!isStringArray(record.caseIds)
	) {
		return null;
	}
	return {
		storyId: record.storyId,
		storyIdentifier: record.storyIdentifier,
		storyTitle: record.storyTitle,
		status: record.status,
		caseIds: record.caseIds,
		...(typeof record.error === "string" ? { error: record.error } : {}),
	};
}

/** Read a job's ledger back as typed outcomes, dropping anything malformed. */
export function parseFeatureOutcomes(
	value: TestCaseDraftJob["featureOutcomes"],
): TestCaseDraftFeatureOutcome[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const parsed: TestCaseDraftFeatureOutcome[] = [];
	for (const entry of value) {
		const outcome = parseFeatureOutcome(entry);
		if (outcome) {
			parsed.push(outcome);
		}
	}
	return parsed;
}

export async function createTestCaseDraftJob(input: {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	requestedById: string;
	storyIds: string[];
}): Promise<TestCaseDraftJob> {
	return await db.testCaseDraftJob.create({
		data: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			requestedById: input.requestedById,
			storyIds: input.storyIds,
			totalFeatures: input.storyIds.length,
			status: "PENDING",
		},
	});
}

/**
 * How long a PENDING/RUNNING row keeps blocking new runs over its features.
 *
 * A job row can stay active forever when the worker never picks it up or dies
 * mid-run (the row is only advanced by activities), and cancel is
 * requester-scoped — without a cutoff one stuck row would block drafting these
 * features for EVERYONE in the project, permanently. Anything older than the
 * worst legitimate run (5 features × 10-min activity ceiling, plus queue
 * slack) no longer blocks.
 */
export const STALE_ACTIVE_DRAFT_JOB_MS = 60 * 60 * 1000;

/**
 * Atomically claim a drafting run over `storyIds`, or report which of them are
 * already covered by an active job.
 *
 * The overlap check and the create run in ONE transaction, serialized per
 * project by a `pg_advisory_xact_lock` — a truly concurrent pair of claims for
 * the same feature can no longer both pass the check and both create (the
 * check-then-create used to live in the calling procedure as two separate
 * statements, leaving a ~request-latency window that billed duplicate
 * generations AND appended duplicate cases). The second claimant blocks on the
 * lock until the first commits, then sees its committed row.
 *
 * Checked across ALL requesters, not just the caller: two people
 * double-drafting the same feature duplicates all the same.
 */
export async function claimTestCaseDraftJob(input: {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	requestedById: string;
	storyIds: string[];
}): Promise<
	| { job: TestCaseDraftJob; blockedStoryIds?: never }
	| { job?: never; blockedStoryIds: string[] }
> {
	return await db.$transaction(async (tx) => {
		// Advisory xact locks release at commit/rollback — no manual unlock, no
		// leak on a thrown error. Keyed on (namespace, projectId) so unrelated
		// projects practically never queue behind each other (a hashtext(projectId)
		// int32 collision costs a few-ms wait, nothing more). The ::text cast is
		// for Prisma, which cannot deserialize the function's `void` return.
		await tx.$queryRaw`SELECT (pg_advisory_xact_lock(hashtext('test-case-draft-claim'), hashtext(${input.projectId})))::text`;

		const activeJobs = await tx.testCaseDraftJob.findMany({
			where: {
				projectId: input.projectId,
				status: { in: ["PENDING", "RUNNING"] },
				createdAt: {
					gte: new Date(Date.now() - STALE_ACTIVE_DRAFT_JOB_MS),
				},
			},
			select: { storyIds: true },
		});
		const activeStoryIds = new Set(
			activeJobs.flatMap((job) => job.storyIds),
		);
		const blockedStoryIds = input.storyIds.filter((id) =>
			activeStoryIds.has(id),
		);
		if (blockedStoryIds.length > 0) {
			return { blockedStoryIds };
		}

		const job = await tx.testCaseDraftJob.create({
			data: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				requestedById: input.requestedById,
				storyIds: input.storyIds,
				totalFeatures: input.storyIds.length,
				status: "PENDING",
			},
		});
		return { job };
	});
}

/**
 * Stamp the workflow id once dispatch succeeds. Scoped to PENDING so a late
 * stamp can't write onto a job that already finished or was cancelled.
 */
export async function setTestCaseDraftJobWorkflowId(params: {
	jobId: string;
	workflowId: string;
}): Promise<void> {
	await db.testCaseDraftJob.updateMany({
		where: { id: params.jobId, status: "PENDING" },
		data: { workflowId: params.workflowId },
	});
}

/**
 * PENDING → RUNNING. Compare-and-set: returns false when the job was cancelled
 * before the worker picked it up, which tells the workflow to stop.
 */
export async function markTestCaseDraftJobRunning(
	jobId: string,
): Promise<boolean> {
	const res = await db.testCaseDraftJob.updateMany({
		where: { id: jobId, status: "PENDING" },
		data: { status: "RUNNING", startedAt: new Date() },
	});
	return res.count === 1;
}

/**
 * Append one feature's outcome and advance the progress counter.
 *
 * The whole read-modify-write runs under a row lock. The workflow drafts
 * features one at a time, so the *happy* path has a single writer — but a
 * timed-out Temporal attempt is not stopped, it is merely superseded, so a
 * stalled attempt can still be holding a read when its replacement writes.
 * Without the lock that zombie would then write absolute values computed from
 * its stale read, silently erasing a later feature's case ids.
 *
 * Returns false when the job is no longer RUNNING (cancelled mid-flight), so the
 * caller can stop rather than resurrect a terminal row.
 */
export async function recordTestCaseDraftFeatureOutcome(params: {
	jobId: string;
	outcome: TestCaseDraftFeatureOutcome;
}): Promise<boolean> {
	return db.$transaction(async (tx) => {
		// Serialize writers on this row for the rest of the transaction. A
		// second attempt blocks here and therefore reads the first one's result
		// rather than racing it.
		await tx.$executeRaw`
			SELECT 1 FROM "test_case_draft_job" WHERE "id" = ${params.jobId} FOR UPDATE
		`;

		const job = await tx.testCaseDraftJob.findUnique({
			where: { id: params.jobId },
			select: {
				status: true,
				featureOutcomes: true,
				createdCaseIds: true,
			},
		});
		if (!job || job.status !== "RUNNING") {
			return false;
		}

		const prior = parseFeatureOutcomes(job.featureOutcomes);
		// One outcome per feature, keyed on the story. The status check only
		// rejects a *terminal* job — it cannot tell a retry from a first
		// attempt. Temporal's classic failure mode is "write committed,
		// completion report lost", so a blind append would record the same
		// feature twice: the ledger would count 2/1 features processed and the
		// completion notification would promise twice the cases that exist.
		if (prior.some((o) => o.storyId === params.outcome.storyId)) {
			return true;
		}

		const outcomes = [...prior, params.outcome];

		const res = await tx.testCaseDraftJob.updateMany({
			where: { id: params.jobId, status: "RUNNING" },
			data: {
				featureOutcomes: outcomes,
				createdCaseIds: [
					...job.createdCaseIds,
					...params.outcome.caseIds,
				],
				processedFeatures: outcomes.length,
			},
		});
		return res.count === 1;
	});
}

/**
 * Land the terminal state. Compare-and-set on RUNNING so a result arriving after
 * a cancel is dropped. Returns the finished row, or null when the write was
 * dropped.
 */
export async function completeTestCaseDraftJob(params: {
	jobId: string;
	status: Extract<TestCaseDraftJobStatus, "SUCCEEDED" | "FAILED">;
	error?: string | null;
}): Promise<TestCaseDraftJob | null> {
	const res = await db.testCaseDraftJob.updateMany({
		where: { id: params.jobId, status: "RUNNING" },
		data: {
			status: params.status,
			error: params.error ? params.error.slice(0, 4000) : null,
			completedAt: new Date(),
		},
	});
	if (res.count !== 1) {
		return null;
	}
	return await db.testCaseDraftJob.findUnique({
		where: { id: params.jobId },
	});
}

/**
 * Fail a job that never got as far as RUNNING (dispatch failure). Scoped to the
 * non-terminal states so it can't overwrite a real outcome.
 */
export async function failTestCaseDraftJob(params: {
	jobId: string;
	error: string;
}): Promise<void> {
	await db.testCaseDraftJob.updateMany({
		where: { id: params.jobId, status: { in: ["PENDING", "RUNNING"] } },
		data: {
			status: "FAILED",
			error: params.error.slice(0, 4000),
			completedAt: new Date(),
		},
	});
}

/**
 * Mark a non-terminal job CANCELLED and hand back its workflow id so the caller
 * can cancel the Temporal run (best-effort abort of the in-flight generation).
 * Returns null when there was nothing live to cancel.
 */
export async function cancelTestCaseDraftJob(params: {
	jobId: string;
	projectId: string;
}): Promise<{ workflowId: string | null } | null> {
	const job = await db.testCaseDraftJob.findFirst({
		where: { id: params.jobId, projectId: params.projectId },
		select: { status: true, workflowId: true },
	});
	if (!job || (job.status !== "PENDING" && job.status !== "RUNNING")) {
		return null;
	}
	// Carries `projectId` as well as the id: the read above is project-scoped, so
	// the write must be too, rather than relying on the id having been checked a
	// moment ago.
	const res = await db.testCaseDraftJob.updateMany({
		where: {
			id: params.jobId,
			projectId: params.projectId,
			status: { in: ["PENDING", "RUNNING"] },
		},
		data: { status: "CANCELLED", completedAt: new Date() },
	});
	if (res.count !== 1) {
		return null; // lost the race to a terminal transition
	}
	return { workflowId: job.workflowId };
}

/** One job, scoped to its project so a cross-project id resolves to null. */
export async function getTestCaseDraftJob(params: {
	jobId: string;
	projectId: string;
}): Promise<TestCaseDraftJob | null> {
	return await db.testCaseDraftJob.findFirst({
		where: { id: params.jobId, projectId: params.projectId },
	});
}

/**
 * The rediscovery read. Returns this requester's recent runs for the project,
 * newest first — the client calls it on mount to re-attach to a run that was
 * started before a reload.
 */
export async function listTestCaseDraftJobs(params: {
	projectId: string;
	requestedById: string;
	statuses?: TestCaseDraftJobStatus[];
	limit?: number;
}): Promise<TestCaseDraftJob[]> {
	return await db.testCaseDraftJob.findMany({
		where: {
			projectId: params.projectId,
			requestedById: params.requestedById,
			...(params.statuses ? { status: { in: params.statuses } } : {}),
		},
		orderBy: { startedAt: "desc" },
		take: params.limit ?? 10,
	});
}

/**
 * One drafting run in a feature's run history, shaped for the QA tab. */
export interface TestCaseDraftRunSummary {
	id: string;
	status: TestCaseDraftJobStatus;
	totalFeatures: number;
	processedFeatures: number;
	/** How many cases the run persisted (0 for cancelled/failed). */
	createdCount: number;
	error: string | null;
	requestedByName: string | null;
	createdAt: string;
	startedAt: string | null;
	completedAt: string | null;
}

/**
 * Every drafting run that covered one feature, newest first — the QA tab's
 * per-feature run history.
 *
 * Unlike `listTestCaseDraftJobs` (the caller's own in-flight runs), this is
 * project-wide across ALL requesters: a feature's history is about the feature,
 * not who happened to run it. `storyIds` is a `String[]` column, so the filter
 * is a `has`. Ordered by `createdAt` (not `startedAt`) so a run that was
 * cancelled before the worker picked it up — and therefore never started —
 * still appears in the history in the right place.
 */
export async function listTestCaseDraftJobsForStory(params: {
	projectId: string;
	storyId: string;
	limit?: number;
	offset?: number;
}): Promise<{ runs: TestCaseDraftRunSummary[]; total: number }> {
	const where = {
		projectId: params.projectId,
		storyIds: { has: params.storyId },
	};
	const [rows, total] = await Promise.all([
		db.testCaseDraftJob.findMany({
			where,
			// Stable tiebreaker — see listTestCaseActivity: an unbroken tie
			// makes offset paging drop or repeat rows at a page boundary.
			orderBy: [{ createdAt: "desc" }, { id: "desc" }],
			take: params.limit ?? 20,
			skip: params.offset ?? 0,
			include: { requestedBy: { select: { name: true } } },
		}),
		db.testCaseDraftJob.count({ where }),
	]);
	const runs = rows.map((row) => ({
		id: row.id,
		status: row.status,
		totalFeatures: row.totalFeatures,
		processedFeatures: row.processedFeatures,
		createdCount: row.createdCaseIds.length,
		error: row.error,
		requestedByName: row.requestedBy?.name ?? null,
		createdAt: row.createdAt.toISOString(),
		startedAt: row.startedAt?.toISOString() ?? null,
		completedAt: row.completedAt?.toISOString() ?? null,
	}));
	return { runs, total };
}

/** A case a run produced, shaped for the results view. */
export type TestCaseDraftJobResultCase = {
	id: string;
	identifier: string;
	title: string;
	// The real enums, not strings — the results view renders these straight into
	// the shared state/priority chips, which are typed on them.
	state: TestCaseState;
	priority: TestCasePriority;
	stepCount: number;
	coverage: Array<{
		storyIdentifier: string;
		storyTitle: string;
		acceptanceCriterionRefs: string[];
	}>;
};

/**
 * The cases a run created, in creation order, with just enough to review a batch
 * without opening each one: what it is, its state and priority, how many steps
 * it has, and which criterion it covers.
 *
 * Scoped by BOTH the job's recorded ids and the project — the ids come from the
 * job row, but re-asserting the project means a stale or tampered id can never
 * read a case from another project. Deleted cases fall out naturally.
 */
export async function getTestCaseDraftJobResultCases(params: {
	projectId: string;
	caseIds: string[];
}): Promise<TestCaseDraftJobResultCase[]> {
	if (params.caseIds.length === 0) {
		return [];
	}
	const cases = await db.testCase.findMany({
		where: {
			id: { in: params.caseIds },
			projectId: params.projectId,
			deletedAt: null,
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			state: true,
			priority: true,
			_count: { select: { steps: true } },
			workItemLinks: {
				select: {
					acceptanceCriterionRefs: true,
					userStory: { select: { identifier: true, title: true } },
				},
			},
		},
		orderBy: { order: "asc" },
	});
	return cases.map((testCase) => ({
		id: testCase.id,
		identifier: testCase.identifier,
		title: testCase.title,
		state: testCase.state,
		priority: testCase.priority,
		stepCount: testCase._count.steps,
		coverage: testCase.workItemLinks.map((link) => ({
			storyIdentifier: link.userStory.identifier,
			storyTitle: link.userStory.title,
			acceptanceCriterionRefs: link.acceptanceCriterionRefs,
		})),
	}));
}
