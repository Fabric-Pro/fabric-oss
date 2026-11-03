import { WorkflowExecutionAlreadyStartedError } from "@temporalio/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	deliver: vi.fn(),
	startChild: vi.fn(),
	options: vi.fn(),
}));
vi.mock("@temporalio/workflow", () => ({
	proxyActivities: (options: object) => {
		mocks.options(options);
		return { deliverParlumeChannelNotificationActivity: mocks.deliver };
	},
	startChild: mocks.startChild,
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import {
	parlumeChannelNotificationIngressWorkflow,
	parlumeChannelNotificationWorkflow,
} from "../src/workflows/parlume-channel-notification";

const now = new Date("2026-11-02T10:00:00Z");
const job = {
	sessionId: "example-session",
	organizationId: "example-org",
	subscriptionId: "example-subscription",
	replyId: "1700000000000",
	hardStopAt: new Date(now.getTime() + 60_000).toISOString(),
};
beforeEach(() => {
	vi.resetAllMocks();
	vi.useFakeTimers();
	vi.setSystemTime(now);
});
afterEach(() => vi.useRealTimers());

describe("durable channel notification processing", () => {
	it("starts the same unique reply workflow for duplicate or overlapping batches", async () => {
		await parlumeChannelNotificationIngressWorkflow({ jobs: [job] });
		await parlumeChannelNotificationIngressWorkflow({ jobs: [job] });
		expect(mocks.startChild.mock.calls[0][1].workflowId).toBe(
			mocks.startChild.mock.calls[1][1].workflowId,
		);
		expect(mocks.startChild.mock.calls[0][1]).toMatchObject({
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			parentClosePolicy: "ABANDON",
			args: [job],
		});
		mocks.startChild.mockRejectedValue(
			new WorkflowExecutionAlreadyStartedError(
				"duplicate",
				"example-workflow",
				"parlumeChannelNotificationWorkflow",
			),
		);
		await expect(
			parlumeChannelNotificationIngressWorkflow({ jobs: [job] }),
		).resolves.toBeUndefined();
	});
	it("bounds retry time to hard stop and skips already expired capture", async () => {
		await parlumeChannelNotificationWorkflow(job);
		expect(mocks.options).toHaveBeenCalledWith(
			expect.objectContaining({
				scheduleToCloseTimeout: 60_000,
				retry: expect.objectContaining({ maximumAttempts: 8 }),
			}),
		);
		expect(mocks.deliver).toHaveBeenCalledWith(job);
		mocks.deliver.mockClear();
		vi.setSystemTime(Date.parse(job.hardStopAt));
		await parlumeChannelNotificationWorkflow(job);
		expect(mocks.deliver).not.toHaveBeenCalled();
	});
});
