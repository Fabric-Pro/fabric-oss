/**
 * Fabric-orchestrated test runs — the storage half of driving a browser through
 * a Fabric-authored test case against a live environment.
 *
 * **What is deliberately NOT here: writing results.** A finished run's per-case
 * verdicts go through {@link ingestPipelineRun} and {@link recordFindingsForRun},
 * the same two helpers CI ingestion uses, so linkage, findings, RCA, per-feature
 * scoping and the coverage rollup all work on an agentic run with no code that
 * knows it is one. Everything in this module is the envelope around that: the
 * dispatch record, its cost guard, and the per-step log that has no equivalent in
 * an ingested run.
 *
 * Cost is stored as `Decimal`, not `Float`. These are dollars shown to a customer
 * beside a refusal, and a cap that refuses at 4.999999999 because binary floating
 * point cannot hold 5.00 is an argument nobody should have to have.
 */

import type {
	AgenticRunStatus,
	AgenticStepStatus,
	ProjectEnvironmentType,
	QaRunMode,
} from "../../client";
// `Prisma` is imported as a VALUE, not a type: `Prisma.Decimal` is a
// constructor, and the money columns below are written through it.
import { db, Prisma } from "../../client";

/** Provider string every Fabric-orchestrated run is ingested under. */
export const AGENTIC_RUN_PROVIDER = "fabric-agentic";

/**
 * Dollar amounts crossing the API boundary as numbers.
 *
 * `Decimal` is right in the column and wrong on the wire: oRPC serialises it to
 * an object, which lands in the browser as `{s,e,d}` and renders as `[object
 * Object]`. Converted at exactly one place so no caller has to remember.
 */
function toUsd(value: Prisma.Decimal | null): number | null {
	return value === null ? null : value.toNumber();
}

export interface AgenticRunView {
	id: string;
	status: AgenticRunStatus;
	runMode: QaRunMode;
	workflowId: string | null;
	environmentId: string | null;
	targetBaseUrl: string;
	environmentType: ProjectEnvironmentType;
	estimatedCostUsd: number;
	costCapUsd: number;
	actualCostUsd: number | null;
	browser: string;
	resolution: string;
	caseCount: number;
	passedCount: number;
	failedCount: number;
	blockedCount: number;
	needsReviewCount: number;
	refusalReason: string | null;
	pipelineRunId: string | null;
	triggeredByUserId: string | null;
	startedAt: Date | null;
	finishedAt: Date | null;
	createdAt: Date;
	/** Display name of whoever dispatched it; null if that user is gone. */
	triggeredByActor: string | null;
}

const runSelect = {
	id: true,
	status: true,
	runMode: true,
	workflowId: true,
	environmentId: true,
	targetBaseUrl: true,
	environmentType: true,
	estimatedCostUsd: true,
	costCapUsd: true,
	actualCostUsd: true,
	browser: true,
	resolution: true,
	caseCount: true,
	passedCount: true,
	failedCount: true,
	blockedCount: true,
	needsReviewCount: true,
	refusalReason: true,
	pipelineRunId: true,
	triggeredByUserId: true,
	// The NAME, not just the id: the history has to say who ran something, and
	// a cuid tells a reader nothing. Selected as a relation so it costs one
	// join rather than a lookup per row.
	triggeredByUser: { select: { name: true, email: true } },
	startedAt: true,
	finishedAt: true,
	createdAt: true,
} as const;

type RunRow = Prisma.TestAgenticRunGetPayload<{ select: typeof runSelect }>;

function toView(row: RunRow): AgenticRunView {
	// The relation is flattened to a display string here rather than shipped as
	// a nested user object: the client needs a name, and sending the record
	// would put more of a user on the wire than the history has any use for.
	const { triggeredByUser, ...rest } = row;
	return {
		...rest,
		estimatedCostUsd: row.estimatedCostUsd.toNumber(),
		costCapUsd: row.costCapUsd.toNumber(),
		actualCostUsd: toUsd(row.actualCostUsd),
		triggeredByActor:
			triggeredByUser?.name?.trim() || triggeredByUser?.email || null,
	};
}

export interface CreateAgenticRunInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	environmentId: string | null;
	targetBaseUrl: string;
	environmentType: ProjectEnvironmentType;
	estimatedCostUsd: number;
	costCapUsd: number;
	browser: string;
	resolution: string;
	caseCount: number;
	triggeredByUserId: string;
	runMode: QaRunMode;
	/**
	 * Present only for a run that is being recorded as REFUSED. A refused run is
	 * still written: "we asked and were told no, for this reason, at this price"
	 * is the record that makes a cap arguable instead of mysterious.
	 */
	refusal?: { reason: string } | null;
}

