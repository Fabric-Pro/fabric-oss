/**
 * A stop or a pause cancels the meeting-turn workflow, and Temporal hands the
 * running activity that cancellation only with a heartbeat. The turn activity
 * therefore runs with a heartbeat timeout; the activity that records a failed
 * turn does not heartbeat and runs without one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type ActivityProxy = { options: Record<string, unknown>; names: string[] };

const { proxies, execute, fail } = vi.hoisted(() => {
	const proxies: ActivityProxy[] = [];
	return { proxies, execute: vi.fn(), fail: vi.fn() };
});

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: (options: Record<string, unknown>) => {
		const entry: ActivityProxy = { options, names: [] };
		proxies.push(entry);
		return new Proxy(
			{},
			{
				get: (_target, name: string) => {
					entry.names.push(name);
					return name === "executeParlumeMeetingTurn"
						? execute
						: fail;
				},
			},
		);
	},
}));

import { parlumeMeetingTurnWorkflow } from "../parlume-meeting-turn";

const optionsOf = (activity: string) =>
	proxies.find((proxy) => proxy.names.includes(activity))?.options;

beforeEach(() => {
	execute.mockReset();
	fail.mockReset();
});

describe("parlumeMeetingTurnWorkflow", () => {
	it("runs the turn once, with a heartbeat timeout a busy worker survives, so a cancellation reaches it and an answered turn never runs again", () => {
		expect(optionsOf("executeParlumeMeetingTurn")).toEqual({
			heartbeatTimeout: "15 seconds",
			startToCloseTimeout: "3 minutes",
			retry: { maximumAttempts: 1 },
		});
		expect(optionsOf("failParlumeMeetingTurn")).toEqual({
			startToCloseTimeout: "3 minutes",
			retry: { maximumAttempts: 1 },
		});
	});

	it("records the turn as failed when its activity ends in an error", async () => {
		execute.mockRejectedValue(new Error("cancelled"));

		await parlumeMeetingTurnWorkflow({ turnId: "turn-1" });

		expect(fail).toHaveBeenCalledWith({
			turnId: "turn-1",
			error: "Parlume meeting turn timed out or the worker stopped.",
			chatReason: "timed_out",
		});
	});

	// The realtime voice that asked says itself that the answer failed.
	it("tells the chat nothing for a realtime voice's job", async () => {
		execute.mockRejectedValue(new Error("timed out"));

		await parlumeMeetingTurnWorkflow({
			turnId: "turn-1",
			realtimeJob: "J1",
		});

		expect(fail.mock.calls[0]?.[0].chatReason).toBeUndefined();
	});
});
