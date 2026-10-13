/**
 * An agent reports its ChatGPT plan refused a call as spent (Fizzy #2770 D1):
 * the shared breaker records it through the same function web-side calls use,
 * but only for a plan the agent's AI token may run on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	record: vi.fn(),
	getAccount: vi.fn(),
	verify: vi.fn(),
}));

vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: mocks.verify,
}));
vi.mock("@repo/database", () => ({
	getChatGptPlanOrgAccount: mocks.getAccount,
}));
vi.mock("@repo/ai/lib/chatgpt-plan/exhaustion-breaker", () => ({
	recordReportedChatGptPlanSourceExhausted: mocks.record,
	chatGptPlanExhaustedMessage: (resetAt: Date | null) =>
		resetAt ? `spent until ${resetAt.toISOString()}` : "spent",
}));

const { POST } = await import("../route");

const report = (body: unknown, token: string | null = "jwt") =>
	POST(
		new Request("http://localhost/api/internal/chatgpt-plan/exhausted", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(token ? { "X-AI-Token": token } : {}),
			},
			body: JSON.stringify(body),
		}),
	);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.verify.mockResolvedValue({
		valid: true,
		claims: { sub: "user-1", org: "org-1" },
	});
	mocks.getAccount.mockImplementation(
		async (params: { organizationId: string; accountId: string }) =>
			params.organizationId === "org-1" && params.accountId === "acc-own"
				? { id: "acc-own" }
				: null,
	);
	mocks.record.mockResolvedValue(undefined);
});

describe("POST /api/internal/chatgpt-plan/exhausted", () => {
	it("closes the organization's shared account until OpenAI's reset, teaching no budget", async () => {
		const reset = new Date(
			Math.ceil((Date.now() + 2 * 60 * 60_000) / 1000) * 1000,
		);
		const response = await report({
			planSource: "org:acc-own",
			resetAt: reset.toISOString(),
		});
		expect(response.status).toBe(202);
		const [source, error] = mocks.record.mock.calls[0] ?? [];
		expect(source).toEqual({
			kind: "org",
			organizationId: "org-1",
			accountId: "acc-own",
		});
		expect(error).toMatchObject({
			name: "SubscriptionPlanExhaustedError",
			resetAt: reset,
		});
	});

	it("leaves the reset to the breaker's estimate when OpenAI gave none", async () => {
		await report({ planSource: "user:user-1" });
		const [source, error] = mocks.record.mock.calls[0] ?? [];
		expect(source).toEqual({ kind: "user", userId: "user-1" });
		expect(error).toMatchObject({ resetAt: null });
	});

	it.each(["user:user-1", "org:acc-own"])(
		"caps a reported reset for %s at one five-hour window",
		async (planSource) => {
			const before = Date.now();
			await report({
				planSource,
				resetAt: "2099-01-01T00:00:00.000Z",
			});
			const [, error] = mocks.record.mock.calls[0] ?? [];
			const resetAt = (error as { resetAt: Date }).resetAt.getTime();
			expect(resetAt).toBeLessThanOrEqual(Date.now() + 5 * 60 * 60_000);
			expect(resetAt).toBeGreaterThanOrEqual(before + 5 * 60 * 60_000);
		},
	);

	it("ignores a plan the token may not run on, answering the same", async () => {
		for (const planSource of [
			"user:someone-else",
			"org:acc-other-org",
			"not-a-source",
		]) {
			const response = await report({ planSource });
			expect(response.status).toBe(202);
		}
		expect(mocks.record).not.toHaveBeenCalled();
	});

	// Fizzy #3037: the key the exchange handed out names the sign-in whose
	// token the agent used; the breaker records the refusal only while the
	// plan still has it.
	it.each([
		["user:user-1", { kind: "user", userId: "user-1" }],
		[
			"org:acc-own",
			{ kind: "org", organizationId: "org-1", accountId: "acc-own" },
		],
	])(
		"binds a report for %s to the sign-in its key names",
		async (key, source) => {
			await report({ planSource: `${key}.0123456789abcdef` });
			expect(mocks.record).toHaveBeenCalledWith(
				source,
				expect.objectContaining({
					name: "SubscriptionPlanExhaustedError",
				}),
				"0123456789abcdef",
			);
		},
	);

	it("records an older agent's key that names no sign-in against the plan's current one", async () => {
		await report({ planSource: "user:user-1" });
		expect(mocks.record).toHaveBeenCalledWith(
			{ kind: "user", userId: "user-1" },
			expect.anything(),
			null,
		);
	});

	it("ignores a key whose sign-in part is malformed", async () => {
		for (const planSource of [
			"user:user-1.",
			"user:user-1.NOTHEX0123456789",
			"user:user-1.0123",
		]) {
			expect((await report({ planSource })).status).toBe(202);
		}
		expect(mocks.record).not.toHaveBeenCalled();
	});

	it("refuses a request with no valid AI token", async () => {
		expect((await report({ planSource: "user:user-1" }, null)).status).toBe(
			401,
		);
		mocks.verify.mockResolvedValue({ valid: false, error: "expired" });
		expect((await report({ planSource: "user:user-1" })).status).toBe(401);
		expect(mocks.record).not.toHaveBeenCalled();
	});
});
