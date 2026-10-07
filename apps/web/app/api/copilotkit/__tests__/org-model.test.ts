/**
 * CopilotKit and an organization with no AI provider of its own (Fizzy #2939):
 * a member whose agents run on a ChatGPT plan — their own, or since Fizzy
 * #2770 one the organization shares — is still served (Update Full Spec, the
 * AI Feature Assistant), while everyone else gets the same refusal as before.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	onPlan: vi.fn(),
}));

vi.mock("@repo/ai", () => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		getAIModelWithMetadata: mocks.resolve,
	};
});
// Pool-aware since Fizzy #2770: the member's own plan or a shared one.
vi.mock("@repo/ai/lib/chatgpt-plan/pool", () => ({
	planServesInteractiveWork: mocks.onPlan,
}));

const { AIProviderNotConfiguredError } = await import("@repo/ai");
const { resolveCopilotOrgModel } = await import("../org-model");

const PARAMS = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
});

describe("resolveCopilotOrgModel", () => {
	it("never asks for the plan for CopilotKit's own adapter", async () => {
		mocks.resolve.mockResolvedValue({
			metadata: { provider: "OPENROUTER" },
		});
		await resolveCopilotOrgModel(PARAMS);
		expect(mocks.resolve).toHaveBeenCalledWith(
			{ taskType: "TOOL_CALLING" },
			{ ...PARAMS, excludeChatGptPlan: true },
		);
	});

	it("serves a member on their own plan when the organization has no provider", async () => {
		mocks.resolve.mockRejectedValue(
			new AIProviderNotConfiguredError("none"),
		);
		mocks.onPlan.mockResolvedValue(true);
		await expect(resolveCopilotOrgModel(PARAMS)).resolves.toBeNull();
		expect(mocks.onPlan).toHaveBeenCalledWith(PARAMS);
	});

	it("still refuses a member who is not on the plan", async () => {
		mocks.resolve.mockRejectedValue(
			new AIProviderNotConfiguredError("none"),
		);
		mocks.onPlan.mockResolvedValue(false);
		await expect(resolveCopilotOrgModel(PARAMS)).rejects.toBeInstanceOf(
			AIProviderNotConfiguredError,
		);
	});
});