export async function createAgenticRun(
	input: CreateAgenticRunInput,
): Promise<AgenticRunView> {
	const refused = input.refusal != null;
	const row = await db.testAgenticRun.create({
		data: {
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
			environmentId: input.environmentId,
			targetBaseUrl: input.targetBaseUrl,
			environmentType: input.environmentType,
			estimatedCostUsd: new Prisma.Decimal(input.estimatedCostUsd),
			costCapUsd: new Prisma.Decimal(input.costCapUsd),
			browser: input.browser,
			resolution: input.resolution,
			caseCount: input.caseCount,
			triggeredByUserId: input.triggeredByUserId,
			runMode: input.runMode,
			status: refused ? "REFUSED" : "QUEUED",
			refusalReason: input.refusal?.reason ?? null,
			// A refused run never ran, so it is finished the moment it exists.
			// Leaving `finishedAt` null would leave it rendering as in-flight
			// forever in any view that asks "is this still going".
			finishedAt: refused ? new Date() : null,
		},
		select: runSelect,
	});
	return toView(row);
}

/**
 * Attach the Temporal handle and move to RUNNING.
 *
 * Scoped by projectId as well as id — the same tenant guard every other QA write
 * uses, so a run id from another project matches nothing rather than being
 * driven by this project's workflow.
 */
export async function markAgenticRunStarted(input: {
	projectId: string;
	runId: string;
	workflowId: string;
}): Promise<boolean> {
	const { count } = await db.testAgenticRun.updateMany({
		// `status: "QUEUED"` in the WHERE makes this a claim, not a write: a run
		// already RUNNING or CANCELLED is not dragged back to RUNNING by a retried
		// dispatch. Temporal retries activities, so this WILL happen.
		where: {
			id: input.runId,
			projectId: input.projectId,
			status: "QUEUED",
		},
		data: {
			status: "RUNNING",
			workflowId: input.workflowId,
			startedAt: new Date(),
		},
	});
	return count > 0;
}

export interface FinishAgenticRunInput {
	projectId: string;
	runId: string;
	status: Extract<
		AgenticRunStatus,
		| "PASSED"
		| "FAILED"
		| "BLOCKED"
		| "CANCELLED"
		| "REFUSED"
		| "NEEDS_REVIEW"
	>;
	passedCount: number;
	failedCount: number;
	blockedCount: number;
	/** Optional so a caller written before the confidence gate still compiles. */
	needsReviewCount?: number;
	actualCostUsd: number;
	/** The ingested-shape run the results were grouped under. */
	pipelineRunId?: string | null;
	refusalReason?: string | null;
}

/**
 * Write the run's terminal state.
 *
 * The counts here are SET, not incremented, and that is deliberate: they are the
 * authoritative totals derived from every case result, and they overwrite whatever
 * `recordAgenticCaseProgress` accumulated during the run. Turning either of these
 * into the other's style would double-count.
 */
export async function finishAgenticRun(
	input: FinishAgenticRunInput,
): Promise<boolean> {
	const { count } = await db.testAgenticRun.updateMany({
		where: { id: input.runId, projectId: input.projectId },
		data: {
			status: input.status,
			passedCount: input.passedCount,
			failedCount: input.failedCount,
			blockedCount: input.blockedCount,
			needsReviewCount: input.needsReviewCount ?? 0,
			actualCostUsd: new Prisma.Decimal(input.actualCostUsd),
			pipelineRunId: input.pipelineRunId ?? null,
			refusalReason: input.refusalReason ?? null,
			finishedAt: new Date(),
		},
	});
	return count > 0;
}

/**
 * Mark a run cancelled. Only an in-flight run can be cancelled — asking to stop
 * one that already finished is a no-op rather than a rewrite of its verdict.
 */
export async function cancelAgenticRun(input: {
	projectId: string;
	runId: string;
}): Promise<{ cancelled: boolean; workflowId: string | null }> {
	const run = await db.testAgenticRun.findFirst({
		where: { id: input.runId, projectId: input.projectId },
		select: { workflowId: true, status: true },
	});
	if (!run || (run.status !== "QUEUED" && run.status !== "RUNNING")) {
		return { cancelled: false, workflowId: null };
	}
	const { count } = await db.testAgenticRun.updateMany({
		where: {
			id: input.runId,
			projectId: input.projectId,
			status: { in: ["QUEUED", "RUNNING"] },
		},
		data: { status: "CANCELLED", finishedAt: new Date() },
	});
	// The workflow handle is returned even when the row write lost a race, so the
	// caller can still ask Temporal to stop. A cancelled row with a live workflow
	// behind it is the worse of the two failure modes.
	return { cancelled: count > 0, workflowId: run.workflowId };
}

