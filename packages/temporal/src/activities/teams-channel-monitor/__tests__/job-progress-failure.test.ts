/**
 * A failed channel must not be reported as a success.
 *
 * Regression guard for the sequence that made this feature lie: the failure
 * hook opened a job row and marked its `fetch` step failed, but left the row
 * RUNNING — and the workflow calls the tick-end activity immediately after,
 * which closes every row still RUNNING as COMPLETED. The panel then rendered a
 * green "Completed" badge with no reason for a channel whose token had expired,
 * which is precisely the misreport the Job Hub exists to remove.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	getTeamsLinkedChannelJobContext: vi.fn(),
	recordTeamsChannelFailure: vi.fn(),
	updateTeamsChannelMonitorLastRun: vi.fn(),
	ensureRunningBackgroundJob: vi.fn(),
	incrementBackgroundJobCounts: vi.fn(),
	setBackgroundJobStep: vi.fn(),
	failBackgroundJob: vi.fn(),
	completeBackgroundJobs: vi.fn(),
	seedSteps: (keys: string[]) =>
		keys.map((key) => ({ key, status: "pending" })),
}));

vi.mock("@repo/database", () => dbMocks);

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The activity resolves its workflow id from the activity context.
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			info: {
				workflowExecution: {
					workflowId: "teams-channel-monitor-proj-1",
					runId: "run-1",
				},
			},
		}),
	},
	heartbeat: vi.fn(),
}));

import {
	recordTeamsChannelFailureActivity,
	updateTeamsChannelMonitorLastRunActivity,
} from "../fetch-channel-cursor";

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.getTeamsLinkedChannelJobContext.mockResolvedValue({
		id: "chan-1",
		projectId: "proj-1",
		userId: "user-1",
		organizationId: "org-1",
		teamName: "Design",
		channelName: "general",
	});
});

describe("recordTeamsChannelFailureActivity", () => {
	it("closes the job as FAILED with the real reason", async () => {
		await recordTeamsChannelFailureActivity({
			linkedChannelId: "chan-1",
			errorMessage: "Authentication token expired",
		});

		expect(dbMocks.failBackgroundJob).toHaveBeenCalledWith(
			expect.objectContaining({ sourceId: "chan-1" }),
			expect.objectContaining({ error: "Authentication token expired" }),
		);
	});

	it("does not rely on the step alone to convey failure", async () => {
		await recordTeamsChannelFailureActivity({
			linkedChannelId: "chan-1",
			errorMessage: "boom",
		});

		// The step list is collapsed by default on a finished job, so a failed
		// step with no failed status is invisible where it matters most.
		expect(dbMocks.setBackgroundJobStep).toHaveBeenCalled();
		expect(dbMocks.failBackgroundJob).toHaveBeenCalled();
	});

	it("still records the channel failure when the job row cannot be resolved", async () => {
		dbMocks.getTeamsLinkedChannelJobContext.mockResolvedValue(null);

		await recordTeamsChannelFailureActivity({
			linkedChannelId: "chan-1",
			errorMessage: "boom",
		});

		// Telemetry is best-effort; the domain write is not.
		expect(dbMocks.recordTeamsChannelFailure).toHaveBeenCalledWith(
			"chan-1",
			"boom",
		);
	});

	it("never lets a telemetry error mask the channel failure", async () => {
		dbMocks.getTeamsLinkedChannelJobContext.mockRejectedValue(
			new Error("db down"),
		);

		await expect(
			recordTeamsChannelFailureActivity({
				linkedChannelId: "chan-1",
				errorMessage: "boom",
			}),
		).resolves.toBeUndefined();
		expect(dbMocks.recordTeamsChannelFailure).toHaveBeenCalled();
	});
});

describe("updateTeamsChannelMonitorLastRunActivity", () => {
	it("closes the tick's open rows", async () => {
		await updateTeamsChannelMonitorLastRunActivity({ projectId: "proj-1" });

		expect(dbMocks.completeBackgroundJobs).toHaveBeenCalledWith(
			"teams-channel-monitor-proj-1",
			expect.anything(),
		);
		expect(dbMocks.updateTeamsChannelMonitorLastRun).toHaveBeenCalledWith(
			"proj-1",
		);
	});
});
