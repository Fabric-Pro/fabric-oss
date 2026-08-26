/**
 * A failed backfill must report its own reason.
 *
 * Regression guard for a defect found while testing on staging: the activity
 * opened a job row and never closed it on the failing path, so a backfill that
 * died left the row RUNNING until the watchdog stamped it "Timed out — no
 * progress reported". The panel then showed an invented reason in place of the
 * real one ("Slack API returned invalid_auth", say), which is the opposite of
 * what the Job Hub exists to do.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const jobMocks = vi.hoisted(() => ({
	jobEnsure: vi.fn(),
	jobStep: vi.fn(),
	jobComplete: vi.fn(),
	jobFail: vi.fn(),
	jobHeartbeat: vi.fn(),
}));

vi.mock("../../lib/job-progress", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...jobMocks };
});

// The run itself is not under test here — only that its failure is reported.
// `getSlackCredentials` is the first real dependency it reaches.
const runMocks = vi.hoisted(() => ({
	getSlackCredentials: vi.fn(),
}));

vi.mock("@repo/integrations/slack", () => runMocks);

const dbMocks = vi.hoisted(() => ({
	markSlackChannelBackfillComplete: vi.fn(),
	recordSlackChannelFailure: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return { ...actual, ...dbMocks };
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "slack-channel-backfill:proj-1",
					runId: "run-1",
				},
				heartbeatDetails: undefined,
			},
			heartbeat: vi.fn(),
		}),
	},
	heartbeat: vi.fn(),
}));

import { backfillSlackChannelActivity } from "../backfill-slack-channel";

const INPUT = {
	projectId: "proj-1",
	linkedChannelId: "chan-1",
	slackTeamId: "T1",
	channelId: "C1",
	channelDisplayName: "test-integrations",
	channelWebUrl: null,
	userId: "user-1",
	organizationId: "org-1",
	oldestTs: undefined,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("backfillSlackChannelActivity", () => {
	it("closes the job with the real reason when the run throws", async () => {
		// Any failure inside the run — here, the workspace token lookup.
		runMocks.getSlackCredentials.mockRejectedValue(
			new Error("invalid_auth"),
		);

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).rejects.toThrow();

		expect(jobMocks.jobFail).toHaveBeenCalledWith(
			expect.stringContaining("invalid_auth"),
			expect.objectContaining({ sourceId: "chan-1" }),
		);
	});

	it("rethrows so Temporal's retry and failure handling is unchanged", async () => {
		const boom = new Error("boom");
		runMocks.getSlackCredentials.mockRejectedValue(boom);

		await expect(backfillSlackChannelActivity(INPUT as never)).rejects.toBe(
			boom,
		);
	});

	it("does not close the job as failed when the run succeeds", async () => {
		// A real success: credentials resolve and Slack returns one empty page,
		// so the run reaches its own jobComplete. The wrapper must stay out of
		// the way. (Without a genuine success here the assertion would hold for
		// any failing run and would pass with the wrapper deleted.)
		runMocks.getSlackCredentials.mockResolvedValue({
			botToken: "xoxb-test",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ ok: true, messages: [], has_more: false }),
			})),
		);

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).resolves.toMatchObject({ rootsScanned: 0 });

		expect(jobMocks.jobFail).not.toHaveBeenCalled();
		expect(jobMocks.jobComplete).toHaveBeenCalled();
	});

	it("marks the failure retryable so a retry reopens the row instead of opening another", async () => {
		// The activity runs with maximumAttempts: 3 and one workflow id. Since
		// `ensureRunningBackgroundJob` looks only for RUNNING rows, a plain
		// close would have attempt 2 open a second row — one run, three cards.
		runMocks.getSlackCredentials.mockRejectedValue(
			new Error("invalid_auth"),
		);

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).rejects.toThrow();

		expect(jobMocks.jobFail).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ errorClass: "ActivityFailed" }),
		);
	});

	it("mirrors the reason onto the channel row, not just the panel", async () => {
		runMocks.getSlackCredentials.mockRejectedValue(
			new Error("invalid_auth"),
		);

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).rejects.toThrow();

		// Someone who just pressed "Monitor now" looks at the channel row.
		expect(dbMocks.recordSlackChannelFailure).toHaveBeenCalledWith(
			"chan-1",
			expect.stringContaining("invalid_auth"),
		);
	});

	it("leaves the row alone when the attempt is cancelled", async () => {
		// Temporal is shutting this attempt down and may rerun it elsewhere;
		// closing the row would report a failure for work still in flight.
		const cancelled = new Error("activity cancelled");
		cancelled.name = "CancelledFailure";
		runMocks.getSlackCredentials.mockRejectedValue(cancelled);

		await expect(
			backfillSlackChannelActivity(INPUT as never),
		).rejects.toThrow();

		expect(jobMocks.jobFail).not.toHaveBeenCalled();
		expect(dbMocks.recordSlackChannelFailure).not.toHaveBeenCalled();
	});
});
