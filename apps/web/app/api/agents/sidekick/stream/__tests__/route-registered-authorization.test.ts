/**
 * `POST /api/agents/sidekick/stream` for a registered agent: each refusal's
 * exact status and `{error}` body, with no model or tools resolved, and an
 * organization agent's member admitted in the agent's organization while the
 * session is active in another one.
 *
 * Mocked: the session, rate limit, database lookups, model resolution and
 * the Sidekick's tool factory. The AI SDK is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	agent: vi.fn(),
	membership: vi.fn(),
	model: vi.fn(),
	tools: vi.fn(),
}));
vi.mock("@saas/auth/lib/server", () => ({
	getSession: async () => ({
		user: { id: "example-user" },
		session: {
			activeOrganizationId: "example-org-a",
			impersonatedBy: null,
		},
	}),
}));
vi.mock("@repo/auth", () => ({ auth: {} }));
vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: async () => ({ allowed: true }),
	RATE_LIMIT_PRESETS: { ai: { limit: 20, windowMs: 60_000 } },
}));
vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: {},
	getOrganizationMembership: h.membership,
	getRegisteredAgentById: h.agent,
}));
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class extends Error {},
}));
vi.mock("@repo/ai", async () => {
	const ai = await vi.importActual<typeof import("ai")>("ai");
	return {
		convertToModelMessages: ai.convertToModelMessages,
		createUIMessageStreamResponse: ai.createUIMessageStreamResponse,
		isStepCount: ai.isStepCount,
		streamText: ai.streamText,
		toUIMessageStream: ai.toUIMessageStream,
		getAIModelWithMetadata: h.model,
	};
});
vi.mock("@repo/ai/lib/chatgpt-plan/agent-config", () => ({
	chatGptPlanExhaustedChatResponse: () => null,
	chatGptPlanReconnectRefusal: () => null,
}));
vi.mock("@repo/ai/sidekick", () => ({ createSidekickTools: h.tools }));

import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { POST } from "../route";

beforeEach(() => {
	vi.clearAllMocks();
	h.membership.mockResolvedValue({
		role: "member",
		organization: { deletedAt: null },
	});
	h.tools.mockReturnValue({});
	h.model.mockResolvedValue({
		model: new MockLanguageModelV4({
			doStream: async () => ({
				stream: simulateReadableStream({
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "example-text" },
						{
							type: "text-delta",
							id: "example-text",
							delta: "Ready.",
						},
						{ type: "text-end", id: "example-text" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: undefined },
							usage: {
								inputTokens: {
									total: 1,
									noCache: 1,
									cacheRead: 0,
									cacheWrite: 0,
								},
								outputTokens: {
									total: 1,
									text: 1,
									reasoning: 0,
								},
							},
						},
					],
				}),
			}),
		}),
		metadata: { provider: "OPENAI", modelString: "example-model" },
		trackUsage: vi.fn(),
	});
});

async function invoke() {
	return POST(
		new Request("https://example.com/api/agents/sidekick/stream", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "example-agent",
				entityType: "registered",
				formSnapshot: {},
				messages: [
					{
						id: "example-message",
						role: "user",
						parts: [
							{ type: "text", text: "Help improve this agent" },
						],
					},
				],
			}),
		}) as never,
	);
}
async function refused(status: number, error: string) {
	const response = await invoke();
	expect(response.status).toBe(status);
	expect(await response.json()).toEqual({ error });
	expect(h.model).not.toHaveBeenCalled();
	expect(h.tools).not.toHaveBeenCalled();
}

describe("Sidekick registered agent authorization", () => {
	it("hides a missing agent", async () => {
		h.agent.mockResolvedValue(null);
		await refused(404, "Agent not found");
	});
	it("refuses a system agent with its own message", async () => {
		h.agent.mockResolvedValue({ scope: "SYSTEM", userId: null });
		await refused(403, "System agents cannot be modified via Sidekick");
	});
	it("refuses another user's personal agent", async () => {
		h.agent.mockResolvedValue({
			scope: "USER",
			userId: "example-other-user",
			organizationId: null,
		});
		await refused(403, "Forbidden");
	});
	it("refuses an organization agent to a non-member", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: "example-other-user",
			organizationId: "example-org-b",
		});
		h.membership.mockResolvedValue(null);
		await refused(403, "Forbidden");
		expect(h.membership).toHaveBeenCalledWith(
			"example-org-b",
			"example-user",
		);
	});
	// The route's check is unchanged: only the agent runtime refuses a
	// deleted organization's agent (sidekick-engine.test.ts).
	it("admits a member to an organization agent of a deleted organization, as before", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: "example-user",
			organizationId: "example-org-b",
		});
		h.membership.mockResolvedValue({
			role: "owner",
			organization: { deletedAt: new Date(0) },
		});

		const response = await invoke();

		expect(response.status).toBe(200);
		await response.text();
		expect(h.membership).toHaveBeenCalledWith(
			"example-org-b",
			"example-user",
		);
		expect(h.tools).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "example-org-b" }),
		);
	});
	it("admits a member in the agent's organization while the session is in another", async () => {
		h.agent.mockResolvedValue({
			scope: "ORGANIZATION",
			userId: "example-other-user",
			organizationId: "example-org-b",
		});

		const response = await invoke();

		expect(response.status).toBe(200);
		await response.text();
		expect(h.model).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				userId: "example-user",
				organizationId: "example-org-b",
			}),
		);
		expect(h.tools).toHaveBeenCalledWith(
			expect.objectContaining({
				agentId: "example-agent",
				entityType: "registered",
				organizationId: "example-org-b",
			}),
		);
	});
});
