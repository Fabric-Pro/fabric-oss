import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The dependency probe behind the document generation queue (Fizzy #2199).
 *
 * Unit-level with a mocked `db`, matching `publishing-drafts.test.ts`: what is
 * under test is the SHAPE of the answer — which columns are read as in-flight,
 * which failures are allowed to refuse a run, what the exclusions remove from
 * the query, and the fact that no entry can ever carry a name. None of that
 * needs Postgres, so this stays in the default no-database suite.
 *
 * The context and document mocks below apply the `where` clause they are given
 * rather than returning a canned answer, so the exclusion cases prove the
 * predicate reaches the database instead of asserting that a constant was
 * passed along.
 */

const {
	projectFindFirst,
	contextGroupBy,
	contextCount,
	codeIndexGroupBy,
	jobGroupBy,
	scanCount,
	documentFindMany,
} = vi.hoisted(() => ({
	projectFindFirst: vi.fn(),
	contextGroupBy: vi.fn(),
	contextCount: vi.fn(),
	codeIndexGroupBy: vi.fn(),
	jobGroupBy: vi.fn(),
	scanCount: vi.fn(),
	documentFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		project: { findFirst: projectFindFirst },
		projectContext: { groupBy: contextGroupBy, count: contextCount },
		projectCodeIndex: { groupBy: codeIndexGroupBy },
		backgroundJob: { groupBy: jobGroupBy },
		projectScan: { count: scanCount },
		projectDocument: { findMany: documentFindMany },
	},
	Prisma: {},
}));

import {
	GenerationDependencyProjectNotFoundError,
	resolveGenerationDependencies,
} from "../prisma/queries/projects/generation-dependencies";
import { GENERATION_DEPENDENCY_CATEGORIES } from "../src/generation-dependency-categories";

const ARGS = {
	projectId: "project-1",
	organizationId: "org-1",
	documentType: "PRD",
};

type ContextRow = {
	id: string;
	extractionStatus: string;
	/** Recorded by a failed attempt; never a verdict on its own. */
	extractionError?: string | null;
	urlActiveWorkflowId?: string | null;
	/**
	 * When the row was last written. Defaults to "just now", so a test that says
	 * nothing about time describes a row something is still working on.
	 */
	updatedAt?: Date;
};

/** Minutes ago, as a `Date` — the way every freshness case below is phrased. */
function minutesAgo(minutes: number): Date {
	return new Date(Date.now() - minutes * 60_000);
}

/**
 * Evaluate one Prisma `where` leaf against a row's `updatedAt`.
 *
 * The freshness bounds are the point of half the suite, so the mocks apply them
 * rather than trusting that a cutoff was passed: a predicate that stops reaching
 * the database has to fail here, not read as green.
 */
function passesFreshness(
	clause: Record<string, any> | undefined,
	updatedAt: Date,
): boolean {
	const gte = clause?.updatedAt?.gte;
	return gte === undefined || updatedAt.getTime() >= gte.getTime();
}

type DocumentRow = { id: string; type: string; status: string };

/** Group helpers, in the shape Prisma's `groupBy` returns. */
const codeIndexGroup = (status: string, count: number) => ({
	status,
	_count: { _all: count },
});
const jobGroup = (kind: string, count: number) => ({
	kind,
	_count: { _all: count },
});

/**
 * Honour `where.id.not` and the per-arm `updatedAt` cutoffs, so the exclusions
 * and the freshness bounds are exercised rather than merely observed.
 */
function withContexts(rows: ContextRow[]) {
	contextGroupBy.mockImplementation(
		async ({ where }: { where: Record<string, any> }) => {
			const arms: Record<string, any>[] = where.OR;
			const counts = new Map<string, number>();
			for (const row of rows) {
				if (row.id === where.id?.not) {
					continue;
				}
				const updatedAt = row.updatedAt ?? new Date();
				const matched = arms.some((arm) => {
					const statuses: string[] | undefined =
						arm.extractionStatus?.in;
					const status = statuses
						? statuses.includes(row.extractionStatus)
						: arm.extractionStatus === row.extractionStatus;
					return status && passesFreshness(arm, updatedAt);
				});
				if (!matched) {
					continue;
				}
				counts.set(
					row.extractionStatus,
					(counts.get(row.extractionStatus) ?? 0) + 1,
				);
			}
			return [...counts].map(([extractionStatus, count]) => ({
				extractionStatus,
				_count: { _all: count },
			}));
		},
	);
	contextCount.mockImplementation(
		async ({ where }: { where: Record<string, any> }) =>
			rows.filter(
				(row) =>
					row.id !== where.id?.not &&
					row.urlActiveWorkflowId &&
					passesFreshness(where, row.updatedAt ?? new Date()),
			).length,
	);
}

