/**
 * `POST /api/agents/a2a/send` — the relay refuses a destination and a tenant
 * the caller has no business naming (Fizzy #2380, QA round 2).
 *
 * This route takes `agentUrl` straight from the request body, looks nothing up,
 * and makes the server fetch it. The SSRF guard that shipped with the first
 * round landed on the agent-registry procedures and never reached here.
 *
 * Why this one mattered more than the registry ones: those return a health flag
 * and a response time, so pointing them inward leaks reachability. This route
 * hands the destination `X-Service-Token` — the inter-agent shared secret — and
 * `X-AI-Token`, which is exchangeable for real provider credentials. The
 * failure mode is credential exfiltration, not port scanning.
 *
 * `organizationId` is caller-supplied on the same body and is not decorative:
 * it selects the AI model and RAG configuration and is stamped into the AI
 * token this route issues. Nothing downstream re-checked it.
 *
 * Both guards sit ahead of the AI plumbing, so the stubs below only have to
 * exist, not behave.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();
vi.mock("@repo/auth", () => ({
	auth: { api: { getSession: (args: unknown) => getSession(args) } },
}));

const isOrganizationMember = vi.fn();
vi.mock("@repo/database", () => ({
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
	getRAGProviderConfig: vi.fn().mockResolvedValue({ baseUrl: null }),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: vi.fn().mockResolvedValue("ai-token"),
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

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
	getSession.mockResolvedValue({ user: { id: "user-1" } });
	isOrganizationMember.mockResolvedValue(true);
	sendMessageSecure.mockResolvedValue({ id: "t1", status: "completed" });
	process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "";
});

describe("the destination", () => {
	it.each([
		["loopback", "http://127.0.0.1:8080"],
		[
			"link-local cloud metadata",
			"http://169.254.169.254/latest/meta-data",
		],
		["a private LAN address", "http://10.0.0.5:9000"],
	])("refuses %s, and never dispatches", async (_label, agentUrl) => {
		const res = await send({ agentUrl, message: MESSAGE });

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			error: expect.stringContaining("Agent endpoint rejected"),
		});
		expect(sendMessageSecure).not.toHaveBeenCalled();
	});

	it("allows a public address", async () => {
		const res = await send({
			agentUrl: "https://agent.example.com",
			message: MESSAGE,
		});

		expect(res.status).toBe(200);
		expect(sendMessageSecure).toHaveBeenCalled();
	});

	it("allows an internal address the operator explicitly permitted", async () => {
		// The exception is the deployment's to declare, never the request's.
		process.env.AGENT_DISCOVERY_ALLOWED_HOSTS = "127.0.0.1";

		const res = await send({
			agentUrl: "http://127.0.0.1:8080",
			message: MESSAGE,
		});

		expect(res.status).toBe(200);
	});
});

describe("the tenant", () => {
	it("refuses an organization the caller is not a member of", async () => {
		isOrganizationMember.mockResolvedValue(false);

		const res = await send({
			agentUrl: "https://agent.example.com",
			message: MESSAGE,
			organizationId: "org-someone-else",
		});

		expect(res.status).toBe(403);
		expect(isOrganizationMember).toHaveBeenCalledWith(
			"user-1",
			"org-someone-else",
		);
		expect(sendMessageSecure).not.toHaveBeenCalled();
	});

	it("allows one the caller belongs to", async () => {
		const res = await send({
			agentUrl: "https://agent.example.com",
			message: MESSAGE,
			organizationId: "org-1",
		});

		expect(res.status).toBe(200);
	});

	it("does not ask about membership when no organization was named", async () => {
		await send({ agentUrl: "https://agent.example.com", message: MESSAGE });

		expect(isOrganizationMember).not.toHaveBeenCalled();
	});
});
