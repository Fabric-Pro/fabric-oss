/**
 * The exchange client keeps the endpoint's status, code and reset time on a
 * refusal, so an agent can tell a spent ChatGPT plan from a bad token
 * (Fizzy #2939).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { exchangeTokenForKey, TokenExchangeError } from "./client";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("exchangeTokenForKey refusals", () => {
	it("throws a TokenExchangeError carrying the status, code and reset time", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "Your ChatGPT plan has no usage left in this window.",
							code: "CHATGPT_PLAN_EXHAUSTED",
							resetAt: "2026-10-06T13:00:00.000Z",
						}),
						{ status: 429 },
					),
			),
		);
		const error = await exchangeTokenForKey("jwt", {
			fabricBaseUrl: "http://localhost:3001",
			enableCache: false,
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(TokenExchangeError);
		expect(error).toMatchObject({
			status: 429,
			code: "CHATGPT_PLAN_EXHAUSTED",
			reason: "Your ChatGPT plan has no usage left in this window.",
			resetAt: "2026-10-06T13:00:00.000Z",
		});
	});
});

// Fizzy #2770: after a plan refuses a call as spent, the agent asks for
// another plan's token, never the cached one.
describe("exchangeTokenForKey with plans to skip", () => {
	it("sends the plans to skip and bypasses the cache both ways", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						apiKey: "next-plan-token",
						provider: "OPENAI_CHATGPT_PLAN",
						model: "gpt-6-astra",
						expiresIn: 300,
						planSource: "org:acc-2",
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const config = {
			fabricBaseUrl: "http://localhost:3001",
			excludeSources: ["org:acc-1"],
		};
		await expect(
			exchangeTokenForKey("jwt-skip", config),
		).resolves.toMatchObject({ planSource: "org:acc-2" });
		await exchangeTokenForKey("jwt-skip", config);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const init = (
			fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
		)[1];
		expect(JSON.parse(String(init.body))).toEqual({
			excludeSources: ["org:acc-1"],
		});
	});
});
