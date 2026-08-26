/**
 * Pipeline-result ingestion + read.
 *
 * The write path ({@link ingestPipelineRun}) turns one CI/pipeline run and its
 * already-matched per-case results into durable rows: a `TestPipelineRun` parent
 * plus one PIPELINE `TestResultEvent` per matched case, refreshing each case's
 * denormalized current — all in a single transaction. The MATCHING itself (which
 * automated test maps to which case) happens upstream in the temporal ingest
 * activity via the hybrid linkage cascade; this module only persists the result.
 *
 * Ingestion is idempotent on `(projectId, provider, externalRunId)`: a run that
 * was already ingested is a no-op, so a retry or an overlapping incremental fetch
 * never double-appends history.
 */

import { db, type Prisma, type TestResult } from "../../client";
import type { RepositoryProvider } from "../../zod";
import { advisoryObjectKey } from "../lib/refresh-lock-key";
import { parseRepoUrl } from "../project-repository-integrations";
import { resolveAutomationLink } from "./automation-linkage";
import { isPipelineSyncDue } from "./pipeline-sync-schedule";

/** Human provider label for `actorLabel` provenance (e.g. "GitHub Actions · run 42"). */
const PROVIDER_LABELS: Record<string, string> = {
	"azure-devops": "Azure DevOps",
	"github-actions": "GitHub Actions",
	"gitlab-ci": "GitLab CI",
	"jira-xray": "Jira (Xray)",
};

export const PIPELINE_RUN_OUTCOMES = ["passed", "failed", "cancelled"] as const;
export type PipelineRunOutcome = (typeof PIPELINE_RUN_OUTCOMES)[number];

const CANCELLED_RUN_STATUSES = [
	"cancelled",
	"canceled",
	"aborted",
	"stale",
] as const;
const FAILED_RUN_STATUSES = [
	"failed",
	"failure",
	"timed_out",
	"startup_failure",
	"action_required",
	"error",
] as const;
const PASSED_RUN_STATUSES = ["passed", "success", "completed"] as const;

function providerLabel(provider: string): string {
	return PROVIDER_LABELS[provider] ?? provider;
}

function statusNotIn(
	statuses: readonly string[],
): Prisma.TestPipelineRunWhereInput {
	return {
		OR: [
			{ status: null },
			{ status: { notIn: [...statuses], mode: "insensitive" } },
		],
	};
}

function pipelineRunOutcomeWhere(
	outcome: PipelineRunOutcome,
): Prisma.TestPipelineRunWhereInput {
	switch (outcome) {
		case "cancelled":
			return {
				status: {
					in: [...CANCELLED_RUN_STATUSES],
					mode: "insensitive",
				},
			};
		case "failed":
			return {
				AND: [
					statusNotIn(CANCELLED_RUN_STATUSES),
					{
						OR: [
							{ failedCount: { gt: 0 } },
							{
								status: {
									in: [...FAILED_RUN_STATUSES],
									mode: "insensitive",
								},
							},
						],
					},
				],
			};
		case "passed":
			return {
				AND: [
					statusNotIn([
						...CANCELLED_RUN_STATUSES,
						...FAILED_RUN_STATUSES,
					]),
					{ failedCount: 0 },
					{
						OR: [
							{ passedCount: { gt: 0 } },
							{
								status: {
									in: [...PASSED_RUN_STATUSES],
									mode: "insensitive",
								},
							},
						],
					},
				],
			};
		default: {
			const unhandled: never = outcome;
			throw new Error(`Unhandled pipeline run outcome: ${unhandled}`);
		}
	}
}

/**
 * Denorm precedence when a single run covers one case with several tests: the
 * WORST result wins, so a passing test can never mask a failing one in the
 * fast-render `currentResult`. Per-test history keeps every result regardless.
 */
const RESULT_SEVERITY: Record<TestResult, number> = {
	NOT_RUN: 0,
	// A deliberate skip outranks "never ran" — it is a reported outcome — but
	// loses to PASSED: if any test for this case actually passed, that is the
	// more useful thing to show.
	SKIPPED: 1,
	PASSED: 2,
	BLOCKED: 3,
	FAILED: 4,
};

/**
 * Interactive-transaction budget for one run's ingest.
 *
 * Prisma's defaults are 5s / 2s, which a large suite exceeds: the throw leaves
 * the sync cursor un-advanced, so the next sync re-fetches the same run and
 * fails the same way — the source wedges permanently on one oversized run. The
 * per-test INSERTs are batched into a single `createMany` (below), which is the
 * real fix; this is the headroom for the per-case denormalization that follows,
 * which is one statement per DISTINCT case and cannot be batched (each carries
 * its own latest-wins guard).
 */
const INGEST_TRANSACTION_OPTIONS = { timeout: 120_000, maxWait: 10_000 };

/**
 * Hard ceiling on the candidate set the linkage cascade matches against.
 *
 * An order of magnitude above `MAX_CASES_PER_RUN` (500). Not a paging limit — a
 * blast radius. See {@link listLinkableCases} for why truncation here is worse
 * than truncation anywhere else on this surface.
 */
const LINKABLE_CASE_CEILING = 5_000;

/** One result already resolved to a Fabric case by the linkage cascade. */
export interface MatchedPipelineResult {
	testCaseId: string;
	result: TestResult;
	/** Exact immutable Mode B artifact; null/omitted for external and Mode A runs. */
	scriptRevisionId?: string | null;
	/** The automated test's name — provenance in the event note. */
	testName: string;
	/** Which cascade tier matched (tag > path > title) — recorded for transparency. */
	matchTier: "tag" | "path" | "title";
}

/**
 * One test's outcome within a run, denormalized onto `TestPipelineRun.results`
 * (JSON) so the in-portal run-detail view renders the full per-test breakdown —
 * matched AND unmatched — without per-test rows. `matchedCaseId` is set when the
 * linkage cascade resolved this test to a Fabric case.
 */
export interface PipelineRunTestRecord {
	name: string;
	classname?: string | null;
	/** Provider-native token retained for diagnostics (for example "timed_out"). */
	rawStatus?: string | null;
	status: TestResult;
	failureMessage?: string | null;
	durationMs?: number | null;
	matchedCaseId?: string | null;
	matchTier?: "tag" | "path" | "title" | null;
	scriptRevisionId?: string | null;
}

export interface IngestPipelineRunInput {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	run: {
		provider: string;
		externalRunId: string;
		pipelineName?: string | null;
		branch?: string | null;
		commitSha?: string | null;
		runUrl?: string | null;
		status?: string | null;
		startedAt?: Date | null;
		finishedAt?: Date | null;
		durationMs?: number | null;
		/** The person who triggered the run on the provider (GitHub/GitLab/ADO). */
		triggeredByActor?: string | null;
		triggeredByActorAvatarUrl?: string | null;
		/** Aggregate counts over ALL tests in the run (matched + unmatched). */
		totalCount: number;
		passedCount: number;
		failedCount: number;
		skippedCount: number;
		otherCount: number;
	};
	/** Results the cascade resolved to a case (drives per-case history + denorm). */
	matched: MatchedPipelineResult[];
	/** Results that matched no case — a count only; nothing is written for them. */
	unmatchedCount: number;
	/**
	 * Every test in the run (matched + unmatched), denormalized onto the run for
	 * the detail view. Optional so an existing caller that didn't compute it still
	 * ingests (the run just has no stored per-test breakdown).
	 */
	results?: PipelineRunTestRecord[];
}

