import { beforeEach, describe, expect, it, vi } from "vitest";

const backgroundJob = vi.hoisted(() => ({
	create: vi.fn(),
	findFirst: vi.fn(),
	findMany: vi.fn(),
	update: vi.fn(),
	updateMany: vi.fn(),
	deleteMany: vi.fn(),
	count: vi.fn(),
}));

const tx = vi.hoisted(() => ({ backgroundJob }));

const executeRaw = vi.hoisted(() => vi.fn());

vi.mock("../prisma/client", async () => {
	// The real `Prisma` namespace is needed for `Prisma.sql` template tagging
	// (the counter merge is built by chaining tagged templates); only the client
	// itself is stubbed.
	const { Prisma } = await import("../prisma/generated/client");
	return {
		db: {
			backgroundJob,
			$executeRaw: executeRaw,
			$transaction: vi.fn(async (fn: any) => fn(tx)),
		},
		Prisma,
	};
});

import {
	completeBackgroundJob,
	completeBackgroundJobs,
	countActiveBackgroundJobs,
	createBackgroundJob,
	ensureRunningBackgroundJob,
	failBackgroundJob,
	failStaleBackgroundJobs,
	incrementBackgroundJobCounts,
	listBackgroundJobsForUser,
	purgeExpiredBackgroundJobs,
	seedSteps,
	setBackgroundJobStep,
} from "../prisma/queries/background-jobs";

const BASE = {
	kind: "TEAMS_CHANNEL_MONITOR" as const,
	title: "Teams · #general",
	projectId: "p1",
	userId: "u1",
	organizationId: "org1",
	workflowId: "wf-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	backgroundJob.create.mockResolvedValue({ id: "job-1" });
	backgroundJob.findFirst.mockResolvedValue(null);
	backgroundJob.updateMany.mockResolvedValue({ count: 1 });
	backgroundJob.update.mockResolvedValue({ id: "job-1" });
	backgroundJob.deleteMany.mockResolvedValue({ count: 0 });
	backgroundJob.findMany.mockResolvedValue([]);
	backgroundJob.count.mockResolvedValue(0);
	executeRaw.mockResolvedValue(1);
});

/**
 * No RUNNING row, one FAILED row eligible for reopen. Keyed on `where.status`
 * so the two `findFirst` lookups inside `ensureRunningBackgroundJob` cannot be
 * mixed up by call order.
 */
function findFirstByStatus(retryable: unknown) {
	backgroundJob.findFirst.mockImplementation(
		async (args: { where?: { status?: string } }) =>
			args?.where?.status === "FAILED" ? retryable : null,
	);
}

