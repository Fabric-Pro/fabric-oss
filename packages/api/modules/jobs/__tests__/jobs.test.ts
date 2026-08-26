/**
 * Tests for the `jobs.list` and `jobs.activeCount` procedure handlers.
 *
 * Handlers are called directly via `procedure["~orpc"].handler`, bypassing the
 * middleware pipeline — the same pattern as the other procedure tests in this
 * package (see `audit/__tests__/list.test.ts`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listBackgroundJobsForUser: vi.fn(),
	countActiveBackgroundJobs: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listBackgroundJobsForUser: mocks.listBackgroundJobsForUser,
		countActiveBackgroundJobs: mocks.countActiveBackgroundJobs,
	};
});

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { activeJobCountProcedure } from "../procedures/active-count";
import { listJobsProcedure } from "../procedures/list";

function makeContext(activeOrganizationId?: string) {
	return {
		user: { id: "user-1", email: "a@example.com", name: "A" },
		session: { id: "session-1", activeOrganizationId },
		headers: new Headers(),
	};
}

function makeJob(over: Record<string, unknown> = {}) {
	return {
		id: "job-1",
		kind: "CODE_INDEXING",
		status: "RUNNING",
		title: "acme/api",
		sourceType: "repositoryIntegration",
		sourceId: "int-1",
		counts: { filesProcessed: 12, totalFiles: 100 },
		steps: [{ key: "clone", status: "completed" }],
		error: null,
		errorClass: null,
		projectId: "proj-1",
		projectName: "Acme",
		startedAt: new Date("2026-08-03T10:00:00.000Z"),
		completedAt: null,
		createdAt: new Date("2026-08-03T10:00:00.000Z"),
		...over,
	};
}

/** Reach past the middleware pipeline to the raw handler. */
type ProcedureInternals = {
	"~orpc": {
		handler: (args: {
			input: Record<string, unknown>;
			context: unknown;
		}) => Promise<Record<string, never>>;
	};
};

const callList = (input: Record<string, unknown>, context: unknown) =>
	(listJobsProcedure as unknown as ProcedureInternals)["~orpc"].handler({
		input,
		context,
	});

const callCount = (input: Record<string, unknown>, context: unknown) =>
	(activeJobCountProcedure as unknown as ProcedureInternals)["~orpc"].handler(
		{
			input,
			context,
		},
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.listBackgroundJobsForUser.mockResolvedValue([]);
	mocks.countActiveBackgroundJobs.mockResolvedValue(0);
	delete process.env.FABRIC_JOB_RETENTION_DAYS;
});

describe("jobs.list", () => {
	it("scopes the query to the caller and the requested organization", async () => {
		await callList({ organizationId: "org-1", limit: 50 }, makeContext());

		expect(mocks.listBackgroundJobsForUser).toHaveBeenCalledWith(
			expect.objectContaining({
				filter: { userId: "user-1", organizationId: "org-1" },
				limit: 50,
			}),
		);
	});

	it("passes an explicit null organization for personal context", async () => {
		await callList({ organizationId: null, limit: 50 }, makeContext());

		// XOR tenancy: a missing null would let org jobs leak into the personal
		// workspace.
		expect(mocks.listBackgroundJobsForUser.mock.calls[0][0].filter).toEqual(
			{
				userId: "user-1",
				organizationId: null,
			},
		);
	});

	it("serializes dates and preserves counts and steps for the panel", async () => {
		mocks.listBackgroundJobsForUser.mockResolvedValue([
			makeJob({
				status: "FAILED",
				error: "Authentication token expired. Re-connect to retry.",
				completedAt: new Date("2026-08-03T10:05:00.000Z"),
			}),
		]);

		const result = await callList({ limit: 50 }, makeContext("org-1"));

		expect(result.jobs[0]).toMatchObject({
			id: "job-1",
			status: "FAILED",
			projectName: "Acme",
			error: "Authentication token expired. Re-connect to retry.",
			startedAt: "2026-08-03T10:00:00.000Z",
			completedAt: "2026-08-03T10:05:00.000Z",
			counts: { filesProcessed: 12, totalFiles: 100 },
		});
		expect(result.jobs[0].steps).toEqual([
			{ key: "clone", status: "completed" },
		]);
	});

	it("defaults the retention window to 7 days", async () => {
		const result = await callList({ limit: 50 }, makeContext("org-1"));

		expect(
			mocks.listBackgroundJobsForUser.mock.calls[0][0].retentionDays,
		).toBe(7);
		expect(result.retentionDays).toBe(7);
	});

	it("honours FABRIC_JOB_RETENTION_DAYS within the supported range", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "3";
		await callList({ limit: 50 }, makeContext("org-1"));
		expect(
			mocks.listBackgroundJobsForUser.mock.calls[0][0].retentionDays,
		).toBe(3);
	});

	it("clamps an out-of-range retention override instead of trusting it", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "0";
		await callList({ limit: 50 }, makeContext("org-1"));
		// 0 would make every finished job invisible the moment it completes.
		expect(
			mocks.listBackgroundJobsForUser.mock.calls[0][0].retentionDays,
		).toBe(1);
	});

	it("ignores a non-numeric retention override", async () => {
		process.env.FABRIC_JOB_RETENTION_DAYS = "soon";
		await callList({ limit: 50 }, makeContext("org-1"));
		expect(
			mocks.listBackgroundJobsForUser.mock.calls[0][0].retentionDays,
		).toBe(7);
	});
});

describe("jobs.activeCount", () => {
	it("counts running jobs for the resolved tenant", async () => {
		mocks.countActiveBackgroundJobs.mockResolvedValue(3);

		const result = await callCount(
			{ organizationId: "org-1" },
			makeContext(),
		);

		expect(result).toEqual({ count: 3 });
		expect(mocks.countActiveBackgroundJobs).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("counts personal jobs when no organization is active", async () => {
		await callCount({ organizationId: null }, makeContext());

		expect(mocks.countActiveBackgroundJobs).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: null,
		});
	});
});
