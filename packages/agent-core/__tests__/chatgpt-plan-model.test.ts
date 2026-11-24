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
import { metrics, trace } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	chatGptPlanSessionId,
	toSubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRetryableError } from "../src/retry";
import {
	createProviderModel,
	getAgentModelAsync,
	getAgentModelFromConfig,
} from "../src/services/langchain-models";

const PLAN_CONFIG = {
	provider: "OPENAI_CHATGPT_PLAN",
	apiKey: "plan-access-token",
	model: "gpt-6-astra",
	// Carried over from a header hint; must never be used for the plan.
	baseUrl: "https://gateway.example.com/v1",
};

function completedStream(
	text: string,
	failure?: { timing: "early" | "late"; code: string },
): Response {
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
		{
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{ type: "response.output_item.done", item: response.output[0] },
		failure
			? {
					type: "response.failed",
					response: {
						...response,
						status: "failed",
						error: {
							code: failure.code,
							message: "Example private failure",
						},
					},
				}
			: { type: "response.completed", response },
	];
	return new Response(
		events
			.filter(
				(event) =>
					failure?.timing !== "early" ||
					event.type === "response.created" ||
					event.type === "response.failed",
			)
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
	vi.unstubAllEnvs();
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

describe("LangChain ChatGPT plan telemetry", () => {
	let exporter: InMemorySpanExporter;
	let tracer: BasicTracerProvider;
	const recordDuration = vi.fn();
	const durationLabels = {
		provider: PLAN_CONFIG.provider,
		model: PLAN_CONFIG.model,
		operation: "chat",
	};

	beforeEach(() => {
		trace.disable();
		exporter = new InMemorySpanExporter();
		tracer = new BasicTracerProvider({
			spanProcessors: [new SimpleSpanProcessor(exporter)],
		});
		trace.setGlobalTracerProvider(tracer);
		const meter = metrics.getMeter("test");
		vi.spyOn(meter, "createHistogram").mockReturnValue({
			record: recordDuration,
		});
		vi.spyOn(metrics, "getMeter").mockReturnValue(meter);
		recordDuration.mockClear();
	});

	afterEach(async () => {
		await tracer.shutdown();
		trace.disable();
		vi.restoreAllMocks();
	});

	it.each(["invoke", "stream", "tool-bound invoke"] as const)(
		"records usage once through %s",
		async (mode) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => completedStream("Example answer")),
			);
			const model = createProviderModel(PLAN_CONFIG);
			const messages = [new HumanMessage("Example prompt")];
			if (mode === "tool-bound invoke") {
				const bound = (model as ChatOpenAI).bindTools([]);
				expect((await bound.invoke(messages)).text).toBe(
					"Example answer",
				);
			} else if (mode === "invoke") {
				expect((await model.invoke(messages)).text).toBe(
					"Example answer",
				);
			} else {
				let text = "";
				for await (const chunk of await model.stream(messages)) {
					text += chunk.text;
				}
				expect(text).toBe("Example answer");
			}
			const spans = exporter.getFinishedSpans();
			expect(spans.map((span) => span.attributes)).toEqual([
				{
					"gen_ai.system": PLAN_CONFIG.provider,
					"gen_ai.request.model": PLAN_CONFIG.model,
					"gen_ai.usage.input_tokens": 3,
					"gen_ai.usage.output_tokens": 2,
					"llm.outcome": "success",
				},
			]);
			expect(recordDuration.mock.calls).toEqual([
				[expect.any(Number), durationLabels],
			]);
		},
	);

	it.each([
		["invoke", "early"],
		["invoke", "late"],
		["stream", "early"],
	] as const)(
		"records %s usage when the SSE failure is %s",
		async (mode, timing) => {
			const fetchSpy = vi.fn(async () =>
				completedStream("Example private output", {
					timing,
					code: "invalid_prompt",
				}),
			);
			vi.stubGlobal("fetch", fetchSpy);
			const model = createProviderModel(PLAN_CONFIG);
			const messages = [new HumanMessage("Example private prompt")];
			if (mode === "invoke") {
				await expect(model.invoke(messages)).rejects.toThrow(
					"Example private failure",
				);
			} else {
				await expect(async () => {
					for await (const _chunk of await model.stream(messages)) {
						// Drain the stream to observe its failure.
					}
				}).rejects.toThrow("Example private failure");
			}
			const spans = exporter.getFinishedSpans();
			expect(spans.map((span) => span.attributes)).toEqual([
				{
					"gen_ai.system": PLAN_CONFIG.provider,
					"gen_ai.request.model": PLAN_CONFIG.model,
					"gen_ai.usage.input_tokens": 3,
					"gen_ai.usage.output_tokens": 2,
					"llm.outcome": "error",
					"error.type": expect.any(String),
				},
			]);
			expect(spans[0].status).not.toHaveProperty("message");
			expect(spans[0].events).toEqual([]);
			expect(fetchSpy).toHaveBeenCalledTimes(1);
			expect(recordDuration.mock.calls).toEqual([
				[expect.any(Number), durationLabels],
			]);
		},
	);

	it.each([
		[undefined, 0],
		[{ input_tokens: 4, output_tokens: "2" }, 4],
	] as const)(
		"reads only numeric usage from an HTTP error (%j)",
		async (usage, expectedInput) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () =>
					Response.json(
						{ error: { message: "Example private error" }, usage },
						{ status: 400 },
					),
				),
			);
			const model = createProviderModel(PLAN_CONFIG);
			await expect(
				model.invoke([new HumanMessage("Example prompt")]),
			).rejects.toThrow("Example private error");
			expect(
				exporter.getFinishedSpans().map((span) => span.attributes),
			).toEqual([
				{
					"gen_ai.system": PLAN_CONFIG.provider,
					"gen_ai.request.model": PLAN_CONFIG.model,
					"gen_ai.usage.input_tokens": expectedInput,
					"gen_ai.usage.output_tokens": 0,
					"llm.outcome": "error",
					"error.type": expect.any(String),
				},
			]);
			expect(recordDuration.mock.calls).toEqual([
				[expect.any(Number), durationLabels],
			]);
		},
	);

	it("keeps usage when LangChain wraps an HTTP failure as context overflow", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json(
					{
						error: {
							code: "context_length_exceeded",
							message:
								"Example private input exceeds the context window",
						},
						usage: { input_tokens: 7, output_tokens: 0 },
					},
					{ status: 400 },
				),
			),
		);
		const model = createProviderModel(PLAN_CONFIG);
		await expect(
			model.invoke([new HumanMessage("Example prompt")]),
		).rejects.toMatchObject({ name: "ContextOverflowError" });
		expect(
			exporter.getFinishedSpans().map((span) => span.attributes),
		).toEqual([
			expect.objectContaining({
				"llm.outcome": "error",
				"gen_ai.usage.input_tokens": 7,
				"gen_ai.usage.output_tokens": 0,
				"error.type": "ContextOverflowError",
			}),
		]);
		expect(recordDuration.mock.calls).toEqual([
			[expect.any(Number), durationLabels],
		]);
	});

	it("records reported tokens and failure after delivering partial output", async () => {
		const fetchSpy = vi.fn(async () =>
			completedStream("Example partial answer", {
				timing: "late",
				code: "subscription_sharing_usage_limit_exceeded",
			}),
		);
		vi.stubGlobal("fetch", fetchSpy);
		const model = (
			createProviderModel(PLAN_CONFIG) as ChatOpenAI
		).bindTools([]);
		let text = "";
		let error: unknown;
		try {
			for await (const chunk of await model.stream([
				new HumanMessage("Example prompt"),
			])) {
				text += chunk.text;
			}
		} catch (caught) {
			error = caught;
		}
		expect(text).toBe("Example partial answer");
		expect(
			exporter.getFinishedSpans().map((span) => span.attributes),
		).toEqual([
			{
				"gen_ai.system": PLAN_CONFIG.provider,
				"gen_ai.request.model": PLAN_CONFIG.model,
				"gen_ai.usage.input_tokens": 3,
				"gen_ai.usage.output_tokens": 2,
				"llm.outcome": "error",
				"error.type": expect.any(String),
			},
		]);
		expect(error).toBeInstanceOf(Error);
		expect(toSubscriptionPlanExhaustedError(error)).toMatchObject({
			message: "ChatGPT plan usage limit reached",
		});
		expect(isRetryableError(error)).toBe(false);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(recordDuration.mock.calls).toEqual([
			[expect.any(Number), durationLabels],
		]);
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
					thread_id: "thread-123",
					tenant_user_id: "user-1",
					tenant_organization_id: "org-1",
				},
			},
			{},
		);
		const reply = await model.invoke([new HumanMessage("Hello")]);

		expect(reply.text).toBe("From the plan");
		expect(
			new Headers(
				fetchSpy.mock.calls.find(([input]) =>
					String(input).includes("/v1/responses"),
				)?.[1]?.headers,
			).get("session_id"),
		).toBe(await chatGptPlanSessionId("thread-123"));
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

