/**
 * The refusal a chat route answers before a turn when every ChatGPT plan
 * serving the member is spent (Fizzy #2770). The API-billing switch is
 * offered under the CopilotKit rule only: the policy asks, the organization
 * has an LLM provider, and the member's own plan is in play. Under the
 * interactive "Use API billing" policy the turn runs instead, and its stream
 * says so (Fizzy #3048).
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	pick: vi.fn(),
	provider: vi.fn(),
	apiFallback: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getAiProviderApiKey: mocks.provider,
}));

vi.mock("../lib/chatgpt-plan/pool", () => ({
	pickChatGptPlanSource: mocks.pick,
	chatGptPlanInteractiveApiFallback: mocks.apiFallback,
	chatGptPlanPoolExhaustedMessage: (resetAt: Date | null) =>
		`pool spent until ${resetAt?.toISOString() ?? "reset"}`,
}));

import {
	type ChatGptPlanChatPreflight,
	chatGptPlanChatPreflight,
	withChatGptPlanApiBilling,
} from "../lib/chatgpt-plan/plan-spent-response";

const RESET = new Date("2026-10-08T17:50:00.000Z");
const ASK = { apiFallbackInteractive: "ASK" };
const ownSpent = () =>
	new SubscriptionPlanExhaustedError("own plan spent", RESET);

const context = { userId: "user-1", organizationId: "example-org" };

async function body(preflight: ChatGptPlanChatPreflight) {
	const response =
		preflight && "refusal" in preflight ? preflight.refusal : null;
	expect(response?.status).toBe(429);
	return (await response?.json()) as Record<string, unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.provider.mockResolvedValue({ provider: "OPENAI_DIRECT" });
	mocks.apiFallback.mockResolvedValue(false);
});

describe("chatGptPlanChatPreflight", () => {
	it("passes when a plan serves the turn, or none would", async () => {
		mocks.pick.mockResolvedValueOnce({
			source: { kind: "user", userId: "user-1" },
		});
		await expect(chatGptPlanChatPreflight(context)).resolves.toBeNull();
		mocks.pick.mockResolvedValueOnce(null);
		await expect(chatGptPlanChatPreflight(context)).resolves.toBeNull();
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
		expect(await body(await chatGptPlanChatPreflight(context))).toEqual({
			error: `pool spent until ${RESET.toISOString()}`,
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: RESET.toISOString(),
			apiBillingOption: false,
		});
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
			await body(await chatGptPlanChatPreflight(context)),
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
			(await body(await chatGptPlanChatPreflight(context)))
				.apiBillingOption,
		).toBe(false);
	});

	it("runs the turn on API billing under the interactive AUTO policy, with the reset", async () => {
		const spent = {
			exhausted: true,
			audience: "interactive",
			policy: { apiFallbackInteractive: "AUTO" },
			resetAt: RESET,
		};
		mocks.pick.mockResolvedValue(spent);
		mocks.apiFallback.mockResolvedValue(true);
		await expect(chatGptPlanChatPreflight(context)).resolves.toEqual({
			apiBilling: { resetAt: RESET },
		});
		expect(mocks.apiFallback).toHaveBeenCalledWith(spent, "example-org");
	});

	it("leaves the route to decide without an organization or when the pick fails", async () => {
		await expect(
			chatGptPlanChatPreflight({ userId: "user-1" }),
		).resolves.toBeNull();
		mocks.pick.mockRejectedValue(new Error("needs reconnect"));
		await expect(chatGptPlanChatPreflight(context)).resolves.toBeNull();
	});
});

describe("withChatGptPlanApiBilling", () => {
	const stream = () =>
		new Response("data: {}\n\n", {
			headers: { "Content-Type": "text/event-stream" },
		});

	it("marks the stream of a turn on API billing with the reset", () => {
		const response = withChatGptPlanApiBilling(stream(), {
			apiBilling: { resetAt: RESET },
		});
		expect(response.headers.get("x-fabric-chatgpt-plan-api-billing")).toBe(
			RESET.toISOString(),
		);
		expect(
			withChatGptPlanApiBilling(stream(), {
				apiBilling: { resetAt: null },
			}).headers.get("x-fabric-chatgpt-plan-api-billing"),
		).toBe("");
	});

	it("leaves every other response unmarked", () => {
		expect(
			withChatGptPlanApiBilling(stream(), null).headers.has(
				"x-fabric-chatgpt-plan-api-billing",
			),
		).toBe(false);
		expect(
			withChatGptPlanApiBilling(new Response("{}", { status: 500 }), {
				apiBilling: { resetAt: RESET },
			}).headers.has("x-fabric-chatgpt-plan-api-billing"),
		).toBe(false);
	});
});
