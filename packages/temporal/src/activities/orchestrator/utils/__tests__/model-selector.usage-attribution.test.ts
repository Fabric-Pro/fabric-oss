/**
 * The orchestrator's model selectors forward usage attribution.
 *
 * The resolver copies `conversationId` from its operation context onto the
 * AiUsageLog row, so a chat's cost can be grouped by conversation. Both
 * selectors must hand it through, and must add no key when the caller has
 * no conversation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
}));

vi.mock("@repo/ai", () => ({
	getAIModelWithMetadata: stubs.getAIModelWithMetadata,
	getSystemEmbeddingRAGProviderConfig: vi.fn(),
}));

import { getAiModel, getAiModelWithSelection } from "../model-selector";

function contextOfCall(index: number): Record<string, unknown> {
	return stubs.getAIModelWithMetadata.mock.calls[index][1] as Record<
		string,
		unknown
	>;
}

beforeEach(() => {
	stubs.getAIModelWithMetadata.mockReset();
	stubs.getAIModelWithMetadata.mockResolvedValue({
		model: { __mockModel: true },
		metadata: {
			provider: "ANTHROPIC_DIRECT",
			modelString: "claude-sonnet-5",
			canonicalName: "claude-sonnet-5",
			selectionSource: "system",
		},
		trackUsage: vi.fn(),
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("getAiModelWithSelection usage attribution", () => {
	it("forwards the conversation into the resolver context", async () => {
		await getAiModelWithSelection(
			"user-1",
			"org-1",
			true,
			undefined,
			undefined,
			{
				conversationId: "conv-a",
			},
		);

		expect(contextOfCall(0)).toMatchObject({
			userId: "user-1",
			organizationId: "org-1",
			featureKey: "chat-agent",
			conversationId: "conv-a",
		});
	});

	it("gives each call its own conversation", async () => {
		await getAiModelWithSelection(
			"user-1",
			"org-1",
			true,
			undefined,
			undefined,
			{
				conversationId: "conv-a",
			},
		);
		await getAiModelWithSelection(
			"user-1",
			"org-1",
			true,
			undefined,
			undefined,
			{
				conversationId: "conv-b",
			},
		);

		expect(contextOfCall(0).conversationId).toBe("conv-a");
		expect(contextOfCall(1).conversationId).toBe("conv-b");
	});

	it("adds no conversationId key without attribution", async () => {
		await getAiModelWithSelection("user-1", "org-1", true);

		expect(contextOfCall(0)).not.toHaveProperty("conversationId");
		expect(contextOfCall(0).featureKey).toBe("chat-agent");
	});
});

describe("getAiModel usage attribution", () => {
	it("forwards the conversation into the resolver context", async () => {
		await getAiModel("user-1", "org-1", false, undefined, undefined, {
			conversationId: "conv-a",
		});

		expect(contextOfCall(0).conversationId).toBe("conv-a");
	});

	it("adds no conversationId key without attribution", async () => {
		await getAiModel("user-1", "org-1");

		expect(contextOfCall(0)).not.toHaveProperty("conversationId");
	});
});
