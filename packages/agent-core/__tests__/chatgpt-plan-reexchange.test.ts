/**
 * An agent whose ChatGPT plan refuses a call as spent (Fizzy #2770): before
 * any output, the plan model asks the exchange once for another plan's token,
 * skipping the spent one, and sends the call again; a second refusal is
 * final. Only OpenAI and the exchange are simulated.
 */

import { HumanMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetChatGptPlanExchanges,
	rememberChatGptPlanExchange,
} from "../src/services/chatgpt-plan-reexchange";
import { createProviderModel } from "../src/services/langchain-models";

const FABRIC = "http://fabric.example.com";

function answered(text: string): Response {
	const response = {
		id: "resp_1",
		object: "response",
		created_at: 1_790_000_000,
		status: "completed",
		model: "gpt-6-astra",
		output: [
			{
				type: "message",
				id: "msg_1",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text, annotations: [] }],
			},
		],
		usage: {
			input_tokens: 3,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 2,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 5,
		},
	};
	const events = [
		{ type: "response.created", response: { ...response, output: [] } },
		{ type: "response.output_item.done", item: response.output[0] },
		{ type: "response.completed", response },
	];
	return new Response(
		events
			.map(
				(event, index) =>
					`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: index })}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

const spent = () =>
	new Response(
		JSON.stringify({
			error: {
				code: "subscription_sharing_usage_limit_exceeded",
				message: "Usage limit reached",
			},
		}),
		{ status: 429, headers: { "content-type": "application/json" } },
	);

const exchanged = (apiKey: string, planSource: string) =>
	new Response(
		JSON.stringify({
			apiKey,
			provider: "OPENAI_CHATGPT_PLAN",
			model: "gpt-6-astra",
			expiresIn: 300,
			planSource,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

/** OpenAI answers per plan token; the exchange hands out the next one. */
function simulate(
	plans: Record<string, () => Response>,
	nextPlan: () => Response,
) {
	const openaiCalls: string[] = [];
	const exchangeBodies: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.startsWith(FABRIC)) {
				exchangeBodies.push(JSON.parse(String(init?.body)));
				return nextPlan();
			}
			const token =
				new Headers(init?.headers).get("authorization")?.slice(7) ?? "";
			openaiCalls.push(token);
			return (plans[token] ?? spent)();
		}),
	);
	return { openaiCalls, exchangeBodies };
}

const planModel = () =>
	createProviderModel({
		provider: "OPENAI_CHATGPT_PLAN",
		apiKey: "token-A",
		model: "gpt-6-astra",
	});

beforeEach(() => {
	__resetChatGptPlanExchanges();
	rememberChatGptPlanExchange({
		accessToken: "token-A",
		aiToken: "jwt-example",
		fabricBaseUrl: FABRIC,
		planSource: "org:acc-A",
		expiresInSeconds: 300,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("plan model — a spent plan", () => {
	it("asks once for another plan's token, skipping the spent one, and sends the call again", async () => {
		const { openaiCalls, exchangeBodies } = simulate(
			{ "token-A": spent, "token-B": () => answered("From B") },
			() => exchanged("token-B", "org:acc-B"),
		);
		const reply = await planModel().invoke([new HumanMessage("Hello")]);

		expect(reply.text).toBe("From B");
		expect(openaiCalls).toEqual(["token-A", "token-B"]);
		expect(exchangeBodies).toEqual([{ excludeSources: ["org:acc-A"] }]);
	});

	it("gives up after the second refusal", async () => {
		const { openaiCalls, exchangeBodies } = simulate(
			{ "token-A": spent, "token-B": spent },
			() => exchanged("token-B", "org:acc-B"),
		);
		await expect(
			planModel().invoke([new HumanMessage("Hello")]),
		).rejects.toThrow();
		expect(openaiCalls).toEqual(["token-A", "token-B"]);
		expect(exchangeBodies).toHaveLength(1);
	});

	it("keeps the refusal when no other plan serves the work", async () => {
		const { openaiCalls } = simulate(
			{ "token-A": spent },
			() =>
				new Response(
					JSON.stringify({ code: "CHATGPT_PLAN_EXHAUSTED" }),
					{
						status: 429,
					},
				),
		);
		await expect(
			planModel().invoke([new HumanMessage("Hello")]),
		).rejects.toThrow();
		expect(openaiCalls).toEqual(["token-A"]);
	});

	it("never re-exchanges a token this process did not hand out", async () => {
		__resetChatGptPlanExchanges();
		const { exchangeBodies } = simulate({ "token-A": spent }, () =>
			exchanged("token-B", "org:acc-B"),
		);
		await expect(
			planModel().invoke([new HumanMessage("Hello")]),
		).rejects.toThrow();
		expect(exchangeBodies).toEqual([]);
	});
});
