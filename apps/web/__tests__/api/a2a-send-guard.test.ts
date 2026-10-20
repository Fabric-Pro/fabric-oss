/**
 * The relay resolves an ACTIVE SYSTEM agent before model resolution or token
 * issuance. Caller URLs cannot select the destination; tenant membership is
 * checked before sending the AI token. Service credentials remain withheld.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

const isOrganizationMember = vi.fn();
const getActiveSystemRegisteredAgent = vi.fn();
vi.mock("@repo/database", () => ({
	getActiveSystemRegisteredAgent: (agentId: string) =>
		getActiveSystemRegisteredAgent(agentId),
	isOrganizationMember: (userId: string, organizationId: string) =>
		isOrganizationMember(userId, organizationId),
}));

const sendMessageSecure = vi.fn();
vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = (...args: unknown[]) => sendMessageSecure(...args);
	},
}));

vi.mock("@repo/ai", () => ({
	buildEffectiveBaseUrl: () => undefined,
	getAIModelWithMetadata: vi.fn().mockResolvedValue({
		metadata: { modelString: "m", provider: "p" },
		trackUsage: () => {},
	}),
	getRAGProviderConfigForModel: vi.fn().mockResolvedValue({ baseUrl: null }),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: vi.fn().mockResolvedValue("ai-token"),
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { issueAIToken } = await import("@repo/ai-token");
const { getAIModelWithMetadata } = await import("@repo/ai");

const { POST } = await import("../../app/api/agents/a2a/send/route");

function send(body: Record<string, unknown>) {
	return POST(
		new Request("http://localhost/api/agents/a2a/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as never,
	);
}

const MESSAGE = { role: "user", content: "hello" };

beforeEach(() => {
	vi.clearAllMocks();
	getSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
	isOrganizationMember.mockResolvedValue(true);
	getActiveSystemRegisteredAgent.mockResolvedValue({
		deploymentUrl: "https://agent.example.com",
	});
	sendMessageSecure.mockResolvedValue({ id: "t1", status: "completed" });
	process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "";
});

describe("the destination", () => {
	it.each([{}, { agentUrl: "http://203.0.113.1/" }, { agentId: 123 }])(
		"requires a string agentId (%j)",
		async (destination) => {
			const res = await send({ ...destination, message: MESSAGE });
			expect(res.status).toBe(400);
			expect(await res.json()).toEqual({ error: "agentId is required" });
			expect(getActiveSystemRegisteredAgent).not.toHaveBeenCalled();
			expect(issueAIToken).not.toHaveBeenCalled();
			expect(sendMessageSecure).not.toHaveBeenCalled();
		},
	);

	it.each(["unknown", "user-agent", "organization-agent"])(
		"hides unavailable agent %s without resolving AI or issuing a token",
		async (agentId) => {
			// The query's scope/status filtering is tested in the database package.
			getActiveSystemRegisteredAgent.mockResolvedValue(null);
			const res = await send({ agentId, message: MESSAGE });
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({ error: "Agent not found" });
			expect(getActiveSystemRegisteredAgent).toHaveBeenCalledWith(
				agentId,
			);
			expect(getAIModelWithMetadata).not.toHaveBeenCalled();
			expect(issueAIToken).not.toHaveBeenCalled();
			expect(sendMessageSecure).not.toHaveBeenCalled();
		},
	);

	it("hides a SYSTEM agent without a deployment URL", async () => {
		getActiveSystemRegisteredAgent.mockResolvedValue({
			deploymentUrl: null,
		});
		const res = await send({ agentId: "system-agent", message: MESSAGE });
		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({ error: "Agent not found" });
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(sendMessageSecure).not.toHaveBeenCalled();
	});

	it.each([
		["loopback", "http://127.0.0.1:8080"],
		[
			"link-local cloud metadata",
			"http://169.254.169.254/latest/meta-data",
		],
		["a private LAN address", "http://10.0.0.5:9000"],
	])("refuses %s, and never dispatches", async (_label, agentUrl) => {
		getActiveSystemRegisteredAgent.mockResolvedValue({
			deploymentUrl: agentUrl,
		});
		const res = await send({ agentId: "system-agent", message: MESSAGE });

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("Agent endpoint rejected"),
		});
		expect(sendMessageSecure).not.toHaveBeenCalled();
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("uses the SYSTEM agent URL even when the body contains an attacker URL", async () => {
		const res = await send({
			agentId: "system-agent",
			agentUrl: "http://203.0.113.1/",
			message: MESSAGE,
		});

		expect(res.status).toBe(200);
		expect(sendMessageSecure.mock.calls[0]?.[0]).toBe(
			"https://agent.example.com",
		);
		expect(issueAIToken).toHaveBeenCalledTimes(1);
		const options = sendMessageSecure.mock.calls[0]?.[3];
		expect(options).toBeDefined();
		expect(options?.trustedDestination).not.toBe(true);
		expect(options).not.toHaveProperty("agentApiKey");
	});

	it("allows an internal address the operator explicitly permitted", async () => {
		// The exception is the deployment's to declare, never the request's.
		process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "127.0.0.1";
		getActiveSystemRegisteredAgent.mockResolvedValue({
			deploymentUrl: "http://127.0.0.1:8080",
		});

		const res = await send({
			agentId: "system-agent",
			message: MESSAGE,
		});

		expect(res.status).toBe(200);
	});
});

describe("the tenant", () => {
	it("refuses an organization the caller is not a member of", async () => {
		isOrganizationMember.mockResolvedValue(false);

		const res = await send({
			agentId: "system-agent",
			message: MESSAGE,
			organizationId: "org-someone-else",
		});

		expect(res.status).toBe(403);
		expect(isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			"org-someone-else",
		);
		expect(sendMessageSecure).not.toHaveBeenCalled();
		expect(issueAIToken).not.toHaveBeenCalled();
		expect(getAIModelWithMetadata).not.toHaveBeenCalled();
	});

	it("allows one the caller belongs to", async () => {
		const res = await send({
			agentId: "system-agent",
			message: MESSAGE,
			organizationId: "org-1",
		});

		expect(res.status).toBe(200);
	});

	it("does not ask about membership when no organization was named", async () => {
		await send({ agentId: "system-agent", message: MESSAGE });

		expect(isOrganizationMember).not.toHaveBeenCalled();
	});
});