export interface IngestPipelineRunResult {
	pipelineRunId: string;
	matched: number;
	unmatched: number;
	/** True when the run was already ingested — nothing was written this call. */
	alreadyIngested: boolean;
}

/**
 * Has this external run id come back with a DIFFERENT outcome than the one we
 * stored — i.e. is it a re-run rather than the same fetch seen twice?
 *
 * Compared on what a re-run actually changes: the provider's own status, when it
 * finished, and the result tally. A genuinely identical re-fetch matches on all
 * of them and is skipped, which is what keeps the common path cheap.
 */
function isNewAttempt(
	stored: {
		status: string | null;
		finishedAt: Date | null;
		totalCount: number;
		passedCount: number;
		failedCount: number;
	},
	run: IngestPipelineRunInput["run"],
): boolean {
	const finishedAtChanged =
		(stored.finishedAt?.getTime() ?? null) !==
		(run.finishedAt?.getTime() ?? null);
	return (
		stored.status !== (run.status ?? null) ||
		finishedAtChanged ||
		stored.totalCount !== run.totalCount ||
		stored.passedCount !== run.passedCount ||
		stored.failedCount !== run.failedCount
	);
}

/**
 * Ingest one run + its matched results. Idempotent on
 * `(projectId, provider, externalRunId)` UNLESS the provider re-ran it — see
 * {@link isNewAttempt}. Per-case history is append-only; the
 * denormalized current is refreshed with LATEST-WINS semantics — a run only
 * overwrites a case's `currentResult` when its result is at least as recent as
 * the case's last recorded run, so a stale re-ingest never clobbers a newer
 * manual or pipeline result.
 */
export async function ingestPipelineRun(
	input: IngestPipelineRunInput,
): Promise<IngestPipelineRunResult> {
	const { run } = input;
	const occurredAt = run.finishedAt ?? run.startedAt ?? new Date();
	// Provenance label — enriched with the human who triggered the run when the
	// provider gave us one ("GitHub Actions · run 42 · by alice").
	const actorLabel = run.triggeredByActor
		? `${providerLabel(run.provider)} · run ${run.externalRunId} · by ${run.triggeredByActor}`
		: `${providerLabel(run.provider)} · run ${run.externalRunId}`;

	return db.$transaction(async (tx) => {
		// Idempotency: a run we've already ingested must not re-append history.
		//
		// But "same external id" does NOT mean "same execution". GitHub's
		// "Re-run all jobs" keeps `workflow_run.id` (only `run_attempt`
		// increments) and GitLab's "Retry pipeline" keeps the pipeline id, so a
		// flaky test that fails, opens a bug, and then passes on a re-run kept
		// its case FAILED and that bug open forever. A row whose outcome has
		// moved on is a NEW attempt and must be re-ingested.
		const existing = await tx.testPipelineRun.findUnique({
			where: {
				projectId_provider_externalRunId: {
					projectId: input.projectId,
					provider: run.provider,
					externalRunId: run.externalRunId,
				},
			},
			select: {
				id: true,
				status: true,
				finishedAt: true,
				totalCount: true,
				passedCount: true,
				failedCount: true,
			},
		});
		if (existing && !isNewAttempt(existing, run)) {
			return {
				pipelineRunId: existing.id,
				matched: 0,
				unmatched: 0,
				alreadyIngested: true,
			};
		}
		if (existing) {
			// A re-run replaces the run row in place — the id is the provider's,
			// so a second row is not an option — and then falls through to the
			// normal path, which appends fresh events and re-derives each case's
			// current result. The old attempt's events stay: the test really did
			// run twice, and the history should say so.
			await tx.testPipelineRun.delete({ where: { id: existing.id } });
		}

		const pipelineRun = await tx.testPipelineRun.create({
			data: {
				projectId: input.projectId,
				organizationId: input.organizationId,
				userId: input.userId,
				provider: run.provider,
				externalRunId: run.externalRunId,
				pipelineName: run.pipelineName ?? null,
				branch: run.branch ?? null,
				commitSha: run.commitSha ?? null,
				runUrl: run.runUrl ?? null,
				status: run.status ?? null,
				startedAt: run.startedAt ?? null,
				finishedAt: run.finishedAt ?? null,
				durationMs: run.durationMs ?? null,
				triggeredByActor: run.triggeredByActor ?? null,
				triggeredByActorAvatarUrl:
					run.triggeredByActorAvatarUrl ?? null,
				results: input.results
					? (input.results as unknown as Prisma.InputJsonValue)
					: undefined,
				totalCount: run.totalCount,
				passedCount: run.passedCount,
				failedCount: run.failedCount,
				skippedCount: run.skippedCount,
				otherCount: run.otherCount,
			},
			select: { id: true },
		});

		// History: one immutable event per matched test — the full per-test trail
		// is kept, so a case covered by several automated tests shows each result.
		//
		// ONE round trip, not one per test. A monorepo suite matching a few
		// thousand tests used to issue that many sequential INSERTs inside this
		// transaction; at a 2-3ms round trip it blew Prisma's 5s interactive
		// timeout, the throw left the cursor un-advanced, and the next sync
		// re-fetched the same run and failed identically — wedging the source
		// permanently on one oversized run.
		if (input.matched.length > 0) {
			await tx.testResultEvent.createMany({
				data: input.matched.map((m) => ({
					testCaseId: m.testCaseId,
					result: m.result,
					source: "PIPELINE" as const,
					occurredAt,
					actorLabel,
					externalRunRef: run.externalRunId,
					externalRunUrl: run.runUrl ?? null,
					scriptRevisionId: m.scriptRevisionId ?? null,
					pipelineRunId: pipelineRun.id,
					note: `${m.testName} (${m.matchTier} match)`,
				})),
			});
		}

		// Denorm ONCE per case with the WORST result in this run (a case may be
		// covered by several tests; a passing one must not mask a failing one).
		// Latest-wins is guarded by `lte occurredAt`; the WHERE re-scopes by
		// project (a belt-and-suspenders tenant guard on the write) + live case.
		const worstByCase = new Map<string, TestResult>();
		for (const m of input.matched) {
			const prev = worstByCase.get(m.testCaseId);
			if (
				prev === undefined ||
				RESULT_SEVERITY[m.result] > RESULT_SEVERITY[prev]
			) {
				worstByCase.set(m.testCaseId, m.result);
			}
		}
		for (const [testCaseId, result] of worstByCase) {
			await tx.testCase.updateMany({
				where: {
					id: testCaseId,
					projectId: input.projectId,
					deletedAt: null,
					OR: [
						{ lastRunAt: null },
						{ lastRunAt: { lte: occurredAt } },
					],
				},
				data: {
					currentResult: result,
					lastRunAt: occurredAt,
					lastRunSource: "PIPELINE",
					lastRunByLabel: actorLabel,
				},
			});
		}

		return {
			pipelineRunId: pipelineRun.id,
			matched: input.matched.length,
			unmatched: input.unmatchedCount,
			alreadyIngested: false,
		};
	}, INGEST_TRANSACTION_OPTIONS);
}