function withDocuments(rows: DocumentRow[]) {
	documentFindMany.mockImplementation(
		async ({ where }: { where: Record<string, any> }) => {
			const types: string[] = where.type.in;
			return rows
				.filter(
					(row) =>
						row.id !== where.id?.not && types.includes(row.type),
				)
				.map((row) => ({ type: row.type, status: row.status }));
		},
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// A project with every source quiet — and, for the sources read as rows,
	// with no rows at all.
	projectFindFirst.mockResolvedValue({ id: "project-1" });
	codeIndexGroupBy.mockResolvedValue([]);
	jobGroupBy.mockResolvedValue([]);
	scanCount.mockResolvedValue(0);
	withContexts([]);
	withDocuments([]);
});

describe("resolveGenerationDependencies", () => {
	it("reports a quiet project as clear", async () => {
		const result = await resolveGenerationDependencies(ARGS);

		expect(result).toEqual({
			verdict: "clear",
			outstanding: [],
			failed: [],
		});
	});

	it("treats a project that never connected anything as clear, not waiting", async () => {
		// No repository, no crawl, no monitor, no scan — every read comes back
		// empty, which is the same answer as "connected and finished". A source
		// that was never connected must never be something to wait for.
		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("clear");
		expect(codeIndexGroupBy).toHaveBeenCalledTimes(1);
		expect(jobGroupBy).toHaveBeenCalledTimes(1);
	});

	it("scopes the project read by organizationId", async () => {
		await resolveGenerationDependencies(ARGS);

		expect(projectFindFirst).toHaveBeenCalledWith({
			where: { id: "project-1", organizationId: "org-1" },
			select: { id: true },
		});
	});

	/**
	 * A named class, not a bare Error: this runs inside a Temporal activity with
	 * a retry budget and the condition is permanent, so the activity layer has to
	 * be able to recognize it and mark the failure non-retryable rather than
	 * spend five attempts re-asking a question with one answer.
	 */
	it("refuses to answer for a project the organization does not own", async () => {
		projectFindFirst.mockResolvedValue(null);

		const error = await resolveGenerationDependencies(ARGS).catch(
			(thrown) => thrown,
		);

		expect(error).toBeInstanceOf(GenerationDependencyProjectNotFoundError);
		expect(error.message).toMatch(
			/not found in the requested organization/,
		);
		// The structural discriminant, for a classifier that cannot reach for
		// `instanceof` — a second module copy, or a serialized boundary.
		expect(error.nonRetryable).toBe(true);
	});
});

