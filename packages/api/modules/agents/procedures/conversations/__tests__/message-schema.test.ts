import { describe, expect, it, vi } from "vitest";

// Mock @repo/database so Prisma client generation is not required.
// Constants like GATEWAY_PROVIDERS / AI_PROVIDER_METADATA are imported by
// @repo/ai (transitively pulled in through @repo/database's node_modules).
vi.mock("@repo/database", () => ({
	addMessageToConversation: vi.fn(),
	updateAgentConversation: vi.fn(),
	updateConversationTrajectory: vi.fn(),
	GATEWAY_PROVIDERS: [],
	DIRECT_PROVIDERS: [],
	AI_PROVIDER_METADATA: {},
	getProviderDisplayName: vi.fn(),
	getProviderMetadata: vi.fn(),
	isDirectProvider: vi.fn(),
	isGatewayProvider: vi.fn(),
}));

// Mock @repo/ai to prevent it from executing at load time
// (it uses @repo/database constants during module initialization)
vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: vi.fn(),
}));

// Mock the orpc procedures builder (update-conversation imports it at module level)
vi.mock("../../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: () => ({ _handler: () => null }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(),
	};
});

// Mock the membership module
vi.mock("../../../../organizations/lib/membership", () => ({
	verifyOrganizationMembership: vi.fn(),
}));

import { MessageSchema } from "../update-conversation";

describe("MessageSchema reasoningText", () => {
	it("accepts a message with reasoningText", () => {
		const parsed = MessageSchema.parse({
			id: "m1",
			role: "assistant",
			content: "answer",
			timestamp: "2026-05-14T00:00:00Z",
			reasoningText: "I considered…",
			reasoningDurationMs: 2400,
		});
		expect(parsed.reasoningText).toBe("I considered…");
		expect(parsed.reasoningDurationMs).toBe(2400);
	});

	it("accepts a message without reasoningText (backward compat)", () => {
		const parsed = MessageSchema.parse({
			id: "m1",
			role: "assistant",
			content: "answer",
			timestamp: "2026-05-14T00:00:00Z",
		});
		expect(parsed.reasoningText).toBeUndefined();
		expect(parsed.reasoningDurationMs).toBeUndefined();
	});

	it("rejects a message where reasoningText is not a string", () => {
		expect(() =>
			MessageSchema.parse({
				id: "m1",
				role: "assistant",
				content: "answer",
				timestamp: "2026-05-14T00:00:00Z",
				reasoningText: 42,
			}),
		).toThrow();
	});
});