/**
 * The candidate cases a run's results are matched against. Only the
 * fields the hybrid linkage cascade reads — kept narrow, live cases only. Scoped
 * by projectId: a project belongs to exactly one tenant, so every case (and run)
 * under it shares that tenant; the caller's project access is the boundary.
 */
export async function listLinkableCases(input: { projectId: string }) {
	const cases = await db.testCase.findMany({
		where: {
			projectId: input.projectId,
			deletedAt: null,
		},
		select: {
			id: true,
			identifier: true,
			title: true,
			automationRef: true,
			automationFilePath: true,
		},
		// Bounded, but deliberately far above any real project: this runs on the
		// ingest hot path AND the read path, and was previously unbounded.
		//
		// A cap is dangerous here in a way it is not elsewhere — silently dropping
		// candidates does not fail, it MIS-LINKS: a test whose case fell off the
		// end matches nothing, reads as untracked, and coverage quietly drops.
		// That is why the ceiling is an order of magnitude above the 500-case run
		// limit and why hitting it is logged rather than swallowed. If this ever
		// fires in practice, the fix is to push matching into the database, not to
		// raise the number.
		take: LINKABLE_CASE_CEILING,
	});

	if (cases.length === LINKABLE_CASE_CEILING) {
		console.warn(
			"[pipeline-results] linkable-case ceiling hit; linkage may be incomplete",
			{ projectId: input.projectId, ceiling: LINKABLE_CASE_CEILING },
		);
	}

	return cases;
}

const pipelineRunSelect = {
	id: true,
	provider: true,
	externalRunId: true,
	pipelineName: true,
	branch: true,
	commitSha: true,
	runUrl: true,
	status: true,
	startedAt: true,
	finishedAt: true,
	durationMs: true,
	triggeredByActor: true,
	triggeredByActorAvatarUrl: true,
	totalCount: true,
	passedCount: true,
	failedCount: true,
	skippedCount: true,
	otherCount: true,
	createdAt: true,
} as const;

/**
 * Recent ingested runs for a project (newest first), for the QA-tab "recent
 * runs" section. Scoped by projectId — the project is the tenant boundary (see
 * {@link listLinkableCases}); the caller's project access is enforced upstream.
 */
export async function listProjectPipelineRuns(input: {
	projectId: string;
	limit?: number;
	/**
	 * Narrow to specific sources ("github-actions", "fabric-agentic", …).
	 *
	 * Filtered in the DATABASE, not after the fact. The list is capped by
	 * `limit`, so filtering the returned page client-side would silently answer
	 * "which of the newest 20 runs are GitHub's" instead of "which are the
	 * newest 20 GitHub runs" — the same query with a quietly different meaning.
	 */
	providers?: string[];
	/** Narrow by outcome — the same reasoning about filtering server-side. */
	statuses?: PipelineRunOutcome[];
}) {
	return db.testPipelineRun.findMany({
		where: pipelineRunWhere(input),
		// nulls:last so an undated run never floats above genuinely recent runs
		// (Postgres defaults DESC to NULLS FIRST).
		orderBy: [
			{ startedAt: { sort: "desc", nulls: "last" } },
			{ createdAt: "desc" },
		],
		take: Math.min(input.limit ?? 20, 100),
		select: pipelineRunSelect,
	});
}

/**
 * The `where` that selects a list of runs, project-wide or scoped to one
 * feature.
 *
 * "Touched this feature" means the run produced a result for a case linked to
 * it, which is what `TestResultEvent` already records (`testCaseId` +
 * `pipelineRunId`) — no new denormalisation, just the join nobody had written.
 *
 * Expressed as a relation filter ON THE RUN rather than by first collecting run
 * ids from the events. The id-collection version looked equivalent and was not:
 * `distinct` + `orderBy` on a different column cannot be pushed into Postgres
 * (`SELECT DISTINCT ON (x) … ORDER BY y` is invalid SQL — the DISTINCT ON
 * expressions must lead the ORDER BY), so Prisma dedupes in Node, `take` never
 * becomes a `LIMIT`, and every call dragged the feature's ENTIRE event history
 * over the wire before truncating. On a well-covered, long-lived feature that is
 * tens of thousands of rows, on every QA-tab mount and every poll tick.
 *
 * This shape has no `distinct` to defeat the pushdown, so `take`/`skip` are real
 * SQL `LIMIT`/`OFFSET` and the list is genuinely paginated — which is also why
 * there is no longer a scan cap to explain. It orders by the same column it
 * displays, so the window and the ordering cannot disagree.
 *
 * `projectId` is restated on the run itself, not just inside the join: the
 * tenant guard should not depend on a nested filter keeping its shape.
 */
function pipelineRunWhere(input: {
	projectId: string;
	storyId?: string | null;
	providers?: string[];
	statuses?: PipelineRunOutcome[];
}): Prisma.TestPipelineRunWhereInput {
	return {
		projectId: input.projectId,
		deletedAt: null,
		// An empty array means "no filter", not "match nothing".
		...(input.providers?.length
			? { provider: { in: input.providers } }
			: {}),
		...(input.statuses?.length
			? { OR: input.statuses.map(pipelineRunOutcomeWhere) }
			: {}),
		...(input.storyId
			? {
					resultEvents: {
						some: {
							testCase: {
								projectId: input.projectId,
								deletedAt: null,
								workItemLinks: {
									some: { userStoryId: input.storyId },
								},
							},
						},
					},
				}
			: {}),
	};
}

/**
 * The runs that actually touched ONE feature, newest
 * first.
 *
 * The project-wide list answers "what has CI done lately". This answers the
 * question a feature's QA tab is actually asking — "did anything test THIS?" —
 * which the project-scoped list could not: it showed every run in the project,
 * so a feature with no automated coverage looked identically busy to one with
 * full coverage.
 *
 * A feature with no coverage returns an EMPTY list. Callers must treat that as
 * "nothing tests this" rather than falling back to the project's runs — a silent
 * widening is how "nothing tests this" gets mistaken for "everything is fine".
 */
export async function listStoryPipelineRuns(input: {
	projectId: string;
	storyId: string;
	limit?: number;
	providers?: string[];
	statuses?: PipelineRunOutcome[];
}): Promise<PipelineRunListRow[]> {
	return db.testPipelineRun.findMany({
		where: pipelineRunWhere(input),
		orderBy: [
			{ startedAt: { sort: "desc", nulls: "last" } },
			{ createdAt: "desc" },
		],
		take: Math.min(input.limit ?? 20, 100),
		select: pipelineRunSelect,
	});
}

/** A run row as returned by the list queries (drives `PipelineRunRow` in the UI). */
export type PipelineRunListRow = Awaited<
	ReturnType<typeof listProjectPipelineRuns>
