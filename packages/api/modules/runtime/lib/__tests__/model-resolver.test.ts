/**
 * The runtime resolve-model path hands the tenant's raw provider key to an
 * external agent runtime (Fizzy #2770 D9). A ChatGPT plan has no such key, so
 * this path always resolves on API billing; a tenant whose work runs on a
 * plan and has no API provider for LLM work is told that, not that nothing
 * is configured. The key comes from the tenant's default provider lookup,
 * which never returns an embeddings-only key.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ai = vi.hoisted(() => ({
	getAIModelWithMetadata: vi.fn(),
	getRAGProviderConfig: vi.fn(),
	chatGptPlanServesCall: vi.fn(),
}));

vi.mock("@repo/ai", () => ai);

import {
	modelUnavailableMessage,
	resolveModelForTenant,
} from "../model-resolver";

const tenant = {
	userId: "user-1",
	organizationId: "org-1",
	apiKeyId: "key-1",
	scopes: ["ai:models:resolve"],
} as Parameters<typeof resolveModelForTenant>[0];

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveModelForTenant", () => {
	it("resolves on API billing only, never the plan", async () => {
		ai.getAIModelWithMetadata.mockResolvedValue({
			metadata: {
				provider: "OPENAI_DIRECT",
				modelString: "gpt-4o-mini",
				selectionSource: "org_override",
			},
			trackUsage: vi.fn(),
		});
		ai.getRAGProviderConfig.mockResolvedValue({ apiKey: "sk-org" });

		await expect(
			resolveModelForTenant(tenant, "CHAT"),
		).resolves.toMatchObject({
			provider: "OPENAI_DIRECT",
			apiKey: "sk-org",
		});
		expect(ai.getAIModelWithMetadata).toHaveBeenCalledWith(
			{ taskType: "CHAT" },
			expect.objectContaining({ excludeChatGptPlan: true }),
		);
	});

	it("resolves nothing when no API provider may serve LLM work", async () => {
		ai.getAIModelWithMetadata.mockRejectedValue(
			new Error("No AI provider"),
		);
		await expect(resolveModelForTenant(tenant, "CHAT")).resolves.toBeNull();
		expect(ai.getRAGProviderConfig).not.toHaveBeenCalled();
	});
});

describe("modelUnavailableMessage", () => {
	it("says the work runs on ChatGPT plans for a plan-served tenant", async () => {
		ai.chatGptPlanServesCall.mockResolvedValue(true);
		await expect(modelUnavailableMessage(tenant)).resolves.toMatch(
			/runs on ChatGPT plans.*Add an API provider/,
		);
		expect(ai.chatGptPlanServesCall).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("keeps the provider-not-configured refusal otherwise, or when the check fails", async () => {
		ai.chatGptPlanServesCall.mockResolvedValue(false);
		await expect(modelUnavailableMessage(tenant)).resolves.toMatch(
			/^No AI provider configured/,
		);
		ai.chatGptPlanServesCall.mockRejectedValue(new Error("db down"));
		await expect(modelUnavailableMessage(tenant)).resolves.toMatch(
			/^No AI provider configured/,
		);
	});
});
