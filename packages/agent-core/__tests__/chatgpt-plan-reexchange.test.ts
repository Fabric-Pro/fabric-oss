/**
 * An agent whose ChatGPT plan refuses a call as spent (Fizzy #2770): before
 * any output, the plan model asks the exchange once for another plan's token,
 * skipping the spent one, and sends the call again; a second refusal is
 * final. The spent plan is reported to Fabric's shared breaker (D1), and the
 * run's usage rows name the plan that actually served it (D2). Only OpenAI and
 * Fabric are simulated.
 */

import { HumanMessage } from "@langchain/core/messages";
import { getCachedKey, setCachedKey } from "@repo/ai-token";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetChatGptPlanExchanges,
	rememberChatGptPlanExchange,
	servingChatGptPlanSource,
} from "../src/services/chatgpt-plan-reexchange";
import { createProviderModel } from "../src/services/langchain-models";
import { logAgentUsageFromRunnableConfig } from "../src/services/usage-logging";

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
	const reports: unknown[] = [];
	const usageBodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: RequestInit) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/api/internal/chatgpt-plan/exhausted")) {
				reports.push(JSON.parse(String(init?.body)));
				return new Response(null, { status: 202 });
			}
			if (url.endsWith("/api/internal/ai-usage")) {
				usageBodies.push(JSON.parse(String(init?.body)));
				return new Response(null, { status: 200 });
			}
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
	return { openaiCalls, exchangeBodies, reports, usageBodies };
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

	it("reports the spent plan to Fabric before asking for another (D1)", async () => {
		const { reports } = simulate(
			{ "token-A": spent, "token-B": () => answered("From B") },
			() => exchanged("token-B", "org:acc-B"),
		);
		await planModel().invoke([new HumanMessage("Hello")]);
		await vi.waitFor(() =>
			expect(reports).toEqual([{ planSource: "org:acc-A" }]),
		);
	});

	it("passes OpenAI's reset time along with the report", async () => {
		const spentUntil = () =>
			new Response(
				JSON.stringify({
					error: {
						code: "subscription_sharing_usage_limit_exceeded",
						message: "Usage limit reached",
						resets_at: "2026-10-08T16:37:00Z",
					},
				}),
				{
					status: 429,
					headers: { "content-type": "application/json" },
				},
			);
		const { reports } = simulate(
			{ "token-A": spentUntil, "token-B": () => answered("From B") },
			() => exchanged("token-B", "org:acc-B"),
		);
		await planModel().invoke([new HumanMessage("Hello")]);
		await vi.waitFor(() =>
			expect(reports).toEqual([
				{
					planSource: "org:acc-A",
					resetAt: "2026-10-08T16:37:00.000Z",
				},
			]),
		);
	});

	it("drops this process's cached exchange, which would hand the spent plan out again", async () => {
		await setCachedKey("jwt-example", {
			apiKey: "token-A",
			provider: "OPENAI_CHATGPT_PLAN",
			model: "gpt-6-astra",
			expiresIn: 300,
			planSource: "org:acc-A",
		} as Parameters<typeof setCachedKey>[1]);
		simulate(
			{ "token-A": spent, "token-B": () => answered("From B") },
			() => exchanged("token-B", "org:acc-B"),
		);
		await planModel().invoke([new HumanMessage("Hello")]);
		await vi.waitFor(async () =>
			expect(await getCachedKey("jwt-example")).toBeNull(),
		);
	});

	it("names the plan that served the run on its usage rows after a rotation (D2)", async () => {
		const { usageBodies } = simulate(
			{ "token-A": spent, "token-B": () => answered("From B") },
			() => exchanged("token-B", "org:acc-B"),
		);
		const reply = await planModel().invoke([new HumanMessage("Hello")]);
		expect(servingChatGptPlanSource("token-A")).toBe("org:acc-B");

		vi.stubEnv("FABRIC_API_URL", FABRIC);
		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					ai_token: "jwt-example",
					ai_provider: "OPENAI_CHATGPT_PLAN",
					ai_model: "gpt-6-astra",
					ai_api_key: "token-A",
					ai_plan_source: "org:acc-A",
				},
			},
			reply,
			{ taskType: "COMPLEX" },
		);
		vi.unstubAllEnvs();
		expect(usageBodies[0]?.planSource).toBe("org:acc-B");
	});

	it("keeps the plan handed out on usage rows when nothing rotated", () => {
		expect(servingChatGptPlanSource("token-A")).toBe("org:acc-A");
		expect(servingChatGptPlanSource("token-never-handed-out")).toBeNull();
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
