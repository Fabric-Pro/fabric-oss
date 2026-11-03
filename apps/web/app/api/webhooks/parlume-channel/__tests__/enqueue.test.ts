import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ start: vi.fn(), classify: vi.fn() }));
vi.mock("@repo/api/lib/temporal-correlation", () => ({
	withCorrelationMemo: (value: object) => value,
}));
vi.mock("@repo/temporal/client", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.start },
		connection: {
			withDeadline: (
				_deadline: number,
				callback: () => Promise<unknown>,
			) => callback(),
		},
	}),
}));
vi.mock("@repo/temporal/temporal-client-errors", () => ({
	classifyTemporalClientError: mocks.classify,
}));

import { enqueueParlumeChannelNotifications } from "../enqueue";

const job = {
	sessionId: "example-session",
	organizationId: "example-org",
	subscriptionId: "example-subscription",
	replyId: "1700000000000",
	hardStopAt: "2026-11-02T11:00:00Z",
};
beforeEach(() => vi.resetAllMocks());
describe("durable Graph notification ingress", () => {
	it("uses a stable batch identity independent of notification ordering and stores only delivery metadata", async () => {
		const other = { ...job, replyId: "1700000000001" };
		await enqueueParlumeChannelNotifications([job, other]);
		await enqueueParlumeChannelNotifications([other, job]);
		expect(mocks.start.mock.calls[0][1].workflowId).toBe(
			mocks.start.mock.calls[1][1].workflowId,
		);
		expect(mocks.start.mock.calls[0][1]).toMatchObject({
			workflowIdReusePolicy: "REJECT_DUPLICATE",
			args: [{ jobs: [job, other] }],
		});
	});
	it("acknowledges a durable duplicate but propagates an unavailable Temporal service", async () => {
		mocks.start.mockRejectedValue(new Error("Temporal rejected"));
		mocks.classify.mockReturnValue("already_started");
		await expect(
			enqueueParlumeChannelNotifications([job]),
		).resolves.toBeUndefined();
		mocks.classify.mockReturnValue("unavailable");
		await expect(enqueueParlumeChannelNotifications([job])).rejects.toThrow(
			"Temporal rejected",
		);
	});
});