>[number];

/**
 * One page of run history (newest first) plus the total it was drawn from — the
 * "View all runs" surface, with its "showing N of M" affordance.
 *
 * Page and count share one `where`, resolved once. They used to be two exported
 * functions the caller combined by hand, which is exactly the shape that lets a
 * scoped page pair with an unscoped total: the dialog would then say "showing 3
 * of 412" for a feature that only ever had 3 runs.
 */
export async function listPipelineRunsPage(input: {
	projectId: string;
	/** Omit for the project-wide history; set to scope to one feature. */
	storyId?: string | null;
	providers?: string[];
	statuses?: PipelineRunOutcome[];
	limit: number;
	offset: number;
}): Promise<{ runs: PipelineRunListRow[]; total: number }> {
	const where = pipelineRunWhere(input);

	const [runs, total] = await Promise.all([
		db.testPipelineRun.findMany({
			where,
			orderBy: [
				{ startedAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
			],
			skip: Math.max(0, input.offset),
			take: Math.min(Math.max(1, input.limit), 100),
			select: pipelineRunSelect,
		}),
		db.testPipelineRun.count({ where }),
	]);
	return { runs, total };
}

/** One test in a run's detail, with its resolved Fabric case (when matched). */
export interface PipelineRunDetailResult extends PipelineRunTestRecord {
	matchedCase: { id: string; identifier: string; title: string } | null;
}

/** A run plus its full per-test breakdown, for the in-portal run-detail sheet. */
export interface PipelineRunDetail {
	run: PipelineRunListRow;
	results: PipelineRunDetailResult[];
}

/**
 * One run with its full per-test breakdown for the run-detail sheet. Returns
 * null when the run isn't under this project (tenant guard). The stored `results`
 * JSON carries `matchedCaseId`; we resolve those to case identifiers/titles here
 * so the detail can link each test to its Fabric case.
 */
export async function getProjectPipelineRunDetail(input: {
	projectId: string;
	runId: string;
}): Promise<PipelineRunDetail | null> {
	const row = await db.testPipelineRun.findFirst({
		where: {
			id: input.runId,
			projectId: input.projectId,
			deletedAt: null,
		},
		select: { ...pipelineRunSelect, results: true },
	});
	if (!row) {
		return null;
	}

	const { results: rawResults, ...run } = row;
	const results = Array.isArray(rawResults)
		? (rawResults as unknown as PipelineRunTestRecord[])
		: [];

	const caseIds = [
		...new Set(
			results
				.map((r) => r.matchedCaseId)
				.filter((id): id is string => Boolean(id)),
		),
	];
	const cases = caseIds.length
		? await db.testCase.findMany({
				where: { id: { in: caseIds }, projectId: input.projectId },
				select: { id: true, identifier: true, title: true },
			})
		: [];
	const caseById = new Map(cases.map((c) => [c.id, c]));

	return {
		run,
		results: results.map((r) => ({
			...r,
			matchedCase: r.matchedCaseId
				? (caseById.get(r.matchedCaseId) ?? null)
				: null,
		})),
	};
}

/**
 * Per-source sync state for a project (drives the "stale data" badge — the
 * newest `lastFetchedAt` is the last time any source was successfully pulled).
 */
export async function listPipelineSyncStates(input: { projectId: string }) {
	return db.testPipelineSyncState.findMany({
		where: {
			projectId: input.projectId,
		},
		select: {
			id: true,
			provider: true,
			pipelineKey: true,
			lastFetchedAt: true,
			status: true,
			lastError: true,
			lastErrorDetail: true,
			lastErrorKind: true,
			lastErrorAt: true,
		},
	});
}

/**
 * Sync-state provider tag for a connected repo.
 *
 * Mirrors `PROVIDER_TAG` in
 * `packages/temporal/src/activities/pipeline-results/sync-pipeline-results.ts`,
 * which is the actual source of truth (it also builds the fetch plan, so it
 * can't move here without this package depending on `@repo/temporal` — the
 * dependency direction runs the other way). Duplicated deliberately, kept in
 * sync by `__tests__/pipeline-sync-health.test.ts`, which pins the same
 * example repo URLs `sync-pipeline-results.test.ts` exercises against the
 * temporal side.
 */
const PIPELINE_SYNC_PROVIDER_TAG: Record<RepositoryProvider, string> = {
	AZURE_DEVOPS: "azure-devops",
	GITHUB: "github-actions",
	GITLAB: "gitlab-ci",
};

/**
 * Derive the `(provider, pipelineKey)` a connected repo's `TestPipelineSyncState`
 * would be recorded under. Mirrors the key half of `derivePlan` in the
 * source-of-truth file referenced above — NOT the whole thing: this omits the
 * fetch-plan validation (the ADO org, the GitLab API host) that function also
 * checks, because those only matter for actually calling the provider, not
 * for computing the key a display join needs.
 *
 * Used ONLY to join a connected repository to its sync-health row for display
 * (Settings ▸ Development) — never to decide whether a sync can run. Returns
 * `null` when the key can't be derived (unparseable URL, unsupported
 * provider); the repo then simply shows no sync-health row rather than a
 * guessed one.
 */
function derivePipelineSyncKey(source: {
	provider: RepositoryProvider;
	owner: string;
	repo: string;
	repositoryUrl: string;
}): { providerTag: string; pipelineKey: string } | null {
	switch (source.provider) {
		case "AZURE_DEVOPS": {
			const parsed = parseRepoUrl(source.repositoryUrl);
			if (
				!parsed ||
				parsed.provider !== "AZURE_DEVOPS" ||
				!parsed.project
			) {
				return null;
			}
			return {
				providerTag: PIPELINE_SYNC_PROVIDER_TAG.AZURE_DEVOPS,
				pipelineKey: `${parsed.project}/${source.repo || parsed.name}`,
			};
		}
		case "GITHUB":
			return source.owner && source.repo
				? {
						providerTag: PIPELINE_SYNC_PROVIDER_TAG.GITHUB,
						pipelineKey: `${source.owner}/${source.repo}`,
					}
				: null;
		case "GITLAB":
			return source.owner && source.repo
				? {
						providerTag: PIPELINE_SYNC_PROVIDER_TAG.GITLAB,
						pipelineKey: `${source.owner}/${source.repo}`,
					}
				: null;
		default: {
			// FR6-style exhaustiveness tie: a new provider fails to compile here
			// until it's handled above.
			const unhandled: never = source.provider;
			void unhandled;
			return null;
		}
	}
}

export interface RepositoryPipelineSyncHealth {
	integrationId: string;
	lastFetchedAt: Date | null;
	status: string | null;
	lastError: string | null;
	lastErrorKind: string | null;
}

/**
 * Per-connected-repository pipeline sync health, for the Settings ▸
 * Development page (card #2383's follow-through: the reconnect link the
 * QA-tab failure banner offers must not land on a page that still shows the
 * repo as healthy — see `SyncFailureBanner.tsx`'s module doc).
 *
 * One entry per repository integration that has EVER attempted a sync — a
 * repo pipeline-results has never touched (no cursor, no failure) has no
 * `TestPipelineSyncState` row and is simply absent, which the caller reads as
 * "no sync-health information yet", not as a failure.
 */
export async function getProjectRepositoryPipelineSyncHealth(input: {
	projectId: string;
}): Promise<RepositoryPipelineSyncHealth[]> {
	const [integrations, syncStates] = await Promise.all([
		db.projectRepositoryIntegration.findMany({
			where: {
				projectId: input.projectId,
				status: { not: "DISCONNECTED" },
			},
			select: {
				id: true,
				provider: true,
				repositoryOwner: true,
				repositoryName: true,
				repositoryUrl: true,
			},
		}),
		listPipelineSyncStates({ projectId: input.projectId }),
	]);

	const syncStateByKey = new Map(
		syncStates.map((s) => [`${s.provider} ${s.pipelineKey}`, s]),
	);

	const health: RepositoryPipelineSyncHealth[] = [];
	for (const integration of integrations) {
		const key = derivePipelineSyncKey({
			provider: integration.provider,
			owner: integration.repositoryOwner,
			repo: integration.repositoryName,
			repositoryUrl: integration.repositoryUrl,
		});
		// When the key itself can't be derived (an unparseable ADO URL — the
		// same condition `derivePlan` in `sync-pipeline-results.ts` calls a
		// MISCONFIGURED plan-derivation failure), that source-of-truth records
		// the failure under `planFallbackKey` — `${owner}/${repo}` under this
		// provider's tag — NOT the normally-derived key, precisely because the
		// normal key could not be derived. Falling back to that SAME key here
		// (mirroring `advancePipelineSyncState`'s own `clearFallbackKey`
		// handling of this exact split) is required, or the QA-tab banner's
		// reconnect link sends someone to Settings ▸ Development for a
		// misconfigured repo and the page shows nothing for it — the exact
		// incoherence this sync-health surface exists to remove.
		const providerTag =
			key?.providerTag ??
			PIPELINE_SYNC_PROVIDER_TAG[integration.provider];
		const pipelineKey =
			key?.pipelineKey ??
			`${integration.repositoryOwner}/${integration.repositoryName}`;
		const state = syncStateByKey.get(`${providerTag} ${pipelineKey}`);
		if (!state) {
			continue;
		}
		health.push({
			integrationId: integration.id,
			lastFetchedAt: state.lastFetchedAt,
			status: state.status,
			lastError: state.lastError,
			lastErrorKind: state.lastErrorKind,
		});
	}
	return health;
}

/**
 * Read a source's incremental cursor (the highest external run id ingested so
 * far) before a fetch. Returns null when the source has never been synced —
 * the fetcher then pulls the most recent window. Scoped by projectId (the tenant
 * boundary); `pipelineKey` disambiguates several pipelines under one provider.
 */
export async function getPipelineSyncCursor(input: {
	projectId: string;
	provider: string;
	pipelineKey?: string;
}): Promise<{ lastRunExternalId: string | null } | null> {
	const row = await db.testPipelineSyncState.findUnique({
		where: {
			projectId_provider_pipelineKey: {
				projectId: input.projectId,
				provider: input.provider,
				pipelineKey: input.pipelineKey ?? "",
			},
		},
		select: { lastRunExternalId: true },
	});
	return row ?? null;
}

/**
 * Advisory-lock class id namespacing pipeline-sync-failure transition
 * detection (arbitrary but stable). A DISTINCT class from
 * `REFRESH_ADVISORY_CLASS` in `../lib/refresh-lock-key.ts` — Postgres keeps
 * `pg_advisory_xact_lock(int4, int4)` id spaces separate per class, so this
 * domain needs its own rather than accidentally sharing (or colliding with)
 * the OAuth-refresh one.
 *
 * A review suggested moving this to a 64-bit hash addressed via the bigint
 * `pg_advisory_xact_lock(int8)` form, instead of staying in the `(int4, int4)`
 * space `refresh-lock-key.ts` already occupies. Deliberately NOT done:
 * `refresh-lock-key.ts`'s own doc comment records that refresh locks were
 * previously addressed FOUR different ways — two callers in the two-int
 * space, two in the bigint space — and Postgres treats those as separate lock
 * spaces that never block each other, which is exactly how a rotating OAuth
 * refresh token got double-spent (the GitLab incident that file documents).
 * That file exists to consolidate every refresh lock onto the one
 * `(int4, int4)` space; re-fragmenting into the bigint form here would
 * reintroduce the same class of bug for this domain instead. The residual
 * risk of staying in the shared 32-bit space is contention only — an FNV-1a
 * collision between two unrelated `(projectId, provider, pipelineKey)`
 * triples briefly serializes their sub-millisecond transactions — never
 * correctness, since every subsequent query still keys off the full triple,
 * not the hashed lock id.
 */
const PIPELINE_SYNC_FAILURE_ADVISORY_CLASS = 0x51534653; // "QSFS"

/** How long the lock + read/write may take before the transaction gives up. */
const PIPELINE_SYNC_FAILURE_LOCK_TIMEOUT_MS = 10_000;
/** How long to wait for a connection + the lock itself. */
const PIPELINE_SYNC_FAILURE_LOCK_MAX_WAIT_MS = 10_000;

/**
 * The advisory-lock object key for one `(projectId, provider, pipelineKey)`
 * sync-state row. Shared by {@link recordPipelineSyncFailure} and
 * {@link advancePipelineSyncState} so a failing write and a succeeding write
 * for the SAME row always serialize against each other, not just against
 * writes of their own kind — see {@link advancePipelineSyncState}'s doc for
 * why the write-write race between them needed closing.
 */
function pipelineSyncStateLockKey(
	projectId: string,
	provider: string,
	pipelineKey: string,
): string {
	return `${projectId}:${provider}:${pipelineKey}`;
}

/**
 * Take the pipeline-sync-state advisory lock for one row, inside an
 * already-open transaction. MUST use `$executeRaw`, not `$queryRaw`:
 * `pg_advisory_xact_lock()` returns void, which the Postgres driver adapter's
 * `$queryRaw` cannot deserialize (mirrors `withRefreshLock` in
 * `../lib/refresh-lock.ts`).
 */
async function acquirePipelineSyncStateLock(
	tx: Prisma.TransactionClient,
	lockKey: string,
): Promise<void> {
	await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PIPELINE_SYNC_FAILURE_ADVISORY_CLASS}::int, ${advisoryObjectKey(lockKey)}::int)`;
}

/**
 * The monotonic guard shared by {@link recordPipelineSyncFailure} and
 * {@link advancePipelineSyncState}: may an attempt that STARTED at `incoming`
 * overwrite a row last written by an attempt that started at `stored`?
 *
 * The advisory lock above serializes the two writers but establishes no order
 * BETWEEN ATTEMPTS — it only guarantees they don't interleave. Two attempts
 * genuinely overlap in production: the sync activity declares
 * `heartbeatTimeout: 30 seconds` and `maximumAttempts: 3`, and Temporal does
 * not kill a heartbeat-timed-out attempt, it just starts another. So attempt A
 * can hang in an HTTP call, attempt B start later and commit SUCCESS, and A
 * then wake up and commit FAILED — a stale failure row, a stale banner, and a
 * warn/error log line for a source that is actually healthy. Comparing attempt
 * start timestamps inside the already-held lock makes the compare-and-write
 * atomic at no extra cost.
 *
 * Two boundary cases, both deliberately permissive:
 *
 *  - **`stored` is null** → allow. Rows written before `lastAttemptStartedAt`
 *    existed carry no attempt identity, and there is no basis to call the
 *    incoming write older. Treating null as "block" would freeze every
 *    pre-existing row permanently; treating it as "always older" costs at most
 *    one unguarded write per row, on the first write after deploy.
 *
 *  - **Equal timestamps** → allow. Equality means the two writes cannot be
 *    ordered by this token at all — in practice it is the SAME attempt writing
 *    the same row twice (one invocation stamps one timestamp across all its
 *    writes), and an attempt must always be able to update its own row. The
 *    guard rejects only a STRICTLY older attempt, which is the only case where
 *    "this result is stale" is actually known.
 */
function attemptSupersedes(
	stored: Date | null | undefined,
	incoming: Date,
): boolean {
	return stored == null || stored.getTime() <= incoming.getTime();
}

/**
 * Advance a source's incremental cursor after a SUCCESSFUL fetch (upsert on the
 * unique `(projectId, provider, pipelineKey)`). `lastRunExternalId` /
 * `lastCommitSha` are high-watermarks; `lastFetchedAt` is set to now so the
 * stale badge clears. A failed fetch calls {@link recordPipelineSyncFailure}
 * instead — it must NOT advance the cursor.
 *
 * Takes the SAME advisory lock {@link recordPipelineSyncFailure} does, keyed
 * the same way, so the two writers for one row always serialize instead of
 * racing. Before this, a failing attempt could write FAILED while a
 * concurrent successful attempt wrote SUCCESS with neither waiting for the
 * other — whichever committed last "won" the row, so an older failing
 * attempt could overwrite a newer success back to FAILED, leaving a stale
 * failure banner behind. Locking here closes that write-write race.
 *
 * Mutual exclusion alone is not enough, though: it stops the two writes from
 * interleaving but does not say which ATTEMPT is newer, so an older failing
 * attempt that hung in an HTTP call could still commit FAILED after a newer
 * success committed. `attemptStartedAt` closes that — see
 * {@link attemptSupersedes} for the ordering rule and its null/equal cases.
 * The comparison happens inside the lock already held here, so the
 * read-compare-write is atomic without any second locking mechanism.
 *
 * Returns the upserted row, or `null` when the guard dropped the write because
 * a NEWER attempt had already written this row.
 */
export async function advancePipelineSyncState(input: {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	provider: string;
	pipelineKey?: string;
	lastRunExternalId?: string | null;
	lastCommitSha?: string | null;
	pageToken?: string | null;
	fetchedAt: Date;
	/**
	 * When the sync ATTEMPT making this write started — the ordering token for
	 * the monotonic guard (see {@link attemptSupersedes}). Distinct from
	 * `fetchedAt`, which is when this particular fetch finished and is what the
	 * stale badge reads.
	 */
	attemptStartedAt: Date;
	/**
	 * The key a PLAN-DERIVATION failure for this same source would have used.
	 *
	 * A sync-state row is keyed by the derived pipeline, but plan derivation
	 * fails precisely when that pipeline cannot be derived — so the failure is
	 * recorded under a fallback key (`owner/repo`) that a later success can never
	 * equal. For Azure DevOps the success key is `project/repo`, so fixing a bad
	 * repository URL left the original failure row behind, banner and all, with
	 * nothing able to clear it. Passing that fallback here clears exactly the row
	 * this source would have written and nothing else.
	 */
	clearFallbackKey?: string | null;
}) {
	const pipelineKey = input.pipelineKey ?? "";
	const hasFallback =
		!!input.clearFallbackKey && input.clearFallbackKey !== pipelineKey;

	// This write touches TWO rows when `clearFallbackKey` is set: its own
	// success row AND the fallback-keyed row it supersedes. Both need the
	// lock, but they are acquired in SORTED order rather than argument order.
	// `recordPipelineSyncFailure` never holds more than one of these locks at
	// once, so it can't participate in a deadlock cycle; the only way to
	// create one is two `advancePipelineSyncState` calls (for two DIFFERENT
	// sources) locking the same pair of keys in opposite order, which sorting
	// rules out — every caller agrees on one global acquisition order
	// regardless of which of its two keys is "the real one".
	const lockKeys = Array.from(
		new Set(
			[
				pipelineSyncStateLockKey(
					input.projectId,
					input.provider,
					pipelineKey,
				),
				...(hasFallback
					? [
							pipelineSyncStateLockKey(
								input.projectId,
								input.provider,
								input.clearFallbackKey as string,
							),
						]
					: []),
			].sort(),
		),
	);

	return db.$transaction(
		async (tx) => {
			for (const lockKey of lockKeys) {
				await acquirePipelineSyncStateLock(tx, lockKey);
			}

			if (hasFallback) {
				// updateMany, not delete: the row may legitimately not exist (the
				// common case — nothing ever failed), and a delete would also
				// discard a cursor if the fallback key ever coincided with a real
				// pipeline.
				await tx.testPipelineSyncState.updateMany({
					where: {
						projectId: input.projectId,
						provider: input.provider,
						pipelineKey: input.clearFallbackKey as string,
						// Only a row that is still FAILED. A fallback key that happens
						// to be a real pipeline with its own healthy cursor must not be
						// touched.
						status: "FAILED",
						// The same monotonic guard the main row gets, expressed as a
						// predicate so it stays one atomic statement. A NEWER attempt's
						// failure on the fallback key is not this attempt's to clear.
						OR: [
							{ lastAttemptStartedAt: null },
							{
								lastAttemptStartedAt: {
									lte: input.attemptStartedAt,
								},
							},
						],
					},
					data: {
						status: "SUPERSEDED",
						lastError: null,
						lastErrorDetail: null,
						lastErrorKind: null,
						lastErrorAt: null,
						lastAttemptStartedAt: input.attemptStartedAt,
					},
				});
			}

			// Read inside the lock, so the compare and the write cannot be split
			// by a concurrent attempt.
			const prior = await tx.testPipelineSyncState.findUnique({
				where: {
					projectId_provider_pipelineKey: {
						projectId: input.projectId,
						provider: input.provider,
						pipelineKey,
					},
				},
				select: { lastAttemptStartedAt: true },
			});
			if (
				!attemptSupersedes(
					prior?.lastAttemptStartedAt,
					input.attemptStartedAt,
				)
			) {
				return null;
			}

			return tx.testPipelineSyncState.upsert({
				where: {
					projectId_provider_pipelineKey: {
						projectId: input.projectId,
						provider: input.provider,
						pipelineKey,
					},
				},
				create: {
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					provider: input.provider,
					pipelineKey,
					lastRunExternalId: input.lastRunExternalId ?? null,
					lastCommitSha: input.lastCommitSha ?? null,
					pageToken: input.pageToken ?? null,
					lastFetchedAt: input.fetchedAt,
					status: "SUCCESS",
					lastError: null,
					lastErrorKind: null,
					lastErrorAt: null,
					lastAttemptStartedAt: input.attemptStartedAt,
				},
				update: {
					lastRunExternalId: input.lastRunExternalId ?? undefined,
					lastCommitSha: input.lastCommitSha ?? undefined,
					pageToken: input.pageToken ?? null,
					lastFetchedAt: input.fetchedAt,
					status: "SUCCESS",
					lastError: null,
					lastErrorKind: null,
					lastErrorAt: null,
					lastAttemptStartedAt: input.attemptStartedAt,
				},
			});
		},
		{
			timeout: PIPELINE_SYNC_FAILURE_LOCK_TIMEOUT_MS,
			maxWait: PIPELINE_SYNC_FAILURE_LOCK_MAX_WAIT_MS,
		},
	);
}

/**
 * Record a failed fetch WITHOUT advancing the cursor — the stale badge keeps
 * showing the last successful `lastFetchedAt`, and the error is surfaced.
 *
 * Returns whether this is a REPEAT of the SAME failure state the row already
 * had (still `FAILED`, same classified `kind`) — read BEFORE the upsert so the
 * caller can tell "this failure just started" from "this is the same failure
 * on yet another 15-minute cron tick" and pick a log level accordingly.
 * Comparing
 * `kind` rather than `error`: the readable sentence for a rate limit embeds a
 * changing reset timestamp, so a string comparison would call every attempt
 * "new" and the repeat-detection would never fire.
 *
 * The read-then-upsert is wrapped in a per-`(projectId, provider,
 * pipelineKey)` Postgres advisory lock, making the whole read+decide+write
 * atomic. Without it, two overlapping writers (an activity retry, a
 * `USE_EXISTING`-collapsed cron tick racing a manual "Sync now", or simply two
 * sources failing for the same key at once) can both read the SAME prior
 * state and both compute `repeat === false` — producing two transition-level
 * `warn` log lines for what is really one transition. An advisory lock (not
 * `SELECT … FOR UPDATE`) is used deliberately: on a source's FIRST-EVER
 * failure for this key the row does not exist yet, and `FOR UPDATE` cannot
 * lock a row that isn't there, while an advisory lock keyed on the
 * (not-yet-existing) row's identity still serializes the two writers.
 *
 * `applied` is false when the same-lock monotonic guard dropped the write
 * because a NEWER attempt had already written this row — see
 * {@link attemptSupersedes}. The caller must not report a dropped write as a
 * fresh transition into failure: an attempt that hung long enough to be
 * superseded is reporting a result that is no longer the source's state.
 */
export async function recordPipelineSyncFailure(input: {
	projectId: string;
	organizationId: string | null;
	userId: string | null;
	provider: string;
	pipelineKey?: string;
	error: string;
	/**
	 * The provider's own response body, when the failure was an HTTP one.
	 *
	 * Stored apart from `error` so a surface can show the readable sentence and
	 * reveal the raw body only when asked. Always written — including as null —
	 * so a later failure of a different KIND cannot leave the previous failure's
	 * raw body sitting under it, which would attribute one provider's words to
	 * another's error.
	 */
	errorDetail?: string | null;
	/**
	 * The classified failure kind (a `SyncFailureKind` from `@repo/temporal`'s
	 * `sync-failure-classification.ts` — kept as a plain `string` here so this
	 * package does not depend on `@repo/temporal`, mirroring how `provider` is
	 * already a bare string rather than an imported union).
	 */
	kind: string;
	failedAt: Date;
	/**
	 * When the sync ATTEMPT making this write started — the ordering token for
	 * the monotonic guard (see {@link attemptSupersedes}). Distinct from
	 * `failedAt`, which is when this particular failure happened.
	 */
	attemptStartedAt: Date;
}): Promise<{ repeat: boolean; applied: boolean }> {
	const pipelineKey = input.pipelineKey ?? "";
	const lockKey = pipelineSyncStateLockKey(
		input.projectId,
		input.provider,
		pipelineKey,
	);

	return db.$transaction(
		async (tx) => {
			await acquirePipelineSyncStateLock(tx, lockKey);

			const prior = await tx.testPipelineSyncState.findUnique({
				where: {
					projectId_provider_pipelineKey: {
						projectId: input.projectId,
						provider: input.provider,
						pipelineKey,
					},
				},
				select: {
					status: true,
					lastErrorKind: true,
					lastAttemptStartedAt: true,
				},
			});
			const repeat =
				prior?.status === "FAILED" &&
				prior.lastErrorKind === input.kind;

			// Reported honestly even when the write is dropped: `repeat`
			// describes what the row already said, `applied` whether this
			// attempt's result became the row's state.
			if (
				!attemptSupersedes(
					prior?.lastAttemptStartedAt,
					input.attemptStartedAt,
				)
			) {
				return { repeat, applied: false };
			}

			await tx.testPipelineSyncState.upsert({
				where: {
					projectId_provider_pipelineKey: {
						projectId: input.projectId,
						provider: input.provider,
						pipelineKey,
					},
				},
				create: {
					projectId: input.projectId,
					organizationId: input.organizationId,
					userId: input.userId,
					provider: input.provider,
					pipelineKey,
					status: "FAILED",
					lastError: input.error,
					lastErrorDetail: input.errorDetail ?? null,
					lastErrorKind: input.kind,
					lastErrorAt: input.failedAt,
					lastAttemptStartedAt: input.attemptStartedAt,
				},
				update: {
					status: "FAILED",
					lastError: input.error,
					lastErrorDetail: input.errorDetail ?? null,
					lastErrorKind: input.kind,
					lastErrorAt: input.failedAt,
					lastAttemptStartedAt: input.attemptStartedAt,
				},
			});

			return { repeat, applied: true };
		},
		{
			timeout: PIPELINE_SYNC_FAILURE_LOCK_TIMEOUT_MS,
			maxWait: PIPELINE_SYNC_FAILURE_LOCK_MAX_WAIT_MS,
		},
	);
}

/**
 * An automated test that CI reported but the linkage cascade could not resolve
 * to any Fabric test case — i.e. real coverage the project is running but not
 * tracking.
 */
export interface UnmatchedAutomatedTest {
	name: string;
	classname: string | null;
	/** How many of the scanned runs reported this test. */
	occurrences: number;
	/** Its mapped result in the most recent run that reported it. */
	lastStatus: TestResult;
	lastSeenAt: Date | null;
	/** Provider tag of the most recent run that reported it. */
	provider: string;
}

/**
 * The automated tests running in CI that map to NO Fabric test case.
 *
 * Ingestion already counts these (`unmatchedCount`) but the count alone can't be
 * acted on. Every test in a run is persisted on `TestPipelineRun.results` with
 * its `matchedCaseId`, so the unmatched ones can be listed, deduped and turned
 * into real cases — closing the gap where a suite of hundreds of automated tests
 * shows as "no coverage" simply because nobody hand-authored matching cases.
 *
 * Bounded by design: scans the most recent `runLimit` runs rather than all
 * history, since a test that stopped running months ago is not a coverage gap
 * worth surfacing.
 */
export async function listUnmatchedAutomatedTests(input: {
	projectId: string;
	/** How many recent runs to scan (newest first). */
	runLimit?: number;
	/** Max distinct tests returned. */
	limit?: number;
}): Promise<{
	tests: UnmatchedAutomatedTest[];
	scannedRuns: number;
	/** Distinct unmatched tests found before `limit` was applied. */
	totalDistinct: number;
}> {
	const runLimit = Math.min(Math.max(1, input.runLimit ?? 20), 100);
	const limit = Math.min(Math.max(1, input.limit ?? 100), 500);

	const runs = await db.testPipelineRun.findMany({
		where: { projectId: input.projectId, deletedAt: null },
		orderBy: [
			{ startedAt: { sort: "desc", nulls: "last" } },
			{ createdAt: "desc" },
		],
		take: runLimit,
		select: {
			provider: true,
			startedAt: true,
			createdAt: true,
			results: true,
		},
	});

	// Runs arrive newest-first, so the FIRST time a test is seen carries its most
	// recent status — later (older) sightings only add to the occurrence count.
	const byKey = new Map<string, UnmatchedAutomatedTest>();
	for (const run of runs) {
		const results = Array.isArray(run.results)
			? (run.results as unknown as PipelineRunTestRecord[])
			: [];
		for (const r of results) {
			if (r.matchedCaseId) {
				continue;
			}
			const key = `${r.classname ?? ""}::${r.name}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.occurrences++;
				continue;
			}
			byKey.set(key, {
				name: r.name,
				classname: r.classname ?? null,
				occurrences: 1,
				lastStatus: r.status,
				lastSeenAt: run.startedAt ?? run.createdAt ?? null,
				provider: run.provider,
			});
		}
	}

	// A run's stored `matchedCaseId` is frozen at ingestion, and an ingested run
	// is never re-processed — so a case created FROM this list would otherwise
	// keep its row until some future pipeline run happened to re-match it. Re-run
	// the real linkage cascade against today's cases and drop anything now
	// tracked, so creating a case drains its row on the next refetch (which is
	// what the surface promises). Deduped first, so this is O(distinct × cases),
	// not O(every result × cases).
	const linkable = await listLinkableCases({ projectId: input.projectId });
	const untracked = [...byKey.values()].filter(
		(t) =>
			!resolveAutomationLink(
				{ name: t.name, classname: t.classname ?? undefined },
				linkable,
			),
	);

	const all = untracked.sort(
		// Failing first (they're the most urgent to track), then most frequent.
		(a, b) =>
			Number(b.lastStatus === "FAILED") -
				Number(a.lastStatus === "FAILED") ||
			b.occurrences - a.occurrences,
	);

	return {
		tests: all.slice(0, limit),
		scannedRuns: runs.length,
		totalDistinct: all.length,
	};
}

