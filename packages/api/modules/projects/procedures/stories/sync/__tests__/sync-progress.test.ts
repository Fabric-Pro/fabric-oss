import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		backgroundJobFindFirst: vi.fn(),
		query: vi.fn(),
		describe: vi.fn(),
		result: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: { backgroundJob: { findFirst: mocks.backgroundJobFindFirst } },
}));

vi.mock("@repo/temporal", () => ({
	storySyncProgressQuery: { name: "progress" },
	getTemporalClient: vi.fn(async () => ({
		workflow: {
			getHandle: () => ({
				query: mocks.query,
				describe: mocks.describe,
				result: mocks.result,
			}),
		},
	})),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { STORY_UPDATE: "story:update" },
	};
});

import { syncProgressProcedure } from "../sync-progress";

const handler = (syncProgressProcedure as any).handler as (args: {
	input: { projectId: string; workflowId: string };
}) => Promise<Record<string, unknown>>;

const WORKFLOW_ID = "story-sync-proj-1-1700000000000";

const runningProgress = {
	status: "syncing",
	totalStories: 3,
	syncedCount: 1,
	failedCount: 0,
	conflictedCount: 0,
	message: "Syncing...",
	results: [],
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.backgroundJobFindFirst.mockResolvedValue({ status: "RUNNING" });
});

describe("syncProgressProcedure — jobStatus", () => {
	it("attaches the PM_STORY_SYNC row's status to the queried progress", async () => {
		mocks.query.mockResolvedValue(runningProgress);

		const result = await handler({
			input: { projectId: "proj-1", workflowId: WORKFLOW_ID },
		});

		expect(result).toEqual({
			...runningProgress,
			jobStatus: "RUNNING",
			jobFailedCount: null,
		});
	});

	it("scopes the row read to the workflow AND the authorized project", async () => {
		mocks.query.mockResolvedValue(runningProgress);

		await handler({
			input: { projectId: "proj-1", workflowId: WORKFLOW_ID },
		});

		expect(mocks.backgroundJobFindFirst).toHaveBeenCalledWith({
			where: {
				workflowId: WORKFLOW_ID,
				projectId: "proj-1",
				kind: "PM_STORY_SYNC",
			},
			orderBy: { createdAt: "desc" },
			select: { status: true, counts: true },
		});
	});

	it("keeps the invented `completed` distinguishable: jobStatus stays whatever the row says", async () => {
		mocks.query.mockRejectedValue(new Error("query failed"));
		mocks.describe.mockRejectedValue(new Error("describe failed"));
		mocks.result.mockRejectedValue(new Error("Result timeout"));
		mocks.backgroundJobFindFirst.mockResolvedValue(null);

		const result = await handler({
			input: { projectId: "proj-1", workflowId: WORKFLOW_ID },
		});

		expect(result).toMatchObject({
			status: "completed",
			message: "Sync completed",
			jobStatus: null,
		});
	});

	it("reports COMPLETED from the row once the run has closed it", async () => {
		mocks.query.mockResolvedValue({
			...runningProgress,
			status: "completed",
			message: "Sync complete.",
		});
		mocks.backgroundJobFindFirst.mockResolvedValue({ status: "COMPLETED" });

		const result = await handler({
			input: { projectId: "proj-1", workflowId: WORKFLOW_ID },
		});

		expect(result).toMatchObject({
			status: "completed",
			jobStatus: "COMPLETED",
		});
	});

	it("reports the row's own failure count when the progress is synthesized", async () => {
		mocks.query.mockRejectedValue(new Error("query failed"));
		mocks.describe.mockRejectedValue(new Error("describe failed"));
		mocks.result.mockRejectedValue(new Error("Result timeout"));
		mocks.backgroundJobFindFirst.mockResolvedValue({
			status: "COMPLETED",
			counts: { total: 4, synced: 3, failed: 1, conflicted: 0 },
		});

		const result = await handler({
			input: { projectId: "proj-1", workflowId: WORKFLOW_ID },
		});

		expect(result).toMatchObject({
			failedCount: 0,
			jobStatus: "COMPLETED",
			jobFailedCount: 1,
		});
	});

	it("rejects a workflow id from another project before any read", async () => {
		await expect(
			handler({
				input: {
					projectId: "proj-1",
					workflowId: "story-sync-proj-2-1700000000000",
				},
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mocks.query).not.toHaveBeenCalled();
		expect(mocks.backgroundJobFindFirst).not.toHaveBeenCalled();
	});
});
