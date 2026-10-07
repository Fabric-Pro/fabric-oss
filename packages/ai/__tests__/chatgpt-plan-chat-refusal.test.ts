/**
 * A chat route whose model resolution already finds every ChatGPT plan spent
 * (Fizzy #2770) answers so that the client's limit classifier shows the same
 * "plan has no usage left" notice as for a plan spent mid-reply — never a
 * generic error.
 */
import { SubscriptionPlanExhaustedError } from "@repo/agent-types/chatgpt-plan-fetch";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({}));

import { chatGptPlanExhaustedChatResponse } from "../lib/chatgpt-plan/agent-config";
import { classifyLimitError } from "../limits";

const RESET = new Date(Date.now() + 60 * 60_000);

describe("chatGptPlanExhaustedChatResponse", () => {
	it("answers 429 with the plan's own exhaustion code and the reset time", async () => {
		const response = chatGptPlanExhaustedChatResponse(
			new SubscriptionPlanExhaustedError("Every plan is spent.", RESET),
		);
		expect(response?.status).toBe(429);
		await expect(response?.json()).resolves.toEqual({
			error: "Every plan is spent.",
			code: "subscription_sharing_usage_limit_exceeded",
			resetAt: RESET.toISOString(),
		});
	});

	it("classifies like a plan spent mid-reply, however the client wraps the body", async () => {
		const body = await chatGptPlanExhaustedChatResponse(
			new SubscriptionPlanExhaustedError("Every plan is spent.", RESET),
		)?.text();
		// `useChat` surfaces a failed request as an Error carrying the body.
		expect(classifyLimitError(new Error(body))).toMatchObject({
			kind: "subscription_exhausted",
		});
		// A client that parses the body first.
		expect(
			classifyLimitError({ cause: JSON.parse(body ?? "{}") }),
		).toMatchObject({
			kind: "subscription_exhausted",
			retryAfterMs: expect.any(Number),
		});
		// The same as the error itself, as Temporal-run turns classify it.
		expect(
			classifyLimitError(
				new SubscriptionPlanExhaustedError(
					"Every plan is spent.",
					RESET,
				),
			),
		).toMatchObject({ kind: "subscription_exhausted" });
	});

	it("leaves every other error to the route", () => {
		expect(chatGptPlanExhaustedChatResponse(new Error("boom"))).toBeNull();
	});
});
