/**
 * The LangGraph agents on a member's own ChatGPT plan (Fizzy #2939).
 *
 * The exchange hands an agent the plan access token as `apiKey` and the
 * plan's model as `model` under provider `OPENAI_CHATGPT_PLAN`. The factory
 * must send that token to api.openai.com only, through the Responses API with
 * the plan's request rules; the task-specific lookup must not replace the
 * plan with the organization's provider; and a spent plan window must not be
 * retried by the node-level retry.
 */

import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isRetryableError } from "../src/retry";
import {
	createProviderModel,
	getAgentModelAsync,
} from "../src/services/langchain-models";

const PLAN_CONFIG = {
	provider: "OPENAI_CHATGPT_PLAN",
	apiKey: "plan-access-token",
	model: "gpt-6-astra",
	// Carried over from a header hint; must never be used for the plan.
	baseUrl: "https://gateway.example.com/v1",
};

function completedStream(text: string): Response {
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
				(event) =>
					`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
			)
			.join(""),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("createProviderModel — OPENAI_CHATGPT_PLAN", () => {
	it("builds a Responses ChatOpenAI that sends the plan token to api.openai.com only", async () => {
		const fetchSpy = vi.fn<typeof fetch>(async () => completedStream("Hi"));
		vi.stubGlobal("fetch", fetchSpy);

		const model = createProviderModel(PLAN_CONFIG, { temperature: 0.4 });
		expect(model).toBeInstanceOf(ChatOpenAI);

		const reply = await model.invoke([new HumanMessage("Hello")]);
		expect(reply.text).toBe("Hi");

		const [url, init] = fetchSpy.mock.calls[0] ?? [];
		const target = new URL(
			typeof url === "string" ? url : url instanceof URL ? url : url.url,
		);
		expect(target.origin).toBe("https://api.openai.com");
		expect(target.pathname).toBe("/v1/responses");
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer plan-access-token",
		);
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(body.model).toBe("gpt-6-astra");
		expect(body.store).toBe(false);
		expect(body.stream).toBe(true);
		expect(body).not.toHaveProperty("temperature");
		expect(body).not.toHaveProperty("max_output_tokens");
	});
});

describe("getAgentModelAsync — OPENAI_CHATGPT_PLAN", () => {
	it("keeps the plan instead of asking the task endpoint for the organization's model", async () => {
		const fetchSpy = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchSpy);
		process.env.FABRIC_API_URL ??= "http://localhost:3001";

		const model = await getAgentModelAsync(
			{
				configurable: {
					ai_provider: PLAN_CONFIG.provider,
					ai_api_key: PLAN_CONFIG.apiKey,
					ai_model: PLAN_CONFIG.model,
					tenant_user_id: "user-1",
					tenant_organization_id: "org-1",
				},
			},
			{ taskType: "TOOL_CALLING" },
		);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect((model as ChatOpenAI).model).toBe("gpt-6-astra");
	});
});

describe("getAgentModelAsync — OPENAI_CHATGPT_PLAN from ai-config", () => {
	// A run started without runtime config (a job) asks /api/agents/ai-config,
	// which answers with the plan only for a member who included background
	// jobs and agents; the factory must build the plan model from that answer.
	it("builds the plan model from the ai-config answer and sends its token to api.openai.com", async () => {
		const fetchSpy = vi.fn<typeof fetch>(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("/api/agents/ai-config")) {
				return new Response(
					JSON.stringify({
						provider: "OPENAI_CHATGPT_PLAN",
						apiKey: "plan-access-token",
						model: "gpt-6-astra",
						gatewayUrl: null,
						deploymentName: null,
						isReasoningModel: false,
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			}
			return completedStream("From the plan");
		});
		vi.stubGlobal("fetch", fetchSpy);
		process.env.FABRIC_API_URL ??= "http://localhost:3001";
		process.env.AGENT_SERVICE_SECRET ??=
			"example-service-secret-for-tests-only-0000";

		const model = await getAgentModelAsync(
			{
				configurable: {
					tenant_user_id: "user-1",
					tenant_organization_id: "org-1",
				},
			},
			{},
		);
		const reply = await model.invoke([new HumanMessage("Hello")]);

		expect(reply.text).toBe("From the plan");
		const planCall = fetchSpy.mock.calls.find(([input]) =>
			String(input instanceof Request ? input.url : input).includes(
				"/v1/responses",
			),
		);
		const target = new URL(
			String(
				planCall?.[0] instanceof Request
					? planCall[0].url
					: planCall?.[0],
			),
		);
		expect(target.origin).toBe("https://api.openai.com");
		expect(new Headers(planCall?.[1]?.headers).get("authorization")).toBe(
			"Bearer plan-access-token",
		);
	});
});

describe("isRetryableError — spent ChatGPT plan window", () => {
	it("does not retry the plan's usage-limit refusal", () => {
		const refusal = Object.assign(new Error("402 usage limit reached"), {
			status: 402,
			error: {
				code: "subscription_sharing_usage_limit_exceeded",
				message: "usage limit reached",
			},
		});
		expect(isRetryableError(refusal)).toBe(false);
	});

	it("still retries an ordinary rate limit", () => {
		const rateLimited = Object.assign(new Error("429 Too Many Requests"), {
			status: 429,
		});
		expect(isRetryableError(rateLimited)).toBe(true);
	});
});
