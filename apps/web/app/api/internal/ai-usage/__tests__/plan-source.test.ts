/**
 * Agent usage on a shared ChatGPT plan account (Fizzy #2770): the row records
 * the account as its `providerConfigId` only when the account belongs to the
 * token's own organization, so the pool ledger, per-account limits and the
 * member's own estimate all see it; any other key records nothing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	logAiUsage: vi.fn(),
	getAccount: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: async () => ({
		valid: true,
		claims: { sub: "user-1", org: "org-1" },
	}),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: vi.fn(async () => true),
	logAiUsage: mocks.logAiUsage,
	getChatGptPlanOrgAccount: mocks.getAccount,
}));

const { POST } = await import("../route");

const usage = (extra: Record<string, unknown>) =>
	POST(
		new Request("http://localhost/api/internal/ai-usage", {
			method: "POST",
			headers: {
				"X-AI-Token": "jwt",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				provider: "OPENAI_CHATGPT_PLAN",
				model: "gpt-6-astra",
				taskType: "COMPLEX",
				inputTokens: 10,
				outputTokens: 2,
				totalTokens: 12,
				...extra,
			}),
		}),
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAccount.mockImplementation(
		async (params: { organizationId: string; accountId: string }) =>
			params.organizationId === "org-1" && params.accountId === "acc-own"
				? { id: "acc-own" }
				: null,
	);
});

describe("POST /api/internal/ai-usage — shared plan accounts", () => {
	it("records an account of the token's own organization", async () => {
		expect((await usage({ planSource: "org:acc-own" })).status).toBe(200);
		expect(mocks.getAccount).toHaveBeenCalledWith({
			organizationId: "org-1",
			accountId: "acc-own",
		});
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({
				providerConfigId: "acc-own",
				costUsd: 0,
			}),
		);
	});

	it("ignores an account of another organization", async () => {
		expect((await usage({ planSource: "org:acc-elsewhere" })).status).toBe(
			200,
		);
		expect(mocks.logAiUsage).toHaveBeenCalledWith(
			expect.objectContaining({ providerConfigId: undefined }),
		);
	});

	it("records nothing for a member's own plan or a call off the plan", async () => {
		await usage({ planSource: "user:user-1" });
		await usage({ provider: "OPENROUTER", planSource: "org:acc-own" });
		for (const [row] of mocks.logAiUsage.mock.calls) {
			expect(row.providerConfigId).toBeUndefined();
		}
		expect(mocks.getAccount).not.toHaveBeenCalled();
	});
});
