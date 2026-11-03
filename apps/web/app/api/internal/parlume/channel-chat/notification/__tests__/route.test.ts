import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const deliver = vi.hoisted(() => vi.fn());
vi.mock("@repo/api/modules/projects/lib/parlume-channel-chat", () => ({
	channelNotificationJobSchema: z.object({
		sessionId: z.string(),
		organizationId: z.string(),
		subscriptionId: z.string(),
		replyId: z.string(),
		hardStopAt: z.iso.datetime(),
	}),
	deliverParlumeChannelNotification: deliver,
}));

import { POST } from "../route";

const job = {
	sessionId: "example-session",
	organizationId: "example-org",
	subscriptionId: "example-subscription",
	replyId: "1700000000000",
	hardStopAt: "2026-11-02T11:00:00Z",
};
const request = (body: unknown, token = "example-service-secret") =>
	new NextRequest(
		"https://example.com/api/internal/parlume/channel-chat/notification",
		{
			method: "POST",
			headers: { "X-Agent-Service-Token": token },
			body: JSON.stringify(body),
		},
	);
beforeEach(() => {
	vi.resetAllMocks();
	process.env.AGENT_SERVICE_SECRET = "example-service-secret";
});
describe("durable channel notification activity endpoint", () => {
	it("requires the service credential before any content fetch", async () => {
		expect((await POST(request(job, "wrong"))).status).toBe(401);
		expect(deliver).not.toHaveBeenCalled();
	});
	it("accepts only bounded delivery metadata and propagates retryable failures", async () => {
		expect((await POST(request(job))).status).toBe(200);
		expect(deliver).toHaveBeenCalledWith(job);
		deliver.mockRejectedValue(new Error("Bridge unavailable"));
		expect((await POST(request(job))).status).toBe(503);
		expect((await POST(request({}))).status).toBe(400);
	});
});