describe("outstanding categories", () => {
	it("counts contexts still extracting as sourceExtraction", async () => {
		withContexts([
			{ id: "ctx-1", extractionStatus: "PENDING" },
			{ id: "ctx-2", extractionStatus: "EXTRACTING" },
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("waiting");
		expect(result.outstanding).toEqual([
			{ category: "sourceExtraction", count: 2 },
		]);
	});

	it("counts an in-flight code index as codebaseIndexing", async () => {
		codeIndexGroupBy.mockResolvedValue([codeIndexGroup("INDEXING", 1)]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "codebaseIndexing", count: 1 },
		]);
	});

	it("counts a running CODE_INDEXING job with no index row yet", async () => {
		// The window between "connect a repository" and "the workflow writes its
		// ProjectCodeIndex row". Reading only the index row here reports clear,
		// and the generation runs against an empty index.
		jobGroupBy.mockResolvedValue([jobGroup("CODE_INDEXING", 1)]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("waiting");
		expect(result.outstanding).toEqual([
			{ category: "codebaseIndexing", count: 1 },
		]);
	});

	it("does not count one repository twice once its index row appears", async () => {
		codeIndexGroupBy.mockResolvedValue([codeIndexGroup("INDEXING", 1)]);
		jobGroupBy.mockResolvedValue([jobGroup("CODE_INDEXING", 1)]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "codebaseIndexing", count: 1 },
		]);
	});

	it("counts a context with a live crawl workflow as linkedSiteCrawl", async () => {
		withContexts([
			{
				id: "ctx-1",
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "wf-1",
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "linkedSiteCrawl", count: 1 },
		]);
	});

	it("counts a pending or running scan as securityScan", async () => {
		scanCount.mockResolvedValue(1);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "securityScan", count: 1 },
		]);
		expect(scanCount).toHaveBeenCalledWith({
			where: expect.objectContaining({
				projectId: "project-1",
				status: { in: ["PENDING", "RUNNING"] },
			}),
		});
	});

	it("counts every running monitor job as monitorIngestion", async () => {
		jobGroupBy.mockResolvedValue([
			jobGroup("SLACK_CHANNEL_MONITOR", 1),
			jobGroup("TEAMS_CHAT_MONITOR", 2),
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "monitorIngestion", count: 3 },
		]);
		expect(jobGroupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					status: "RUNNING",
					kind: {
						in: [
							"CODE_INDEXING",
							"TEAMS_CHANNEL_MONITOR",
							"TEAMS_CHAT_MONITOR",
							"SLACK_CHANNEL_MONITOR",
							"SLACK_BACKFILL",
						],
					},
				}),
			}),
		);
	});

	it("counts an in-flight prerequisite document", async () => {
		withDocuments([{ id: "doc-1", type: "PRD", status: "GENERATING" }]);

		const result = await resolveGenerationDependencies({
			...ARGS,
			documentType: "ARCHITECTURE",
		});

		expect(result.outstanding).toEqual([
			{ category: "prerequisiteDocument", count: 1 },
		]);
	});
});

describe("prerequisite documents", () => {
	const tier2 = { ...ARGS, documentType: "ARCHITECTURE" };

	it("is clear when a prerequisite is already complete", async () => {
		withDocuments([{ id: "doc-1", type: "PRD", status: "COMPLETE" }]);

		const result = await resolveGenerationDependencies(tier2);

		expect(result.verdict).toBe("clear");
	});

	it("waits on a generating prerequisite when none is complete", async () => {
		withDocuments([
			{ id: "doc-1", type: "PROPOSAL", status: "GENERATING" },
		]);

		const result = await resolveGenerationDependencies(tier2);

		expect(result.outstanding).toEqual([
			{ category: "prerequisiteDocument", count: 1 },
		]);
	});

	it("waits on a queued prerequisite when none is complete", async () => {
		// QUEUED is the queue's own state: the row exists and its run is waiting
		// on this same probe. A sibling in it is still work on the way.
		withDocuments([{ id: "doc-1", type: "PRD", status: "QUEUED" }]);

		const result = await resolveGenerationDependencies(tier2);

		expect(result.outstanding).toEqual([
			{ category: "prerequisiteDocument", count: 1 },
		]);
	});

	it("is clear when no prerequisite exists at all", async () => {
		// Generating a tier-2 document from context alone has always been
		// allowed. The queue delays runs; it does not add a gate.
		const result = await resolveGenerationDependencies(tier2);

		expect(result).toEqual({
			verdict: "clear",
			outstanding: [],
			failed: [],
		});
	});

	it("ignores a failed prerequisite once another one satisfies the tier", async () => {
		withDocuments([
			{ id: "doc-1", type: "PRD", status: "FAILED" },
			{ id: "doc-2", type: "PROPOSAL", status: "COMPLETE" },
		]);

		const result = await resolveGenerationDependencies(tier2);

		expect(result.verdict).toBe("clear");
	});

	it("reports a failed prerequisite when nothing else satisfies the tier", async () => {
		withDocuments([{ id: "doc-1", type: "PRD", status: "FAILED" }]);

		const result = await resolveGenerationDependencies(tier2);

		expect(result.verdict).toBe("failed");
		expect(result.failed).toEqual([
			{ category: "prerequisiteDocument", count: 1 },
		]);
	});

	it("asks for no prerequisite rows for a tier-1 document", async () => {
		await resolveGenerationDependencies(ARGS);

		expect(documentFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ type: { in: [] } }),
			}),
		);
	});
});

