// @vitest-environment node
/**
 * The unified channel webhook verifies with the deployment's own secret and
 * never loads a tenant's connection to do it (Fizzy #2860). It used to pass
 * the most recently used connection from ANY tenant to `verifyInbound`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	workflowIntegrationFindFirst: vi.fn(),
	verifyInbound: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: { findFirst: mocks.workflowIntegrationFindFirst },
	},
}));

vi.mock("@repo/integrations", () => ({
	channelRegistry: {
		get: (channel: string) =>
			channel === "slack"
				? {
						channel: "slack",
						name: "Slack",
						providerKey: "SLACK",
						verifyInbound: mocks.verifyInbound,
					}
				: undefined,
	},
}));

vi.mock("@repo/integrations/slack", () => ({ addSlackReaction: vi.fn() }));
vi.mock("@repo/temporal", () => ({ getTemporalClient: vi.fn() }));
vi.mock("../../lib/channels/slack-monitor-fanout", () => ({
	fanoutSlackMonitorEvent: vi.fn(),
}));

import { NextRequest } from "next/server";
import { handleChannelInbound } from "../../lib/channels/inbound-handler";

describe("handleChannelInbound verification", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.verifyInbound.mockReturnValue({
			kind: "invalid",
			reason: "slack signature mismatch",
		});
	});

	it("verifies the request alone, without loading any tenant's connection", async () => {
		const req = new NextRequest(
			"https://example.com/api/webhooks/channels/slack/events",
			{
				method: "POST",
				headers: { "X-Slack-Signature": "v0=abc" },
				body: '{"type":"event_callback"}',
			},
		);

		const res = await handleChannelInbound("slack", req);

		expect(res.status).toBe(401);
		expect(mocks.workflowIntegrationFindFirst).not.toHaveBeenCalled();
		expect(mocks.verifyInbound).toHaveBeenCalledTimes(1);
		const args = mocks.verifyInbound.mock.calls[0];
		expect(args).toHaveLength(1);
		expect(args[0]).toEqual({
			headers: expect.objectContaining({ "x-slack-signature": "v0=abc" }),
			rawBody: '{"type":"event_callback"}',
		});
	});
});