/**
 * Projects a scheduled pipeline-result sync should visit.
 *
 * The fetch trigger was an open question for a long time and the answer taken on
 * 2026-07-26 is: poll on a schedule, and keep the manual "Sync now" button. This
 * is the enumeration half of that — the sweep asks who to sync, and this decides.
 *
 * **Scoped deliberately, not "every project".** A sweep that visited every row
 * would multiply third-party API calls by the number of projects that have
 * nothing to fetch, on every tick, forever. A project qualifies only when it has
 * at least one repository integration that is not DISCONNECTED — which is
 * exactly the condition under which a manual sync would have found anything.
 *
 * DRAFT and ARCHIVED projects are excluded: one has not started and the other is
 * finished, and neither is worth a provider round trip. COMPLETED is included,
 * because a completed project's CI can still report a late run and that result
 * still belongs in its history.
 *
 * `userId` and `organizationId` are read from the project row rather than passed
 * in — the sweep has no actor, so there is no caller-supplied tenant to trust.
 */
export async function listProjectsDueForPipelineSync(input?: {
	limit?: number;
	/**
	 * "Now", injected so the freshness floor is testable without waiting. The
	 * sweep never passes it.
	 */
	now?: Date;
}): Promise<
	Array<{
		projectId: string;
		organizationId: string | null;
		userId: string | null;
		autoCreateBugsFromFailures: boolean;
	}>