describe("ensureRunningBackgroundJob", () => {
	it("adopts the existing open row instead of creating a duplicate", async () => {
		backgroundJob.findFirst.mockResolvedValue({ id: "existing" });

		const id = await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
		});

		expect(id).toBe("existing");
		expect(backgroundJob.create).not.toHaveBeenCalled();
		expect(backgroundJob.findFirst).toHaveBeenCalledWith({
			where: {
				workflowId: "wf-1",
				sourceId: "chan-1",
				status: "RUNNING",
			},
			select: { id: true },
		});
	});

	it("creates the row when the workflow has no open job yet", async () => {
		const id = await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
			steps: seedSteps(["fetch", "analyze"]),
		});

		expect(id).toBe("job-1");
		const data = backgroundJob.create.mock.calls[0][0].data;
		expect(data.workflowId).toBe("wf-1");
		expect(data.sourceId).toBe("chan-1");
		expect(data.steps).toEqual([
			{ key: "fetch", status: "pending" },
			{ key: "analyze", status: "pending" },
		]);
	});

	it("adopts the winner's row when the partial unique index rejects a race (P2002)", async () => {
		backgroundJob.findFirst
			.mockResolvedValueOnce(null) // pre-check: nothing open yet
			.mockResolvedValueOnce({ id: "winner" }); // post-P2002 re-read
		backgroundJob.create.mockRejectedValue(
			Object.assign(new Error("unique violation"), { code: "P2002" }),
		);

		const id = await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
		});

		expect(id).toBe("winner");
	});

	it("reopens the row it failed on the previous attempt instead of opening a second", async () => {
		// Keyed on the lookup rather than on call order: `vi.clearAllMocks()`
		// does not drain a `mockResolvedValueOnce` queue, so an unconsumed one
		// leaks into the next test.
		findFirstByStatus({ id: "failed-1", steps: [] });

		const id = await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
			reopenFailedWithClass: "BackfillRetry",
		});

		expect(id).toBe("failed-1");
		expect(backgroundJob.create).not.toHaveBeenCalled();
		expect(backgroundJob.update.mock.calls[0][0].data.status).toBe(
			"RUNNING",
		);
	});

	it("restores steps the close swept to `skipped`, keeping progress that was real", async () => {
		findFirstByStatus({
			id: "failed-1",
			steps: [
				{ key: "fetch", status: "completed", completedAt: "t0" },
				{ key: "analyze", status: "failed", error: "upstream 500" },
				{ key: "propose", status: "skipped" },
			],
		});

		await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
			reopenFailedWithClass: "BackfillRetry",
		});

		expect(backgroundJob.update.mock.calls[0][0].data.steps).toEqual([
			{ key: "fetch", status: "completed", completedAt: "t0" },
			{ key: "analyze", status: "failed", error: "upstream 500" },
			{ key: "propose", status: "pending" },
		]);
	});

	it("does not reopen a fully swept row looking finished", async () => {
		// The shape a start-failure close leaves behind: every step swept. The
		// card counts `skipped` as settled, so without the restore this renders
		// "3/3 steps" on a RUNNING job that has not begun.
		findFirstByStatus({
			id: "failed-1",
			steps: [
				{ key: "collect", status: "skipped" },
				{ key: "summarize", status: "skipped" },
				{ key: "persist", status: "skipped" },
			],
		});

		await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
			reopenFailedWithClass: "PublishingStartFailed",
		});

		expect(backgroundJob.update.mock.calls[0][0].data.steps).toEqual([
			{ key: "collect", status: "pending" },
			{ key: "summarize", status: "pending" },
			{ key: "persist", status: "pending" },
		]);
	});

	it("writes no steps at all when the reopened row had none swept", async () => {
		// Guards the erase hazard: if `steps` ever drops out of the select, the
		// restore must stay silent rather than write an empty list over the row.
		findFirstByStatus({
			id: "failed-1",
			steps: [{ key: "collect", status: "running" }],
		});

		await ensureRunningBackgroundJob({
			...BASE,
			sourceId: "chan-1",
			reopenFailedWithClass: "PublishingStartFailed",
		});

		expect(backgroundJob.update.mock.calls[0][0].data).not.toHaveProperty(
			"steps",
		);
	});

	it("never throws when the database is unreachable — telemetry must not break the pipeline", async () => {
		backgroundJob.findFirst.mockRejectedValue(new Error("connection lost"));

		await expect(
			ensureRunningBackgroundJob({ ...BASE }),
		).resolves.toBeNull();
	});
});

describe("createBackgroundJob", () => {
	it("creates the row when the workflow has no open job", async () => {
		await createBackgroundJob({ ...BASE, kind: "CODE_INDEXING" });

		expect(backgroundJob.create).toHaveBeenCalled();
	});

	it("adopts an open row instead of failing it as superseded", async () => {
		backgroundJob.findFirst.mockResolvedValue({ id: "already-open" });

		const id = await createBackgroundJob({
			...BASE,
			kind: "CODE_INDEXING",
		});

		// The row is created just after workflow.start returns, by which time an
		// activity may already have opened one. Replacing it would show a red
		// "superseded" row for a run that is proceeding normally.
		expect(id).toBe("already-open");
		expect(backgroundJob.create).not.toHaveBeenCalled();
		expect(backgroundJob.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "already-open" } }),
		);
	});
});

