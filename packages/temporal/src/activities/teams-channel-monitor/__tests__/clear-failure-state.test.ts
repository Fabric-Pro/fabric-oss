/**
 * A channel that recovers while quiet must stop showing the re-link prompt.
 *
 * The failure-state reset lives inside `updateTeamsChannelCursor`, and the
 * workflow only calls that when the tick found new threads. So a channel whose
 * underlying problem was fixed but which has had no new messages since kept
 * `consecutiveFailures` and its error banner forever, telling the user to
 * re-link a channel that was already working (Fizzy #2311).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMocks = vi.hoisted(() => ({
	appendAppliedChangeIndexes: vi.fn(),
	clearTeamsChannelFailureState: vi.fn(),
	finalizeBacklogUpdateSession: vi.fn(),
	getLinkedTeamsChannelsForMonitor: vi.fn(),
	getTeamsLinkedChannelJobContext: vi.fn(),
	markPendingProposalApplied: vi.fn(),
	markPendingProposalFailed: vi.fn(),
	recordTeamsChannelFailure: vi.fn(),
	setTeamsChannelScanPageToken: vi.fn(),
	updateTeamsChannelCursor: vi.fn(),
	updateTeamsChannelMonitorLastRun: vi.fn(),
}));

vi.mock("@repo/database", () => dbMocks);

const loggerMock = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger: loggerMock }));

import { clearTeamsChannelFailureActivity } from "../fetch-channel-cursor";

beforeEach(() => {
	vi.clearAllMocks();
	dbMocks.clearTeamsChannelFailureState.mockResolvedValue({});
});

describe("clearTeamsChannelFailureActivity (Fizzy #2311)", () => {
	it("clears the failure state for the channel", async () => {
		await clearTeamsChannelFailureActivity({
			linkedChannelId: "linked_channel_1",
		});

		expect(dbMocks.clearTeamsChannelFailureState).toHaveBeenCalledTimes(1);
		expect(dbMocks.clearTeamsChannelFailureState).toHaveBeenCalledWith(
			"linked_channel_1",
		);
	});

	it("does not advance the cursor while clearing", async () => {
		// Clearing must be independent of the cursor: the whole point is that it
		// runs on ticks where the cursor deliberately did not move.
		await clearTeamsChannelFailureActivity({
			linkedChannelId: "linked_channel_1",
		});

		expect(dbMocks.updateTeamsChannelCursor).not.toHaveBeenCalled();
		expect(dbMocks.setTeamsChannelScanPageToken).not.toHaveBeenCalled();
	});

	it("swallows a database failure so a good tick is not failed by it", async () => {
		dbMocks.clearTeamsChannelFailureState.mockRejectedValue(
			new Error("connection reset"),
		);

		await expect(
			clearTeamsChannelFailureActivity({
				linkedChannelId: "linked_channel_1",
			}),
		).resolves.toBeUndefined();

		expect(loggerMock.error).toHaveBeenCalled();
	});
});
