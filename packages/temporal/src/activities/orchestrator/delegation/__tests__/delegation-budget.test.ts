import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	send: vi.fn(async () => ({
		id: "example-task",
		status: "completed",
		messages: [],
	})),
}));
vi.mock("@repo/agent-core", () => ({
	A2AClient: class {
		healthCheck = async () => true;
	},
	SecureA2AClient: class {
		sendMessageSecure = h.send;
	},
}));
vi.mock("@repo/database", () => ({}));
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	GATEWAY_PROVIDERS: [],
	getAIModelWithMetadata: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: vi.fn() }));
vi.mock("../resolve-endpoint", () => ({
	resolveAgentEndpoint: async () => ({
		agentId: "example-agent",
		name: "Example agent",
		deploymentUrl: "https://agent.example.com",
		protocol: "a2a",
		isExternal: true,
	}),
}));
vi.mock("../../utils/partykit-publisher", () => ({
	publishToolStart: vi.fn(),
	publishToolComplete: vi.fn(),
}));
vi.mock("@temporalio/activity", () => ({
	Context: { current: () => ({ heartbeat: vi.fn() }) },
}));

import { delegateToAgent } from "../delegate-to-agent";

describe("delegation surrogate allowance", () => {
	it("passes the turn's submission block to the generic A2A client", async () => {
		const result = await delegateToAgent({
			agentId: "example-agent",
			message: "test",
			userId: "example-user",
			organizationId: "example-org",
		});
		expect(result.status).toBe("completed");
		expect(h.send).toHaveBeenCalledWith(
			expect.any(String),
			expect.any(Object),
			expect.any(Object),
			expect.objectContaining({ submissionTokenAllowance: 25_000 }),
		);
	});
});