> {
	const rows = await db.project.findMany({
		where: {
			status: { in: ["ACTIVE", "COMPLETED"] },
			repositoryIntegrations: {
				some: { status: { not: "DISCONNECTED" } },
			},
			// Automatic sync turned off for this project (spec F1). Written as
			// "not explicitly disabled" rather than `is: { pipelineSyncEnabled:
			// true }`, because a project that has never opened Settings ▸ Testing
			// has NO qa-settings row at all, and the shipped behaviour for those
			// is to sync. A stricter filter would silently switch every such
			// project off on deploy.
			NOT: { qaSettings: { is: { pipelineSyncEnabled: false } } },
		},
		select: {
			id: true,
			organizationId: true,
			userId: true,
			autoCreateBugsFromFailures: true,
			qaSettings: { select: { pipelineSyncIntervalMinutes: true } },
			// The freshness floor is compared against the LAST FETCH, not the
			// last tick: a project synced two minutes ago by someone pressing
			// "Sync now" is not due, whoever caused it. A project has one sync
			// state per (provider, pipeline), so the MOST RECENT one is what
			// "when did this project last fetch" means — taking any other would
			// let one stale provider keep the whole project permanently due.
			//
			// `nulls: "last"` is load-bearing, not decoration. `lastFetchedAt` is
			// nullable (a source that has never fetched successfully), and
			// Postgres sorts NULLs FIRST under plain DESC — so a single
			// never-fetched source won `take: 1`, this read returned null, and
			// `isPipelineSyncDue` treats null as unconditionally due. One bad
			// source therefore bypassed the configured interval for the WHOLE
			// project, on every tick, which is the exact failure the comment
			// above says this ordering exists to prevent.
			testPipelineSyncStates: {
				select: { lastFetchedAt: true },
				orderBy: { lastFetchedAt: { sort: "desc", nulls: "last" } },
				take: 1,
			},
		},
		// Oldest-updated first, so a capped sweep rotates through the estate
		// instead of starving the same tail every tick.
		orderBy: { updatedAt: "asc" },
		// Bounded on purpose. An unbounded sweep is one growth spurt away from a
		// tick that cannot finish inside its own interval.
		take: Math.min(input?.limit ?? 200, 500),
	});

	const now = input?.now ?? new Date();

	return rows
		.filter((r) =>
			isPipelineSyncDue({
				now,
				lastFetchedAt:
					r.testPipelineSyncStates[0]?.lastFetchedAt ?? null,
				intervalMinutes:
					r.qaSettings?.pipelineSyncIntervalMinutes ?? null,
			}),
		)
		.map((r) => ({
			projectId: r.id,
			organizationId: r.organizationId,
			userId: r.userId,
			autoCreateBugsFromFailures: r.autoCreateBugsFromFailures,
		}));
}
