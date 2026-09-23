import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		jobCompleteAll: vi.fn(),
		jobFail: vi.fn(),
	},
}));

vi.mock("../../lib/job-progress", () => ({
	jobCompleteAll: mocks.jobCompleteAll,
	jobFail: mocks.jobFail,
}));

import { closeStorySyncJob } from "../story-sync-job";

describe("closeStorySyncJob", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("closes every running row of the workflow as COMPLETED with the counts", async () => {
		const counts = { total: 3, synced: 2, failed: 1, conflicted: 0 };

		await closeStorySyncJob({
			outcome: "COMPLETED",
			message: "Sync complete.",
			counts,
		});

		expect(mocks.jobCompleteAll).toHaveBeenCalledWith(counts);
		expect(mocks.jobFail).not.toHaveBeenCalled();
	});

	it("fails the row with the user-facing message and error class", async () => {
		await closeStorySyncJob({
			outcome: "FAILED",
			message: "Couldn't reach the PM tool.",
			errorClass: "SyncFailed",
			counts: { total: 0, synced: 0, failed: 0, conflicted: 0 },
		});

		expect(mocks.jobFail).toHaveBeenCalledWith(
			"Couldn't reach the PM tool.",
			{ errorClass: "SyncFailed" },
		);
		expect(mocks.jobCompleteAll).not.toHaveBeenCalled();
	});
});