/**
 * Record one case's outcome AS IT FINISHES, so a run in flight reports progress.
 *
 * The full per-case results still land in one `ingestPipelineRun` at the end —
 * that call creates a single pipeline run and cannot be made per case. But the
 * COUNTERS can advance immediately, and without this they sat at zero for the
 * whole run and then jumped to final: a progress UI polling a backend that only
 * reported at the end.
 *
 * Increments rather than sets, so a retried activity cannot lose a sibling
 * case's result to a stale total.
 */
export async function recordAgenticCaseProgress(input: {
	projectId: string;
	runId: string;
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW";
}): Promise<void> {
	await db.testAgenticRun.updateMany({
		where: { id: input.runId, projectId: input.projectId },
		data:
			input.result === "PASSED"
				? { passedCount: { increment: 1 } }
				: input.result === "FAILED"
					? { failedCount: { increment: 1 } }
					: input.result === "NEEDS_REVIEW"
						? { needsReviewCount: { increment: 1 } }
						: { blockedCount: { increment: 1 } },
	});
}

/**
 * Close runs whose workflow stopped making progress.
 *
 * The deployment-wide QA sweep calls this periodically. `updatedAt` advances
 * with every completed case, so a long batched run stays live while a dead
 * workflow eventually becomes a visible BLOCKED run instead of polling forever.
 */
export async function reapStaleAgenticRuns(input?: {
	now?: Date;
	queuedMinutes?: number;
	runningMinutes?: number;
	limit?: number;
}): Promise<{ reaped: number }> {
	const now = input?.now ?? new Date();
	const queuedCutoff = new Date(
		now.getTime() - (input?.queuedMinutes ?? 15) * 60_000,
	);
	const runningCutoff = new Date(
		now.getTime() - (input?.runningMinutes ?? 45) * 60_000,
	);
	const rows = await db.testAgenticRun.findMany({
		where: {
			OR: [
				{ status: "QUEUED", createdAt: { lt: queuedCutoff } },
				{ status: "RUNNING", updatedAt: { lt: runningCutoff } },
			],
		},
		orderBy: { updatedAt: "asc" },
		take: Math.min(input?.limit ?? 200, 500),
		select: {
			id: true,
			status: true,
			caseCount: true,
			createdAt: true,
			updatedAt: true,
		},
	});
	if (rows.length === 0) {
		return { reaped: 0 };
	}

	const updates = await db.$transaction(
		rows.map((row) =>
			db.testAgenticRun.updateMany({
				where: {
					id: row.id,
					status: row.status,
					...(row.status === "QUEUED"
						? { createdAt: { lt: queuedCutoff } }
						: { updatedAt: { lt: runningCutoff } }),
				},
				data: {
					status: "BLOCKED",
					blockedCount: row.caseCount,
					actualCostUsd: new Prisma.Decimal(0),
					finishedAt: now,
				},
			}),
		),
	);
	return {
		reaped: updates.reduce((total, result) => total + result.count, 0),
	};
}

/** One case's staged outcome, as the runner produced it. */
export interface StagedAgenticCaseResult {
	testCaseId: string;
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW";
	failureMessage: string | null;
	durationMs: number;
	modelCalls: number;
	scriptRevisionId?: string | null;
	label: string | null;
	steps: unknown;
}

/**
 * Stage one batch's per-case results (spec F3).
 *
 * Batches cannot write to `TestResultEvent`, because that is created by
 * `ingestPipelineRun`, which is idempotent on
 * `(projectId, provider, externalRunId)` — calling it per batch would make every
 * batch after the first a no-op or a delete-and-recreate. These rows are the
 * staging area a single reconciling ingest drains at the end.
 *
 * `skipDuplicates` rather than an upsert: the unique key is `(runId,
 * testCaseId)` and a Temporal activity retry replays the SAME results, so
 * ignoring a row that already landed is exactly right — and cheaper than an
 * upsert per case.
 */