describe("exclusions", () => {
	it("keeps the run's own supplied source out of its dependency set", async () => {
		// `create-document` writes the context at PENDING and fires embedding in
		// parallel with the dispatch, so without this every create-with-pasted-
		// text request queues behind itself.
		withContexts([{ id: "ctx-own", extractionStatus: "PENDING" }]);

		const included = await resolveGenerationDependencies(ARGS);
		expect(included.verdict).toBe("waiting");

		const excluded = await resolveGenerationDependencies({
			...ARGS,
			excludeContextId: "ctx-own",
		});

		expect(excluded.verdict).toBe("clear");
		expect(contextGroupBy).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { not: "ctx-own" } }),
			}),
		);
		expect(contextCount).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { not: "ctx-own" } }),
			}),
		);
	});

	it("does not refuse a run because its own supplied source failed", async () => {
		// The pasted text reaches the generator directly; a failed embedding of
		// it costs search, not the document.
		withContexts([{ id: "ctx-own", extractionStatus: "FAILED" }]);

		const result = await resolveGenerationDependencies({
			...ARGS,
			excludeContextId: "ctx-own",
		});

		expect(result.verdict).toBe("clear");
	});

	it("keeps the document being generated out of its own prerequisite set", async () => {
		// The graph has no self-edge today, so the row can only match through a
		// future one — which is exactly why the exclusion is a predicate rather
		// than a comment: a run must never be able to wait on itself.
		withDocuments([{ id: "doc-self", type: "PRD", status: "QUEUED" }]);
		const tier2 = { ...ARGS, documentType: "ARCHITECTURE" };

		const included = await resolveGenerationDependencies(tier2);
		expect(included.verdict).toBe("waiting");

		const excluded = await resolveGenerationDependencies({
			...tier2,
			excludeDocumentId: "doc-self",
		});

		expect(excluded.verdict).toBe("clear");
		expect(documentFindMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: { not: "doc-self" } }),
			}),
		);
	});
});

