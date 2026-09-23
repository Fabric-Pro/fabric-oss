/**
 * The chat's default agent is the default Fabric AI model (Fizzy #2040, F20):
 * it reads DEFAULT_FABRIC_AI_MODEL rather than its own literal, so the chat
 * default cannot drift from the task defaults and the other fallbacks.
 */
import { DEFAULT_FABRIC_AI_MODEL } from "@repo/database/prisma/ai-model-catalog";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findFirst: vi.fn(),
	getConfiguredProviders: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { aiModel: { findFirst: mocks.findFirst } },
}));

vi.mock("../../../../ai-config/lib/configured-providers", () => ({
	getConfiguredProviders: mocks.getConfiguredProviders,
}));

const { resolveDefaultChatAgent } = await import("../default-agent");

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getConfiguredProviders.mockResolvedValue({
		defaultProviderType: "ANTHROPIC_DIRECT",
	});
});

describe("resolveDefaultChatAgent", () => {
	it("looks up the default Fabric AI model on the tenant's default provider", async () => {
		mocks.findFirst.mockResolvedValue({
			canonicalName: DEFAULT_FABRIC_AI_MODEL,
			displayName: "Claude Sonnet 5",
			vendor: "Anthropic",
		});

		const agent = await resolveDefaultChatAgent("u1", "org-1");

		const where = mocks.findFirst.mock.calls[0][0].where;
		expect(where.canonicalName).toBe(DEFAULT_FABRIC_AI_MODEL);
		expect(where.providerMappings.some.provider).toBe("ANTHROPIC_DIRECT");
		expect(agent).toEqual({
			agentId: `model:${DEFAULT_FABRIC_AI_MODEL}`,
			name: "Claude Sonnet 5",
			vendor: "Anthropic",
			modelOverride: DEFAULT_FABRIC_AI_MODEL,
		});
	});

	it("offers no default when the tenant's provider cannot run it", async () => {
		mocks.findFirst.mockResolvedValue(null);
		expect(await resolveDefaultChatAgent("u1", "org-1")).toBeNull();
	});
});