export async function stageAgenticCaseResults(input: {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	runId: string;
	results: StagedAgenticCaseResult[];
}): Promise<{ staged: number }> {
	if (input.results.length === 0) {
		return { staged: 0 };
	}
	const { count } = await db.testAgenticCaseResult.createMany({
		data: input.results.map((r) => ({
			runId: input.runId,
			testCaseId: r.testCaseId,
			result: r.result,
			failureMessage: r.failureMessage,
			durationMs: r.durationMs,
			modelCalls: r.modelCalls,
			scriptRevisionId: r.scriptRevisionId ?? null,
			label: r.label,
			steps: (r.steps ?? []) as Prisma.InputJsonValue,
			projectId: input.projectId,
			organizationId: input.organizationId,
			userId: input.userId,
		})),
		skipDuplicates: true,
	});
	return { staged: count };
}

/**
 * Every case staged for a run, oldest first — what the final ingest drains.
 *
 * Scoped by projectId as well as runId: the run id alone would be a tenant
 * boundary made of a guessable identifier.
 */
export async function listStagedAgenticCaseResults(input: {
	projectId: string;
	runId: string;
}): Promise<StagedAgenticCaseResult[]> {
	const rows = await db.testAgenticCaseResult.findMany({
		where: { runId: input.runId, projectId: input.projectId },
		orderBy: { createdAt: "asc" },
		select: {
			testCaseId: true,
			result: true,
			failureMessage: true,
			durationMs: true,
			modelCalls: true,
			scriptRevisionId: true,
			label: true,
			steps: true,
		},
	});
	return rows.map((r) => ({
		...r,
		result: r.result as "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW",
	}));
}

export async function getAgenticRun(input: {
	projectId: string;
	runId: string;
}): Promise<AgenticRunView | null> {
	const row = await db.testAgenticRun.findFirst({
		where: { id: input.runId, projectId: input.projectId },
		select: runSelect,
	});
	return row ? toView(row) : null;
}

export async function listAgenticRuns(input: {
	projectId: string;
	limit?: number;
}): Promise<AgenticRunView[]> {
	const rows = await db.testAgenticRun.findMany({
		where: { projectId: input.projectId },
		orderBy: { createdAt: "desc" },
		take: Math.min(input.limit ?? 25, 100),
		select: runSelect,
	});
	return rows.map(toView);
}

/**
 * The cases a run will execute, with their steps — the runner's input.
 *
 * Returns only cases that HAVE steps. An agentic run drives a browser through
 * `action` / `expected` pairs, so a case with none is not something this runner
 * can attempt; the caller reports those as skipped-with-a-reason rather than
 * dispatching a browser to do nothing and calling the result a pass.
 */
export async function listCasesForAgenticRun(input: {
	projectId: string;
	testCaseIds: string[];
	runMode?: QaRunMode;
	scriptRevisionIds?: Record<string, string>;
}): Promise<
	Array<{
		id: string;
		identifier: string;
		title: string;
		description: string | null;
		playwrightScript: string | null;
		scriptRevisionId: string | null;
		steps: Array<{ order: number; action: string; expected: string }>;
	}>
> {
	if (input.testCaseIds.length === 0) {
		return [];
	}
	const rows = await db.testCase.findMany({
		where: {
			id: { in: input.testCaseIds },
			projectId: input.projectId,
			deletedAt: null,
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			description: true,
			playwrightScript: true,
			scriptRevisions: {
				orderBy: { createdAt: "desc" },
				take: 1,
				select: { id: true },
			},
			steps: {
				orderBy: { order: "asc" },
				select: { order: true, action: true, expected: true },
			},
		},
	});
	return rows
		.map((row) => ({
			...row,
			scriptRevisionId:
				input.scriptRevisionIds?.[row.id] ??
				row.scriptRevisions[0]?.id ??
				null,
		}))
		.filter((row) =>
			input.runMode === "MODE_B"
				? input.scriptRevisionIds
					? Boolean(row.scriptRevisionId)
					: Boolean(
							row.playwrightScript?.trim() &&
								row.scriptRevisionId,
						)
				: row.steps.length > 0,
		);
}

export interface AgenticStepLogInput {
	order: number;
	action: string;
	expected: string;
	status: AgenticStepStatus;
	observation?: string | null;
	evidenceKey?: string | null;
}

/**
 * Attach per-step logs to the result events a run just wrote.
 *
 * Takes `pipelineRunId` + `testCaseId` rather than an event id because
 * `ingestPipelineRun` writes its events with `createMany`, which returns a count
 * and no ids. An agentic run produces exactly one event per case, so the pair
 * resolves to one row — an assumption that holds here and would NOT hold for an
 * ingested CI run, where one case can be covered by several tests. Stated
 * because it is the kind of thing that silently starts attaching logs to the
 * wrong event if this is ever reused for CI.
 */
