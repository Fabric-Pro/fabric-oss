/**
 * What an agent answers when its AI token exchange is refused (Fizzy #2939):
 * a spent ChatGPT plan becomes a limit signal with the time to its reset, a
 * plan that needs reconnecting becomes the reconnect sentence, and anything
 * else keeps the old 401.
 */
import { TokenExchangeError } from "@repo/ai-token";
import { describe, expect, it } from "vitest";
import { tokenExchangeFailure } from "../src/services/token-exchange-failure";

const FALLBACK = "AI token exchange failed. Invalid or expired token.";
const NOW = Date.parse("2026-10-06T12:00:00Z");

describe("tokenExchangeFailure", () => {
	it("turns a spent ChatGPT plan into a limit signal with the time to reset", () => {
		const failure = tokenExchangeFailure(
			new TokenExchangeError("Token exchange failed: spent", {
				status: 429,
				code: "CHATGPT_PLAN_EXHAUSTED",
				reason: "Your ChatGPT plan has no usage left in this window. It resets at 2026-10-06 13:00 UTC.",
				resetAt: "2026-10-06T13:00:00.000Z",
			}),
			FALLBACK,
			NOW,
		);
		expect(failure.status).toBe(429);
		expect(failure.body).toEqual({
			error: "Your ChatGPT plan has no usage left in this window. It resets at 2026-10-06 13:00 UTC.",
			code: "CHATGPT_PLAN_EXHAUSTED",
			limitSignal: {
				kind: "subscription_exhausted",
				provider: "openai",
				message:
					"Your ChatGPT plan has no usage left in this window. It resets at 2026-10-06 13:00 UTC.",
				retryAfterMs: 60 * 60_000,
			},
		});
	});

	it("passes a plan that needs reconnecting through as a 409 with the reconnect sentence", () => {
		const failure = tokenExchangeFailure(
			new TokenExchangeError("Token exchange failed: reconnect", {
				status: 409,
				code: "CHATGPT_PLAN_UNAVAILABLE",
				reason: "Run `fabric connect chatgpt` again.",
				resetAt: null,
			}),
			FALLBACK,
			NOW,
		);
		expect(failure).toEqual({
			status: 409,
			body: {
				error: "Run `fabric connect chatgpt` again.",
				code: "CHATGPT_PLAN_UNAVAILABLE",
				limitSignal: {
					kind: "subscription_reconnect",
					provider: "openai",
					message: "Run `fabric connect chatgpt` again.",
				},
			},
		});
	});

	it("keeps the 401 for an invalid token or any other failure", () => {
		expect(tokenExchangeFailure(new Error("network"), FALLBACK)).toEqual({
			status: 401,
			body: { error: FALLBACK },
		});
		expect(
			tokenExchangeFailure(
				new TokenExchangeError("Token exchange failed: expired", {
					status: 401,
					code: "EXPIRED",
					resetAt: null,
				}),
				FALLBACK,
			).status,
		).toBe(401);
	});
});
