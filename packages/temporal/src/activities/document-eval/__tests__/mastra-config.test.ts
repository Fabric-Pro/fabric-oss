import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getAIModelWithMetadata: vi.fn() }));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: class extends Error {},
	getAIModelWithMetadata: h.getAIModelWithMetadata,
}));

import { resolveEvalModel } from "../mastra-config";

describe("resolveEvalModel", () => {
	it("tags document quality scoring with its feature key", async () => {
		h.getAIModelWithMetadata.mockResolvedValue({
			model: {},
			metadata: {},
			trackUsage: vi.fn(),
		});

		await resolveEvalModel({
			userId: "user-example-1",
			organizationId: "org-example-1",
		});

		expect(h.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "EVAL" },
			{
				userId: "user-example-1",
				organizationId: "org-example-1",
				featureKey: "document-quality",
			},
		);
	});
});
