/**
 * The refusal a chat route answers before a turn when every ChatGPT plan
 * serving the member is spent (Fizzy #2770). The API-billing switch is
 * offered under the CopilotKit rule only: the policy asks, the organization
 * has an LLM provider, and the member's own plan is in play.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pick: vi.fn(),
	provider: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getAiProviderApiKey: mocks.provider,
}));

vi.mock("../lib/chatgpt-plan/pool", () => ({
	pickChatGptPlanSource: mocks.pick,
	chatGptPlanPoolExhaustedMessage: (resetAt: Date | null) =>
		`pool spent until ${resetAt?.toISOString() ?? "reset"}`,
}));

import { chatGptPlanSpentChatResponse } from "../lib/chatgpt-plan/plan-spent-response";

const RESET = new Date("2026-10-08T17:50:00.000Z");
const ASK = { apiFallbackInteractive: "ASK" };
const ownSpent = () =>
	new SubscriptionPlanExhaustedError("own plan spent", RESET);

const context = { userId: "user-1", organizationId: "example-org" };

async function body(response: Response | null) {
	expect(response?.status).toBe(429);
	return (await response?.json()) as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.provider.mockResolvedValue({ provider: "OPENAI_DIRECT" });
});

describe("chatGptPlanSpentChatResponse", () => {
	it("passes when a plan serves the turn, or none would", async () => {
		mocks.pick.mockResolvedValueOnce({
			source: { kind: "user", userId: "user-1" },
		});
		await expect(chatGptPlanSpentChatResponse(context)).resolves.toBeNull();
		mocks.pick.mockResolvedValueOnce(null);
		await expect(chatGptPlanSpentChatResponse(context)).resolves.toBeNull();
		expect(mocks.pick).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "example-org",
			planEligible: true,
		});
	});

	it("refuses shared plans spent with their reset, and no billing switch without an own plan", async () => {
		mocks.pick.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy: ASK,
			resetAt: RESET,
		});
		expect(await body(await chatGptPlanSpentChatResponse(context))).toEqual(
			{
				error: `pool spent until ${RESET.toISOString()}`,
				code: "subscription_sharing_usage_limit_exceeded",
				resetAt: RESET.toISOString(),
				apiBillingOption: false,
			},
		);
		expect(mocks.provider).not.toHaveBeenCalled();
	});

	it("offers API billing when the policy asks, a provider exists and the own plan is in play", async () => {
		mocks.pick.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy: ASK,
			resetAt: RESET,
			ownPlanSpent: ownSpent(),
			ownPlanOnly: true,
		});
		expect(
			await body(await chatGptPlanSpentChatResponse(context)),
		).toMatchObject({
			error: "own plan spent",
			apiBillingOption: true,
		});
	});

	it.each([
		["the organization has no LLM provider", ASK, null],
		[
			"the policy never falls back",
			{ apiFallbackInteractive: "NEVER" },
			"OPENAI_DIRECT",
		],
	])("offers no billing switch when %s", async (_case, policy, provider) => {
		mocks.provider.mockResolvedValue({ provider });
		mocks.pick.mockResolvedValue({
			exhausted: true,
			audience: "interactive",
			policy,
			resetAt: RESET,
			ownPlanSpent: ownSpent(),
		});
		expect(
			(await body(await chatGptPlanSpentChatResponse(context)))
				.apiBillingOption,
		).toBe(false);
	});

	it("leaves the route to decide without an organization or when the pick fails", async () => {
		await expect(
			chatGptPlanSpentChatResponse({ userId: "user-1" }),
		).resolves.toBeNull();
		mocks.pick.mockRejectedValue(new Error("needs reconnect"));
		await expect(chatGptPlanSpentChatResponse(context)).resolves.toBeNull();
	});
});