export async function attachAgenticStepLogs(input: {
	pipelineRunId: string;
	perCase: Array<{ testCaseId: string; steps: AgenticStepLogInput[] }>;
}): Promise<{ attached: number }> {
	const withSteps = input.perCase.filter((c) => c.steps.length > 0);
	if (withSteps.length === 0) {
		return { attached: 0 };
	}

	const events = await db.testResultEvent.findMany({
		where: {
			pipelineRunId: input.pipelineRunId,
			testCaseId: { in: withSteps.map((c) => c.testCaseId) },
		},
		select: { id: true, testCaseId: true },
	});
	const eventByCase = new Map(events.map((e) => [e.testCaseId, e.id]));

	const rows = withSteps.flatMap((c) => {
		const eventId = eventByCase.get(c.testCaseId);
		// A case whose event is missing is dropped rather than guessed at. It
		// means the ingest was an idempotent no-op, so the events belong to the
		// earlier attempt and writing this attempt's steps onto them would blend
		// two runs into one timeline.
		if (!eventId) {
			return [];
		}
		return c.steps.map((s) => ({
			testResultEventId: eventId,
			order: s.order,
			action: s.action,
			expected: s.expected,
			status: s.status,
			observation: s.observation ?? null,
			evidenceKey: s.evidenceKey ?? null,
		}));
	});
	if (rows.length === 0) {
		return { attached: 0 };
	}
	await db.testAgenticStepLog.createMany({ data: rows });
	return { attached: rows.length };
}

export interface AgenticStepLogView {
	id: string;
	order: number;
	action: string;
	expected: string;
	status: AgenticStepStatus;
	observation: string | null;
	evidenceKey: string | null;
}

/**
 * The step-by-step log for one case's result — every step of a run, readable
 * from the test case it belongs to.
 */
export async function listAgenticStepLogs(input: {
	testResultEventId: string;
}): Promise<AgenticStepLogView[]> {
	return db.testAgenticStepLog.findMany({
		where: { testResultEventId: input.testResultEventId },
		orderBy: { order: "asc" },
		select: {
			id: true,
			order: true,
			action: true,
			expected: true,
			status: true,
			observation: true,
			evidenceKey: true,
		},
	});
}

/**
 * Who pressed the button, as a name a reader recognises.
 *
 * Agentic runs are ingested into the shared pipeline-run table, whose
 * `triggeredByActor` is a DISPLAY string (CI providers report a username, not a
 * Fabric user id). That field was never populated for Fabric's own runs, so a
 * history of them showed no author at all — the run knew `triggeredByUserId`
 * and simply never resolved it.
 *
 * Returns null rather than throwing when the user has been deleted: an
 * unattributed run is a fact worth recording, and losing the whole run record
 * because its author left is not.
 */
export async function resolveAgenticRunActor(
	runId: string,
): Promise<string | null> {
	const row = await db.testAgenticRun.findUnique({
		where: { id: runId },
		select: {
			triggeredByUser: { select: { name: true, email: true } },
		},
	});
	const user = row?.triggeredByUser;
	if (!user) {
		return null;
	}
	// Name first, email as the fallback — the email is always present and is
	// still recognisable, where a blank name would render as an empty "run by".
	return user.name?.trim() || user.email || null;
}

/**
 * One page of this project's agentic runs, newest first, with the total.
 *
 * `listAgenticRuns` takes the newest 25 and stops. That is fine as a preview and
 * wrong as the only way in: every run older than the newest 25 was simply
 * invisible, with nothing on screen admitting it — a silent truncation, which is
 * the worst kind because the list looks complete.
 *
 * Page and count share one `where`, resolved once, for the same reason
 * `listPipelineRunsPage` does it: two separately-built filters are how a scoped
 * page ends up paired with an unscoped total and the UI says "3 of 412".
 */
export async function listAgenticRunsPage(input: {
	projectId: string;
	limit: number;
	offset: number;
}): Promise<{ runs: AgenticRunView[]; total: number }> {
	const where = { projectId: input.projectId };

	const [rows, total] = await Promise.all([
		db.testAgenticRun.findMany({
			where,
			orderBy: { createdAt: "desc" },
			skip: Math.max(0, input.offset),
			take: Math.min(Math.max(1, input.limit), 100),
			select: runSelect,
		}),
		db.testAgenticRun.count({ where }),
	]);
	return { runs: rows.map(toView), total };
}
