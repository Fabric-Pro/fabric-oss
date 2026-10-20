/** Exercises the instance route with real organization authorization and mocked provider/database edges. */
import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	findInstance: vi.fn(),
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
	db: { agentTemplateInstance: { findUnique: h.findInstance } },
	getOrganizationMembership: h.membership,
	getRegisteredAgentById: vi.fn(),
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
	expect(process.env.RBAC_DRY_RUN).toBeUndefined();
	h.findInstance.mockResolvedValue({
		userId: "example-user",
		organizationId: "example-org-b",
	});
	h.membership.mockResolvedValue({
		role: "viewer",
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
				agentId: "example-instance",
				entityType: "instance",
				formSnapshot: {},
				messages: [
					{
						id: "example-message",
						role: "user",
						parts: [
							{ type: "text", text: "Help configure this agent" },
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
async function admitted() {
	const response = await invoke();
	expect(response.status).toBe(200);
	await response.text();
	expect(h.membership).toHaveBeenCalledWith("example-org-b", "example-user");
	expect(h.model).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: "example-user",
			organizationId: "example-org-b",
		}),
	);
	expect(h.tools).toHaveBeenCalledWith(
		expect.objectContaining({ organizationId: "example-org-b" }),
	);
}

describe("Sidekick instance organization authorization", () => {
	it("refuses a former creator without membership", async () => {
		h.membership.mockResolvedValue(null);
		await refused(403, "Forbidden");
	});
	it("admits a viewer whose role grants AGENT_TEMPLATE_READ", async () => {
		h.findInstance.mockResolvedValue({
			userId: "example-other-user",
			organizationId: "example-org-b",
		});
		await admitted();
	});
	it("refuses a null-organization instance, including its creator", async () => {
		h.findInstance.mockResolvedValue({
			userId: "example-user",
			organizationId: null,
		});
		await refused(404, "Agent not found");
		expect(h.membership).not.toHaveBeenCalled();
	});
	it("uses organization B for model resolution and tools while the session is in A", async () => {
		await admitted();
	});
	it("refuses a soft-deleted organization", async () => {
		h.membership.mockResolvedValue({
			role: "viewer",
			organization: { deletedAt: new Date("2026-10-19T00:00:00Z") },
		});
		await refused(403, "Forbidden");
	});
	it("hides a missing instance", async () => {
		h.findInstance.mockResolvedValue(null);
		await refused(404, "Agent not found");
	});
	it("checks the role in the instance organization", async () => {
		h.membership.mockResolvedValue({
			role: "example-unknown-role",
			organization: { deletedAt: null },
		});
		await refused(403, "Forbidden");
	});
	it("maps an UNAUTHORIZED authorization refusal to the existing 403 response", async () => {
		h.membership.mockRejectedValue(new ORPCError("UNAUTHORIZED"));
		await refused(403, "Forbidden");
	});
	it("does not convert other ORPCError codes into authorization refusals", async () => {
		const error = new ORPCError("BAD_REQUEST", {
			message: "Example invalid organization binding",
		});
		h.membership.mockRejectedValue(error);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await refused(500, error.message);
			expect(log).toHaveBeenCalledWith("[Sidekick Stream] Error:", error);
		} finally {
			log.mockRestore();
		}
	});
	it("leaves unexpected authorization failures to the route's error handler", async () => {
		const error = new Error("Example membership lookup failure");
		h.membership.mockRejectedValue(error);
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await refused(500, error.message);
			expect(log).toHaveBeenCalledWith("[Sidekick Stream] Error:", error);
		} finally {
			log.mockRestore();
		}
	});
});
