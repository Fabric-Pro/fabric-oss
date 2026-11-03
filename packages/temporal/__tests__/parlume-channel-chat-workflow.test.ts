import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	tick: vi.fn(),
	sleep: vi.fn(),
	startChild: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => ({ tickParlumeChannelChat: mocks.tick }),
	sleep: mocks.sleep,
	startChild: mocks.startChild,
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { parlumeChannelChatWorkflow } from "../src/workflows/parlume-channel-chat";

const now = new Date("2026-11-02T10:00:00Z");
const input = {
	sessionId: "example-session",
	organizationId: "example-org",
	hardStopAt: new Date(now.getTime() + 60_000).toISOString(),
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(now);
	mocks.sleep.mockImplementation(async (milliseconds: number) =>
		vi.setSystemTime(Date.now() + milliseconds),
	);
});
afterEach(() => vi.useRealTimers());

describe("Parlume channel subscription workflow", () => {
	it("waits for PENDING to become READY before starting the existing recap exactly once", async () => {
		mocks.tick
			.mockResolvedValueOnce({ continue: true, routingReady: false })
			.mockResolvedValueOnce({ continue: true, routingReady: true })
			.mockResolvedValueOnce({ continue: false, routingReady: true });
		await parlumeChannelChatWorkflow(input);
		expect(mocks.startChild).toHaveBeenCalledTimes(1);
		expect(mocks.startChild.mock.calls[0][1]).toMatchObject({
			workflowId: `parlume-recap-${input.sessionId}`,
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [{ sessionId: input.sessionId }],
		});
	});
	it("starts the recap for a positive provider fallback before the lifecycle exits", async () => {
		mocks.tick.mockResolvedValue({ continue: false, routingReady: true });
		await parlumeChannelChatWorkflow(input);
		expect(mocks.startChild).toHaveBeenCalledTimes(1);
	});
	it("collapses a reconnect onto an already started recap and skips a stop before readiness", async () => {
		mocks.tick.mockResolvedValue({ continue: false, routingReady: true });
		mocks.startChild.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"duplicate",
				`parlume-recap-${input.sessionId}`,
				"parlumeRecapWorkflow",
			),
		);
		await expect(
			parlumeChannelChatWorkflow(input),
		).resolves.toBeUndefined();
		mocks.startChild.mockClear();
		mocks.tick.mockResolvedValue({ continue: false, routingReady: false });
		await parlumeChannelChatWorkflow(input);
		expect(mocks.startChild).not.toHaveBeenCalled();
	});
	it("ends promptly when the session ends or access is revoked", async () => {
		mocks.tick
			.mockResolvedValueOnce({ continue: true })
			.mockResolvedValueOnce({ continue: false });
		await parlumeChannelChatWorkflow(input);
		expect(mocks.tick).toHaveBeenCalledTimes(2);
		expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(30_000);
	});
	it("performs a final cleanup tick at hard stop without continuing capture", async () => {
		mocks.tick.mockResolvedValue({ continue: true });
		await parlumeChannelChatWorkflow(input);
		expect(Date.now()).toBe(Date.parse(input.hardStopAt));
		expect(mocks.tick).toHaveBeenCalledTimes(3);
		expect(mocks.tick).toHaveBeenLastCalledWith(input);
	});
	it("does not abandon lifecycle ownership on a temporary web outage", async () => {
		mocks.tick
			.mockRejectedValueOnce(new Error("Web unavailable"))
			.mockResolvedValueOnce({ continue: false });
		await parlumeChannelChatWorkflow(input);
		expect(mocks.tick).toHaveBeenCalledTimes(2);
	});
});