describe("plan thread session", () => {
	it.each(["sync", "async"])(
		"prefers an explicit session key to the thread in %s models",
		async (entry) => {
			const fetchSpy = vi.fn<typeof fetch>(async () =>
				completedStream("Hi"),
			);
			vi.stubGlobal("fetch", fetchSpy);
			const config = {
				configurable: {
					thread_id: "thread-123",
					ai_provider: PLAN_CONFIG.provider,
					ai_api_key: PLAN_CONFIG.apiKey,
					ai_model: PLAN_CONFIG.model,
				},
			};
			const options = { sessionKey: "conversation-123" };
			const model =
				entry === "sync"
					? getAgentModelFromConfig(config, options)
					: await getAgentModelAsync(config, options);
			await model.invoke([new HumanMessage("Hello")]);
			expect(
				new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get(
					"session_id",
				),
			).toBe(await chatGptPlanSessionId("conversation-123"));
		},
	);

	it.each(["sync", "async"])(
		"keeps the hashed thread across %s model instances",
		async (entry) => {
			const fetchSpy = vi.fn<typeof fetch>(async () =>
				completedStream("Hi"),
			);
			vi.stubGlobal("fetch", fetchSpy);
			const config = {
				configurable: {
					thread_id: "thread-123",
					ai_provider: PLAN_CONFIG.provider,
					ai_api_key: PLAN_CONFIG.apiKey,
					ai_model: PLAN_CONFIG.model,
				},
			};
			for (let i = 0; i < 2; i++) {
				const model =
					entry === "sync"
						? getAgentModelFromConfig(config)
						: await getAgentModelAsync(config);
				await model.invoke([new HumanMessage("Hello")]);
			}
			const ids = fetchSpy.mock.calls.map(([, init]) =>
				new Headers(init?.headers).get("session_id"),
			);
			expect(ids[0]).toBe(await chatGptPlanSessionId("thread-123"));
			expect(ids[0]).not.toContain("thread-123");
			expect(ids[1]).toBe(ids[0]);
		},
	);

	it("keeps the thread session when task config replaces runtime config", async () => {
		vi.stubEnv("FABRIC_API_URL", "https://fabric.example.com");
		vi.stubEnv(
			"AGENT_SERVICE_SECRET",
			"example-service-secret-0123456789abcdef",
		);
		const fetchSpy = vi.fn<typeof fetch>(async (input) => {
			if (String(input).includes("/api/agents/ai-config/task")) {
				return Response.json(PLAN_CONFIG);
			}
			return completedStream("Hi");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const model = await getAgentModelAsync(
			{
				configurable: {
					thread_id: "thread-123",
					tenant_user_id: "example-user",
					tenant_organization_id: "example-org",
					ai_provider: "GROQ",
					ai_api_key: "example-key",
					ai_model: "example-model",
				},
			},
			{ taskType: "COMPLEX" },
		);
		await model.invoke([new HumanMessage("Hello")]);
		const planCall = fetchSpy.mock.calls.find(([input]) =>
			String(input).includes("/v1/responses"),
		);
		expect(planCall).toBeDefined();
		expect(new Headers(planCall?.[1]?.headers).get("session_id")).toBe(
			await chatGptPlanSessionId("thread-123"),
		);
	});

	it.each([undefined, "", "   ", 123])(
		"uses a random session for invalid thread ID %s",
		async (threadId) => {
			const fetchSpy = vi.fn<typeof fetch>(async () =>
				completedStream("Hi"),
			);
			vi.stubGlobal("fetch", fetchSpy);
			const config = {
				configurable: {
					thread_id: threadId,
					ai_provider: PLAN_CONFIG.provider,
					ai_api_key: PLAN_CONFIG.apiKey,
					ai_model: PLAN_CONFIG.model,
				},
			};
			await getAgentModelFromConfig(config).invoke([
				new HumanMessage("Hello"),
			]);
			const model = await getAgentModelAsync(config);
			await model.invoke([new HumanMessage("Hello")]);
			const ids = fetchSpy.mock.calls.map(([, init]) =>
				new Headers(init?.headers).get("session_id"),
			);
			expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
			expect(ids[1]).not.toBe(ids[0]);
		},
	);
});
