/**
 * `POST /api/agents/a2a/send` — a message a person sends to an A2A agent may
 * run on their ChatGPT plan, or one the organization shares (Fizzy #2770).
 *
 * The route resolves the model as the person's own interactive work and marks
 * the AI token it hands the agent plan-eligible only when that resolution
 * landed on a plan, so the agent's key exchange lands on the same plan. While
 * an admin acts as the member, the token is marked impersonated and no plan
 * may serve it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

vi.mock("@repo/database", () => ({
	isOrganizationMember: vi.fn().mockResolvedValue(true),
}));

const sendMessageSecure = vi.fn();
vi.mock("@repo/agent-core", () => ({
	SecureA2AClient: class {
		sendMessageSecure = (...args: unknown[]) => sendMessageSecure(...args);
	},
}));

const getAIModelWithMetadata = vi.fn();
vi.mock("@repo/ai", () => ({
	buildEffectiveBaseUrl: (_provider: string, custom?: string) =>
		custom ?? "https://provider.example.com",
	getAIModelWithMetadata: (...args: unknown[]) =>
		getAIModelWithMetadata(...args),
	getRAGProviderConfig: vi
		.fn()
		.mockResolvedValue({ baseUrl: "https://org-gateway.example.com" }),
}));

const issueAIToken = vi.fn();
vi.mock("@repo/ai-token", () => ({
	issueAIToken: (options: unknown) => issueAIToken(options),
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const { POST } = await import("../../app/api/agents/a2a/send/route");

function send() {
	return POST(
		new Request("http://localhost/api/agents/a2a/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentUrl: "https://agent.example.com",
				message: { role: "user", content: "hello" },
				organizationId: "org-1",
			}),
		}) as never,
	);
}

function resolvesTo(provider: string) {
	getAIModelWithMetadata.mockResolvedValue({
		metadata: { modelString: "gpt-5.6-sol", provider },
		trackUsage: () => {},
	});
}

function aiConfigSent() {
	return sendMessageSecure.mock.calls[0]?.[3]?.aiConfig;
}

beforeEach(() => {
	vi.clearAllMocks();
	getSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
	issueAIToken.mockResolvedValue("ai-token");
	sendMessageSecure.mockResolvedValue({ id: "t1", status: "completed" });
	process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "";
});

describe("a message a person sends to an agent", () => {
	it("resolves its model as the person's own interactive work", async () => {
		resolvesTo("OPENAI_CHATGPT_PLAN");
		await send();
		expect(getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "TOOL_CALLING" },
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				planEligible: true,
			}),
		);
	});

	it("hands the agent a plan-eligible token and no base URL when a plan serves it", async () => {
		resolvesTo("OPENAI_CHATGPT_PLAN");
		const res = await send();
		expect(res.status).toBe(200);
		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				planEligible: true,
				impersonated: false,
			}),
		);
		expect(aiConfigSent()).toMatchObject({
			provider: "OPENAI_CHATGPT_PLAN",
			model: "gpt-5.6-sol",
			baseUrl: undefined,
		});
	});

	it("keeps the token off any plan when the organization's provider serves it", async () => {
		resolvesTo("AZURE_AI_FOUNDRY");
		await send();
		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ planEligible: false }),
		);
		expect(aiConfigSent()).toMatchObject({
			baseUrl: "https://org-gateway.example.com",
		});
	});

	it("marks the token impersonated while an admin acts as the member", async () => {
		getSession.mockResolvedValue({
			user: { id: "user-1" },
			session: { impersonatedBy: "admin-1" },
		});
		resolvesTo("AZURE_AI_FOUNDRY");
		await send();
		expect(issueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				impersonated: true,
				planEligible: false,
			}),
		);
	});
});