describe("incrementBackgroundJobCounts", () => {
	it("increments through a single atomic statement", async () => {
		await incrementBackgroundJobCounts(
			{ workflowId: "wf-1", sourceId: "chan-1" },
			{ threadsAnalyzed: 1, proposalsCreated: 1 },
		);

		expect(executeRaw).toHaveBeenCalledTimes(1);
		const sql = executeRaw.mock.calls[0][0];
		expect(sql.strings.join("")).toContain("jsonb_build_object");
		expect(sql.values).toEqual(
			expect.arrayContaining([
				"wf-1",
				"chan-1",
				"threadsAnalyzed",
				1,
				"proposalsCreated",
				1,
			]),
		);
	});

	it("skips the write entirely when there is nothing to add", async () => {
		await incrementBackgroundJobCounts({ workflowId: "wf-1" }, {});
		expect(executeRaw).not.toHaveBeenCalled();
	});
});

describe("setBackgroundJobStep", () => {
	it("preserves the original start time when a step re-enters running", async () => {
		backgroundJob.findFirst.mockResolvedValue({
			id: "job-1",
			steps: [
				{
					key: "clone",
					status: "running",
					startedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		});

		// continueAsNew re-runs early steps; the clock must not restart.
		await setBackgroundJobStep({ workflowId: "wf-1" }, "clone", "running");

		const steps = backgroundJob.update.mock.calls[0][0].data.steps;
		expect(steps[0].startedAt).toBe("2026-01-01T00:00:00.000Z");
	});

	it("stamps completedAt and the error when a step fails", async () => {
		backgroundJob.findFirst.mockResolvedValue({
			id: "job-1",
			steps: [{ key: "clone", status: "running" }],
		});

		await setBackgroundJobStep(
			{ workflowId: "wf-1" },
			"clone",
			"failed",
			"auth denied",
		);

		const steps = backgroundJob.update.mock.calls[0][0].data.steps;
		expect(steps[0].status).toBe("failed");
		expect(steps[0].error).toBe("auth denied");
		expect(steps[0].completedAt).toBeTruthy();
	});

	it("appends an unknown step key rather than dropping the transition", async () => {
		backgroundJob.findFirst.mockResolvedValue({ id: "job-1", steps: [] });

		await setBackgroundJobStep(
			{ workflowId: "wf-1" },
			"embed",
			"completed",
		);

		const steps = backgroundJob.update.mock.calls[0][0].data.steps;
		expect(steps).toHaveLength(1);
		expect(steps[0].key).toBe("embed");
	});
});

describe("closing jobs", () => {
	it("completeBackgroundJobs closes every open row of the workflow", async () => {
		await completeBackgroundJobs("wf-1");

		// One monitor tick opens one row per channel; the tick-end activity
		// closes them all with a single call.
		const call = backgroundJob.updateMany.mock.calls[0][0];
		expect(call.where.workflowId).toBe("wf-1");
		expect(call.data).toEqual(
			expect.objectContaining({ status: "COMPLETED" }),
		);
	});

	it("marks steps the run never reached as skipped, not queued", async () => {
		backgroundJob.findMany.mockResolvedValue([
			{
				id: "job-1",
				steps: [
					{ key: "clone", status: "completed" },
					{ key: "symbols", status: "pending" },
					{ key: "finalize", status: "completed" },
				],
			},
		]);

		await completeBackgroundJob({ workflowId: "wf-1", sourceId: "repo-1" });

		// Left as "pending", a finished job renders a middle step as QUEUED with
		// the steps after it COMPLETE — an incoherent picture of a run that is
		// over. Some steps are genuinely conditional, so claiming they completed
		// would be the other kind of lie.
		const swept = backgroundJob.update.mock.calls.at(-1)?.[0];
		expect(swept.data.steps).toEqual([
			{ key: "clone", status: "completed" },
			{ key: "symbols", status: "skipped" },
			{ key: "finalize", status: "completed" },
		]);
	});

	it("writes the final counts before flipping status, not after", async () => {
		await completeBackgroundJobs("wf-1", { counts: { filesIndexed: 42 } });

		// The counts UPDATE only matches rows that are still RUNNING, so doing
		// it after the status flip would silently discard them.
		const countsCallOrder = executeRaw.mock.invocationCallOrder[0];
		const statusCallOrder =
			backgroundJob.updateMany.mock.invocationCallOrder[0];
		expect(countsCallOrder).toBeLessThan(statusCallOrder);
	});

	it("lets a source's own success repair a job the watchdog wrongly timed out", async () => {
		await completeBackgroundJob({ workflowId: "wf-1", sourceId: "chan-1" });

		// The watchdog only guesses that a quiet job died. If that source's work
		// then finishes, a RUNNING-only compare-and-set would leave the row
		// wrongly FAILED forever.
		const where = backgroundJob.updateMany.mock.calls[0][0].where;
		expect(where.OR).toEqual([
			{ status: "RUNNING" },
			{ status: "FAILED", errorClass: "TimedOut" },
		]);
		expect(backgroundJob.updateMany.mock.calls[0][0].data.error).toBeNull();
	});

	it("never overwrites a genuine failure with success", async () => {
		await completeBackgroundJob({ workflowId: "wf-1", sourceId: "chan-1" });

		// Only the watchdog's own errorClass is repairable — a real failure
		// (any other class, e.g. an expired token) must stay failed.
		const where = backgroundJob.updateMany.mock.calls[0][0].where;
		const repairable = where.OR.filter(
			(clause: { status: string }) => clause.status === "FAILED",
		);
		expect(repairable).toHaveLength(1);
		expect(repairable[0].errorClass).toBe("TimedOut");
	});

	it("does not repair when the close is not scoped to one source", async () => {
		await completeBackgroundJob({ workflowId: "wf-1" });

		// Without a sourceId the update is workflow-wide, and workflow ids are
		// reused: monitors keep one across ticks, per-repo indexing across runs.
		// Repairing there would let a later tick resurrect an earlier tick's
		// genuinely-dead job as a green "Completed" and erase its error.
		const where = backgroundJob.updateMany.mock.calls[0][0].where;
		expect(where.status).toBe("RUNNING");
		expect(where.OR).toBeUndefined();
	});

	it("never repairs on the workflow-scoped close", async () => {
		await completeBackgroundJobs("wf-1");

		const where = backgroundJob.updateMany.mock.calls[0][0].where;
		expect(where.status).toBe("RUNNING");
		expect(where.OR).toBeUndefined();
	});

	it("settles the steps of a failed job too, not just a completed one", async () => {
		backgroundJob.findMany.mockResolvedValue([
			{
				id: "job-1",
				steps: [
					{ key: "clone", status: "completed" },
					{ key: "embed", status: "running" },
					{ key: "finalize", status: "pending" },
				],
			},
		]);

		await failBackgroundJob(
			{ workflowId: "wf-1", sourceId: "repo-1" },
			{
				error: "Cancelled before indexing finished.",
				errorClass: "Cancelled",
			},
		);

		// Otherwise the step it died on keeps a spinner running on a dead row,
		// and the ones after it read "Queued" forever.
		const swept = backgroundJob.update.mock.calls.at(-1)?.[0];
		expect(swept.data.steps).toEqual([
			{ key: "clone", status: "completed" },
			{ key: "embed", status: "skipped" },
			{ key: "finalize", status: "skipped" },
		]);
	});

	it("only ever fails a row that is still RUNNING", async () => {
		await failBackgroundJob(
			{ workflowId: "wf-1", sourceId: "chan-1" },
			{ error: "token expired", errorClass: "AuthError" },
		);

		// Compare-and-set on RUNNING: a job already closed can never be
		// re-failed by a late-arriving activity.
		const call = backgroundJob.updateMany.mock.calls[0][0];
		expect(call.where.status).toBe("RUNNING");
		expect(call.data.error).toBe("token expired");
		expect(call.data.errorClass).toBe("AuthError");
	});
});

describe("listBackgroundJobsForUser", () => {
	it("scopes to the org and keeps running jobs visible past the retention cutoff", async () => {
		await listBackgroundJobsForUser({
			filter: { userId: "u1", organizationId: "org1" },
			retentionDays: 7,
			limit: 50,
		});

		const where = backgroundJob.findMany.mock.calls[0][0].where;
		expect(where.organizationId).toBe("org1");
		expect(where.OR[0]).toEqual({ status: "RUNNING" });
		expect(where.OR[1].createdAt.gte).toBeInstanceOf(Date);
		// Job visibility never exceeds project visibility.
		expect(where.project.OR[0]).toEqual({ userId: "u1" });
	});

	it("requires an explicit null organizationId in personal context", async () => {
		await listBackgroundJobsForUser({
			filter: { userId: "u1", organizationId: null },
			retentionDays: 7,
			limit: 50,
		});

		const where = backgroundJob.findMany.mock.calls[0][0].where;
		// XOR tenancy: without the explicit null, org jobs would leak into the
		// personal workspace.
		expect(where.organizationId).toBeNull();
		expect(where.userId).toBe("u1");
	});

	it("maps rows to the panel DTO, defaulting absent counts and steps", async () => {
		backgroundJob.findMany.mockResolvedValue([
			{
				id: "j1",
				kind: "CODE_INDEXING",
				status: "RUNNING",
				title: "acme/api",
				sourceType: "repositoryIntegration",
				sourceId: "int-1",
				counts: null,
				steps: null,
				error: null,
				errorClass: null,
				projectId: "p1",
				startedAt: new Date(),
				completedAt: null,
				createdAt: new Date(),
				project: { name: "Acme" },
			},
		]);

		const [job] = await listBackgroundJobsForUser({
			filter: { userId: "u1", organizationId: "org1" },
			retentionDays: 7,
			limit: 50,
		});

		expect(job.projectName).toBe("Acme");
		expect(job.counts).toEqual({});
		expect(job.steps).toEqual([]);
	});
});

describe("countActiveBackgroundJobs", () => {
	it("counts only running jobs the user can reach", async () => {
		await countActiveBackgroundJobs({
			userId: "u1",
			organizationId: "org1",
		});

		const where = backgroundJob.count.mock.calls[0][0].where;
		expect(where.status).toBe("RUNNING");
		expect(where.organizationId).toBe("org1");
		expect(where.project).toBeDefined();
	});
});

describe("retention and watchdog", () => {
	it("stops purging once a short batch comes back", async () => {
		backgroundJob.findMany
			.mockResolvedValueOnce(
				Array.from({ length: 2 }, (_, i) => ({ id: `old-${i}` })),
			)
			.mockResolvedValue([]);
		backgroundJob.deleteMany.mockResolvedValue({ count: 2 });

		const result = await purgeExpiredBackgroundJobs({
			retentionDays: 7,
			batchSize: 5,
		});

		expect(result).toEqual({ deleted: 2, batches: 1 });
		expect(backgroundJob.findMany).toHaveBeenCalledTimes(1);
	});

	it("respects the batch safety cap", async () => {
		backgroundJob.findMany.mockResolvedValue([{ id: "a" }, { id: "b" }]);
		backgroundJob.deleteMany.mockResolvedValue({ count: 2 });

		const result = await purgeExpiredBackgroundJobs({
			retentionDays: 7,
			batchSize: 2,
			maxBatches: 3,
		});

		expect(result.batches).toBe(3);
	});

	it("fails jobs whose heartbeat went stale", async () => {
		backgroundJob.updateMany.mockResolvedValue({ count: 4 });

		const failed = await failStaleBackgroundJobs({ staleMinutes: 15 });

		expect(failed).toBe(4);
		const call = backgroundJob.updateMany.mock.calls[0][0];
		expect(call.where.status).toBe("RUNNING");
		expect(call.where.heartbeatAt.lt).toBeInstanceOf(Date);
		expect(call.data.errorClass).toBe("TimedOut");
	});
});