describe("terminal failure vs. a retry still pending", () => {
	it("reports a failed extraction as failed", async () => {
		withContexts([{ id: "ctx-1", extractionStatus: "FAILED" }]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("failed");
		expect(result.failed).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
	});

	it("reports an extraction whose attempt failed but is retrying as outstanding", async () => {
		// `extractionError` is written by the attempt; the status is what the
		// writer stamps when it gives up. A row still at PENDING is still coming.
		withContexts([
			{
				id: "ctx-1",
				extractionStatus: "PENDING",
				extractionError: "upstream timeout",
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("waiting");
		expect(result.outstanding).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
		expect(result.failed).toEqual([]);
	});

	it("reports a code index that has never indexed as failed", async () => {
		codeIndexGroupBy.mockResolvedValue([codeIndexGroup("FAILED", 1)]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("failed");
		expect(result.failed).toEqual([
			{ category: "codebaseIndexing", count: 1 },
		]);
	});

	it("only reads a failed code index that has no full index behind it", async () => {
		// A repository that indexed once and failed a refresh still has an index
		// to search, so a bad refresh must not refuse a generation.
		await resolveGenerationDependencies(ARGS);

		expect(codeIndexGroupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [
						expect.objectContaining({
							status: { in: ["PENDING", "INDEXING"] },
						}),
						expect.objectContaining({
							status: "FAILED",
							lastFullIndexAt: null,
						}),
					],
				}),
			}),
		);
	});

	it("prefers the failed verdict over the waiting one", async () => {
		withContexts([
			{ id: "ctx-1", extractionStatus: "FAILED" },
			{ id: "ctx-2", extractionStatus: "EXTRACTING" },
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("failed");
		expect(result.outstanding).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
		expect(result.failed).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
	});
});

/**
 * FIX for the arm that refused every generation in a project, forever.
 *
 * `sourceExtraction` and `codebaseIndexing` FAILED rows are the only two things
 * that can turn a wait into a non-retryable refusal. Read project-wide and
 * unbounded, one context that failed to extract months ago — a bad PDF, a dead
 * link, a since-deleted source — refused EVERY document generation the project
 * would ever ask for. Extraction failures are ordinary and nothing cleans them
 * up, so that was not a corner case.
 *
 * The arm's legitimate purpose is narrow and is preserved below: an input that
 * dies WHILE this request is waiting for it must still refuse the run.
 */
describe("a failure that predates the request", () => {
	const requestedAt = minutesAgo(2);

	it("does not refuse a run because a source failed long before it", async () => {
		withContexts([
			{
				id: "ctx-old",
				extractionStatus: "FAILED",
				updatedAt: minutesAgo(60 * 24 * 30),
			},
		]);

		const result = await resolveGenerationDependencies({
			...ARGS,
			generationStartedAt: requestedAt,
		});

		expect(result).toEqual({
			verdict: "clear",
			outstanding: [],
			failed: [],
		});
	});

	it("still refuses a run whose source fails while it waits", async () => {
		// The case the arm exists for, and the one that must survive the bound:
		// the row was fine when the run was dispatched and failed underneath it.
		withContexts([
			{
				id: "ctx-1",
				extractionStatus: "FAILED",
				updatedAt: minutesAgo(1),
			},
		]);

		const result = await resolveGenerationDependencies({
			...ARGS,
			generationStartedAt: requestedAt,
		});

		expect(result.verdict).toBe("failed");
		expect(result.failed).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
	});

	it("accepts the attempt time as the ISO string the workflow carries", async () => {
		// `Date` does not survive Temporal's payload converter, so the workflow
		// holds `generationStartedAt` as ISO-8601. Both spellings must scope the
		// same way, or the fix only works from in-process callers.
		withContexts([
			{
				id: "ctx-old",
				extractionStatus: "FAILED",
				updatedAt: minutesAgo(120),
			},
		]);

		const result = await resolveGenerationDependencies({
			...ARGS,
			generationStartedAt: requestedAt.toISOString(),
		});

		expect(result.verdict).toBe("clear");
	});

	it("scopes the code index's failed arm to the attempt as well", async () => {
		// Same shape, same fix: a repository whose first index failed last year
		// must not be a permanent refusal either.
		await resolveGenerationDependencies({
			...ARGS,
			generationStartedAt: requestedAt,
		});

		const [call] = codeIndexGroupBy.mock.calls;
		const [, failedArm] = call[0].where.OR;
		expect(failedArm).toEqual({
			status: "FAILED",
			lastFullIndexAt: null,
			updatedAt: { gte: requestedAt },
		});
	});

	it("stays bounded when the caller sends no attempt identity", async () => {
		// An older dispatcher sends nothing. That must not restore the unbounded
		// read — the arm falls back to the staleness window, which is coarser
		// than the truth but still has an exit.
		withContexts([
			{
				id: "ctx-old",
				extractionStatus: "FAILED",
				updatedAt: minutesAgo(60 * 24),
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("clear");
	});
});

/**
 * FIX for the wait with no ceiling.
 *
 * An outstanding row says work was in flight once, not that anything is still
 * doing it. A `PENDING` extraction nobody picked up, or a `urlActiveWorkflowId`
 * a crashed crawl never cleared, used to park every generation in the project
 * until Temporal's history limit ended the run — days. The bound is on SILENCE,
 * not duration, so a slow but progressing ingestion is never touched.
 */
describe("an in-flight row that has gone silent", () => {
	it("stops waiting on an extraction nothing has touched in an hour", async () => {
		withContexts([
			{
				id: "ctx-stuck",
				extractionStatus: "PENDING",
				updatedAt: minutesAgo(60),
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("clear");
	});

	it("keeps waiting on an extraction that is still being written to", async () => {
		withContexts([
			{
				id: "ctx-live",
				extractionStatus: "EXTRACTING",
				updatedAt: minutesAgo(5),
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.outstanding).toEqual([
			{ category: "sourceExtraction", count: 1 },
		]);
	});

	it("stops waiting on a crawl whose workflow id nobody cleared", async () => {
		// `updateParentStatusActivity` clears `urlActiveWorkflowId` on every
		// finalize — which is exactly what a crashed crawl never reaches.
		withContexts([
			{
				id: "ctx-crawl",
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "wf-dead",
				updatedAt: minutesAgo(90),
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("clear");
	});

	it("reads a background job's heartbeat, not its row age", async () => {
		// `heartbeatAt` is the column `failStaleBackgroundJobs` already sweeps
		// on, so a generation gives up on a dead job at the same moment the
		// background-job watchdog does rather than long after it.
		await resolveGenerationDependencies(ARGS);

		const { where } = jobGroupBy.mock.calls[0][0];
		expect(where.heartbeatAt.gte).toBeInstanceOf(Date);
		expect(where).not.toHaveProperty("updatedAt");
	});

	it("bounds the scan read too", async () => {
		await resolveGenerationDependencies(ARGS);

		const { where } = scanCount.mock.calls[0][0];
		expect(where.updatedAt.gte).toBeInstanceOf(Date);
	});

	it("gives a long-running index the whole staleness window, per source", async () => {
		// The conservative half of the bound. A codebase index legitimately runs
		// for tens of minutes and writes `indexedFileCount` on every embed
		// batch, so its row keeps resetting the clock. Twenty-five minutes into
		// the run with a write a minute ago is a LIVE index, and the wait holds.
		await resolveGenerationDependencies(ARGS);

		const liveArm = codeIndexGroupBy.mock.calls[0][0].where.OR[0];
		const windowMinutes =
			(Date.now() - liveArm.updatedAt.gte.getTime()) / 60_000;
		expect(windowMinutes).toBeGreaterThanOrEqual(29);
		expect(windowMinutes).toBeLessThanOrEqual(31);
	});

	it("honours FABRIC_DOCUMENT_GENERATION_STALE_MINUTES", async () => {
		// The same override the stale-generation watchdog reads, deliberately —
		// one deployment-level answer to "still plausibly alive?", not two.
		vi.stubEnv("FABRIC_DOCUMENT_GENERATION_STALE_MINUTES", "5");
		withContexts([
			{
				id: "ctx-1",
				extractionStatus: "PENDING",
				updatedAt: minutesAgo(10),
			},
		]);

		const result = await resolveGenerationDependencies(ARGS);

		expect(result.verdict).toBe("clear");
		vi.unstubAllEnvs();
	});
});

describe("the answer names nothing", () => {
	/** Every source loud at once, so every entry the probe can emit is present. */
	async function everythingAtOnce() {
		withContexts([
			{ id: "ctx-1", extractionStatus: "PENDING" },
			{ id: "ctx-2", extractionStatus: "FAILED" },
			{
				id: "ctx-3",
				extractionStatus: "COMPLETED",
				urlActiveWorkflowId: "wf-1",
			},
		]);
		codeIndexGroupBy.mockResolvedValue([
			codeIndexGroup("INDEXING", 1),
			codeIndexGroup("FAILED", 1),
		]);
		jobGroupBy.mockResolvedValue([
			jobGroup("CODE_INDEXING", 1),
			jobGroup("SLACK_BACKFILL", 1),
		]);
		scanCount.mockResolvedValue(1);
		withDocuments([{ id: "doc-1", type: "PRD", status: "GENERATING" }]);

		return await resolveGenerationDependencies({
			...ARGS,
			documentType: "ARCHITECTURE",
		});
	}

	it("emits every category and nothing but a category and a count", async () => {
		const result = await everythingAtOnce();
		const entries = [...result.outstanding, ...result.failed];

		expect(result.outstanding.map((entry) => entry.category)).toEqual([
			"codebaseIndexing",
			"sourceExtraction",
			"linkedSiteCrawl",
			"securityScan",
			"monitorIngestion",
			"prerequisiteDocument",
		]);

		for (const entry of entries) {
			// The guard: an entry has no field a name, a path, an id or any other
			// free text could ever be written into. Adding one fails here.
			expect(Object.keys(entry).sort()).toEqual(["category", "count"]);
			expect(GENERATION_DEPENDENCY_CATEGORIES).toContain(entry.category);
			expect(typeof entry.count).toBe("number");
		}
	});

	it("only ever emits a category from the fixed set", async () => {
		expect([...GENERATION_DEPENDENCY_CATEGORIES]).toEqual([
			"codebaseIndexing",
			"sourceExtraction",
			"linkedSiteCrawl",
			"securityScan",
			"monitorIngestion",
			"prerequisiteDocument",
		]);
	});

	it("survives a round trip through JSON unchanged", async () => {
		// The answer crosses a Temporal activity boundary, so a Set, a Map or a
		// Date anywhere in it would arrive as something else on the other side.
		const result = await everythingAtOnce();

		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});
});
