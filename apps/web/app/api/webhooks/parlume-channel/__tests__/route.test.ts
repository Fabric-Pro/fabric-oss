import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), enqueue: vi.fn() }));
vi.mock("@repo/api/modules/projects/lib/parlume-channel-chat", () => ({
	channelNotificationSchema: z.object({
		subscriptionId: z.string(),
		clientState: z.string(),
		tenantId: z.string(),
		changeType: z.string(),
		resource: z.string(),
	}),
	prepareParlumeChannelNotifications: mocks.prepare,
}));
vi.mock("../enqueue", () => ({
	enqueueParlumeChannelNotifications: mocks.enqueue,
}));

import { POST } from "../route";

const notification = {
	subscriptionId: "example-subscription",
	clientState: "example-client-state",
	tenantId: "example-tenant",
	changeType: "created",
	resource: "example-resource",
};
const request = (body: unknown, query = "session=example-session") =>
	new NextRequest(
		`https://example.com/api/webhooks/parlume-channel?${query}`,
		{ method: "POST", body: JSON.stringify(body) },
	);
beforeEach(() => {
	vi.resetAllMocks();
	mocks.prepare.mockResolvedValue([]);
});

describe("Microsoft channel notification endpoint", () => {
	it("answers Graph's validation handshake as decoded plain text", async () => {
		const response = await POST(
			request(null, "validationToken=example%20validation%2Btoken"),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(await response.text()).toBe("example validation+token");
		expect(mocks.prepare).not.toHaveBeenCalled();
	});
	it("validates notification shape and binds processing to the subscription session", async () => {
		const response = await POST(request({ value: [notification] }));
		expect(response.status).toBe(202);
		expect(mocks.prepare).toHaveBeenCalledWith("example-session", [
			notification,
		]);
		expect(mocks.enqueue).toHaveBeenCalledWith([], expect.any(Number));
		expect((await POST(request({ value: [{}] }))).status).toBe(400);
	});
	it("keeps failed durable enqueue retryable instead of acknowledging lost commands", async () => {
		mocks.enqueue.mockRejectedValue(new Error("Temporal unavailable"));
		expect((await POST(request({ value: [notification] }))).status).toBe(
			503,
		);
	});
	it("accepts a bounded batch of 1000 notifications without doing provider work on the request", async () => {
		const response = await POST(
			request({
				value: Array.from({ length: 1_000 }, () => notification),
			}),
		);
		expect(response.status).toBe(202);
		expect(mocks.prepare).toHaveBeenCalledTimes(1);
		expect(mocks.enqueue).toHaveBeenCalledTimes(1);
	});
	it("does not acknowledge a job until Temporal accepts its durable metadata", async () => {
		let release: () => void = () => undefined;
		mocks.enqueue.mockReturnValue(
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		);
		let acknowledged = false;
		const response = POST(request({ value: [notification] })).then(
			(value) => {
				acknowledged = true;
				return value;
			},
		);
		await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
		expect(acknowledged).toBe(false);
		release();
		expect((await response).status).toBe(202);
	});
	it("caps body bytes while reading instead of buffering an unbounded payload", async () => {
		const response = await POST(
			request({ value: [], padding: "x".repeat(1_048_576) }),
		);
		expect(response.status).toBe(413);
		expect(mocks.prepare).not.toHaveBeenCalled();
		expect(mocks.enqueue).not.toHaveBeenCalled();
	});
	it("keeps an incomplete body at the receive deadline retryable", async () => {
		vi.useFakeTimers();
		try {
			const cancel = vi.fn();
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"value":['));
				},
				cancel,
			});
			const input = request(null);
			vi.spyOn(input, "body", "get").mockReturnValue(body);
			const response = POST(input);
			await vi.advanceTimersByTimeAsync(2_500);
			expect((await response).status).toBe(503);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(mocks.prepare).not.toHaveBeenCalled();
			expect(mocks.enqueue).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});
});
