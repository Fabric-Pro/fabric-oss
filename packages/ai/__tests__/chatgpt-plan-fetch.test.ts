/**
 * The ChatGPT plan request rules (Fizzy #2939), shared by the AI SDK and the
 * LangChain agents through `@repo/agent-types/chatgpt-plan-fetch`, exercised
 * with the real `@ai-sdk/openai` Responses provider: forced streaming without
 * storage, forbidden fields dropped, system → developer, non-strict schemas,
 * a usage-limit refusal that is never retried, and a cut stream reported as a
 * failure rather than a finish.
 */

import { createOpenAI } from "@ai-sdk/openai";
import {
	CHATGPT_PLAN_EXHAUSTED_CODE,
	createChatGptPlanFetch,
	redactChatGptPlanHeaders,
	SubscriptionPlanExhaustedError,
	toSubscriptionPlanExhaustedError,
	transformResponsesBody,
} from "@repo/agent-types/chatgpt-plan-fetch";
import {
	generateObject,
	generateText,
	streamText,
	tool,
	wrapLanguageModel,
} from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	__resetChatGptPlanBreaker,
	chatGptPlanExhaustedError,
} from "../lib/chatgpt-plan/exhaustion-breaker";
import {
	chatGptPlanRequestMiddleware,
	createChatGptPlanExhaustionMiddleware,
} from "../lib/chatgpt-plan/provider";

// The breaker's shared state lives in Postgres (Fizzy #2770); this suite
// exercises the in-process side only, so no row outlives a run.
vi.mock("@repo/database", () => ({
	getChatGptPlanSourceStates: async () => [],
	recordChatGptPlanSourceExhausted: async () => {},
	clearChatGptPlanSourceState: async () => {},
	getChatGptPlanOrgAccountWindows: async () => new Map(),
}));

vi.mock("../lib/chatgpt-plan/plan-credentials", () => ({
	getChatGptPlanAccessToken: vi.fn(),
	refreshChatGptPlanAfterUnauthorized: vi.fn(),
}));

function sse(events: object[]): Response {
	const body = events
		.map(
			(event) =>
				`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
	return new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function completedResponse(output: object[]) {
	return {
		id: "resp_1",
		object: "response",
		created_at: 1_790_000_000,
		status: "completed",
		model: "gpt-test",
		output,
		incomplete_details: null,
		usage: {
			input_tokens: 10,
			input_tokens_details: { cached_tokens: 0 },
			output_tokens: 5,
			output_tokens_details: { reasoning_tokens: 0 },
			total_tokens: 15,
		},
	};
}

function messageOutput(text: string) {
	return {
		type: "message",
		id: "msg_1",
		role: "assistant",
		status: "completed",
		content: [{ type: "output_text", text, annotations: [] }],
	};
}

function textStream(text: string): Response {
	const final = completedResponse([messageOutput(text)]);
	return sse([
		{
			type: "response.created",
			response: { ...final, status: "in_progress", output: [] },
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { ...messageOutput(""), status: "in_progress", content: [] },
		},
		{
			type: "response.output_text.delta",
			item_id: "msg_1",
			output_index: 0,
			content_index: 0,
			delta: text,
		},
		{
			type: "response.output_item.done",
			output_index: 0,
			item: messageOutput(text),
		},
		{ type: "response.completed", response: final },
	]);
}

function planModel(
	baseFetch: typeof fetch,
	{
		onUnauthorized,
	}: {
		onUnauthorized?: (failed: string) => Promise<string>;
	} = {},
) {
	const provider = createOpenAI({
		apiKey: "chatgpt-plan",
		baseURL: "https://api.openai.com/v1",
		fetch: createChatGptPlanFetch({
			getAccessToken: async () => "access-1",
			onUnauthorized,
			baseFetch,
		}),
	});
	return wrapLanguageModel({
		model: provider.responses("gpt-test"),
		middleware: chatGptPlanRequestMiddleware,
	});
}

const usageLimitFailure = () =>
	sse([
		{
			type: "response.created",
			response: { ...completedResponse([]), status: "in_progress" },
		},
		{
			type: "response.failed",
			response: {
				...completedResponse([]),
				status: "failed",
				error: {
					code: "subscription_sharing_usage_limit_exceeded",
					message: "limit",
				},
			},
		},
	]);

describe("transformResponsesBody", () => {
	it("forces streaming without storage, drops forbidden fields and rewrites system items", () => {
		const body = transformResponsesBody({
			model: "m",
			stream: false,
			store: true,
			temperature: 0.2,
			top_p: 1,
			max_output_tokens: 100,
			user: "u",
			metadata: {},
			previous_response_id: "r",
			service_tier: "flex",
			input: [
				{ role: "system", content: "rules" },
				{ role: "user", content: "hi" },
			],
		});
		expect(body).toEqual({
			model: "m",
			stream: true,
			store: false,
			input: [
				{ role: "developer", content: "rules" },
				{ role: "user", content: "hi" },
			],
		});
	});
});

describe("ChatGPT plan fetch with the real Responses provider", () => {
	it("aggregates a stream into a non-streaming generateText result", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			textStream("Hello, world!"),
		);
		const result = await generateText({
			model: planModel(baseFetch),
			system: "Be brief.",
			prompt: "Say hello",
			temperature: 0.7,
			maxOutputTokens: 50,
		});
		expect(result.text).toBe("Hello, world!");
		const [, init] = baseFetch.mock.calls[0] ?? [];
		const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
		expect(sent.stream).toBe(true);
		expect(sent.store).toBe(false);
		expect(sent).not.toHaveProperty("temperature");
		expect(sent).not.toHaveProperty("max_output_tokens");
		expect(JSON.stringify(sent.input)).not.toContain('"role":"system"');
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer access-1",
		);
	});

	it("passes streams through for streamText", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			textStream("Streamed"),
		);
		const result = streamText({
			model: planModel(baseFetch),
			prompt: "go",
		});
		expect(await result.text).toBe("Streamed");
	});

	it("sends a JSON schema for generateObject and parses the result", async () => {
		const json = JSON.stringify({ title: "Export CSV", priority: "high" });
		const baseFetch = vi.fn<typeof fetch>(async () => textStream(json));
		const { object } = await generateObject({
			model: planModel(baseFetch),
			schema: z.object({
				title: z.string(),
				priority: z.enum(["low", "high"]),
			}),
			prompt: "Make a feature",
		});
		expect(object).toEqual({ title: "Export CSV", priority: "high" });
		const sent = JSON.parse(String(baseFetch.mock.calls[0]?.[1]?.body)) as {
			text?: { format?: { type?: string } };
		};
		expect(sent.text?.format?.type).toBe("json_schema");
	});

	it("replays earlier turns in full instead of item_reference", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => textStream("Second"));
		await generateText({
			model: planModel(baseFetch),
			messages: [
				{ role: "user", content: "First question" },
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "First answer",
							providerOptions: { openai: { itemId: "msg_prev" } },
						},
					],
				},
				{ role: "user", content: "Follow-up" },
			],
		});
		const sent = String(baseFetch.mock.calls[0]?.[1]?.body);
		expect(sent).not.toContain("item_reference");
		expect(sent).toContain("First answer");
	});

	it("does not retry a plan usage limit in streamText either", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => usageLimitFailure());
		const errors: unknown[] = [];
		const result = streamText({
			model: planModel(baseFetch),
			prompt: "x",
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		await result.consumeStream();
		expect(baseFetch).toHaveBeenCalledTimes(1);
		expect(
			String((errors[0] as { responseBody?: string })?.responseBody),
		).toContain("subscription_sharing_usage_limit_exceeded");
	});

	it("turns a streamText stream cut before completion into an error", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			sse([
				{
					type: "response.created",
					response: {
						...completedResponse([]),
						status: "in_progress",
					},
				},
				{
					type: "response.output_item.added",
					output_index: 0,
					item: {
						...messageOutput(""),
						status: "in_progress",
						content: [],
					},
				},
				{
					type: "response.output_text.delta",
					item_id: "msg_1",
					output_index: 0,
					content_index: 0,
					delta: "half",
				},
			]),
		);
		const errors: unknown[] = [];
		const result = streamText({
			model: planModel(baseFetch),
			prompt: "x",
			onError: ({ error }) => {
				errors.push(error);
			},
		});
		await result.consumeStream();
		expect(JSON.stringify(errors)).toContain("stream_interrupted");
	});

	it("refuses to send the plan token anywhere but api.openai.com", async () => {
		const planFetch = createChatGptPlanFetch({
			getAccessToken: async () => "access-1",
			baseFetch: vi.fn<typeof fetch>(),
		});
		await expect(
			planFetch("https://evil.example.com/v1/responses", {
				method: "POST",
				body: "{}",
			}),
		).rejects.toThrow(/Refusing/);
	});

	it("refreshes once and retries after a 401", async () => {
		const baseFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("{}", { status: 401 }))
			.mockResolvedValueOnce(textStream("After refresh"));
		const onUnauthorized = vi.fn(async () => "access-2");
		const result = await generateText({
			model: planModel(baseFetch, { onUnauthorized }),
			prompt: "x",
		});
		expect(result.text).toBe("After refresh");
		expect(onUnauthorized).toHaveBeenCalledWith("access-1");
		expect(
			new Headers(baseFetch.mock.calls[1]?.[1]?.headers).get(
				"authorization",
			),
		).toBe("Bearer access-2");
	});

	it("does not retry a plan usage limit", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			sse([
				{
					type: "response.failed",
					response: {
						...completedResponse([]),
						status: "failed",
						error: {
							code: "subscription_sharing_usage_limit_exceeded",
							message: "limit",
						},
					},
				},
			]),
		);
		await expect(
			generateText({ model: planModel(baseFetch), prompt: "x" }),
		).rejects.toThrow(/limit/);
		expect(baseFetch).toHaveBeenCalledTimes(1);
	});

	it("treats a stream without response.completed as a failure", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () =>
			sse([{ type: "response.output_text.delta", delta: "half" }]),
		);
		await expect(
			generateText({
				model: planModel(baseFetch),
				prompt: "x",
				maxRetries: 0,
			}),
		).rejects.toThrow(/without response.completed/);
	});

	it("forces non-strict schemas and tools, which Fabric's optional fields need", async () => {
		const baseFetch = vi.fn<typeof fetch>(async () => textStream("{}"));
		await generateText({
			model: planModel(baseFetch),
			prompt: "weather?",
			tools: {
				get_weather: tool({
					description: "Weather",
					inputSchema: z.object({
						city: z.string(),
						unit: z.string().optional(),
					}),
				}),
			},
		});
		const sent = JSON.parse(String(baseFetch.mock.calls[0]?.[1]?.body)) as {
			tools: Array<{ strict?: boolean }>;
		};
		expect(sent.tools[0]?.strict).not.toBe(true);
		expect(
			transformResponsesBody({
				text: { format: { type: "json_schema", strict: true } },
			}).text,
		).toEqual({ format: { type: "json_schema", strict: false } });
	});
});

describe("plan usage limit as a typed error", () => {
	beforeEach(() => {
		__resetChatGptPlanBreaker();
	});

	function exhaustingModel(baseFetch: typeof fetch) {
		return wrapLanguageModel({
			model: planModel(baseFetch),
			middleware: createChatGptPlanExhaustionMiddleware("user-1"),
		});
	}

	it("surfaces SubscriptionPlanExhaustedError with the reset time, then fails fast", async () => {
		// An hour from now, on a whole minute, so the breaker is still open for
		// the second call whenever the suite runs.
		const resetsAt = new Date(
			Math.ceil((Date.now() + 60 * 60_000) / 60_000) * 60_000,
		).toISOString();
		const baseFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(
					JSON.stringify({
						error: {
							code: CHATGPT_PLAN_EXHAUSTED_CODE,
							message: "limit",
							resets_at: resetsAt,
						},
					}),
					{
						status: 429,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const first = await generateText({
			model: exhaustingModel(baseFetch),
			prompt: "x",
		}).catch((error: unknown) => error);
		expect(first).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			(first as SubscriptionPlanExhaustedError).resetAt?.toISOString(),
		).toBe(resetsAt);
		expect((first as Error).constructor.name).toBe(
			"SubscriptionPlanExhaustedError",
		);
		// The sentence the chat, toasts and the document's stored failure all
		// show names the reset as a clock time.
		expect((first as Error).message).toContain(
			`It resets at ${resetsAt.slice(0, 16).replace("T", " ")} UTC.`,
		);

		await expect(
			generateText({ model: exhaustingModel(baseFetch), prompt: "x" }),
		).rejects.toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(baseFetch).toHaveBeenCalledTimes(1);
		expect(
			chatGptPlanExhaustedError("user-1", Date.parse(resetsAt) + 1),
		).toBeNull();
	});

	it("recognizes the refusal in either SDK's error shape and nothing else", () => {
		const body = JSON.stringify({
			error: { code: CHATGPT_PLAN_EXHAUSTED_CODE, message: "limit" },
		});
		expect(
			toSubscriptionPlanExhaustedError({ responseBody: body }),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			toSubscriptionPlanExhaustedError({
				status: 402,
				error: { code: CHATGPT_PLAN_EXHAUSTED_CODE, message: "limit" },
			}),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			toSubscriptionPlanExhaustedError(
				new Error("wrapped", { cause: { responseBody: body } }),
			),
		).toBeInstanceOf(SubscriptionPlanExhaustedError);
		expect(
			toSubscriptionPlanExhaustedError({
				status: 429,
				error: { code: "rate_limit_exceeded" },
			}),
		).toBeNull();
	});
});

// Fizzy #2770: whether OpenAI reports the usage window in headers is unknown,
// so staging logs them once, redacted, behind CHATGPT_PLAN_HEADER_DEBUG.
describe("response header capture", () => {
	it("reports the final reply's status and headers, after a 401 retry", async () => {
		const baseFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("{}", { status: 401 }))
			.mockResolvedValueOnce(
				new Response("{}", {
					status: 200,
					headers: { "x-usage-window": "5h" },
				}),
			);
		const seen: Array<[number, string | null]> = [];
		const planFetch = createChatGptPlanFetch({
			getAccessToken: async () => "access-1",
			onUnauthorized: async () => "access-2",
			onResponseHeaders: (status, headers) => {
				seen.push([status, headers.get("x-usage-window")]);
			},
			baseFetch,
		});
		await planFetch("https://api.openai.com/v1/models");
		expect(seen).toEqual([[200, "5h"]]);
	});

	it("never fails the call when the observer throws", async () => {
		const planFetch = createChatGptPlanFetch({
			getAccessToken: async () => "access-1",
			onResponseHeaders: () => {
				throw new Error("observer bug");
			},
			baseFetch: vi.fn<typeof fetch>(
				async () => new Response("{}", { status: 200 }),
			),
		});
		const response = await planFetch("https://api.openai.com/v1/models");
		expect(response.status).toBe(200);
	});

	it("redacts every value that could identify or authenticate the account", () => {
		const redacted = redactChatGptPlanHeaders(
			new Headers({
				"set-cookie": "__cf_bm=abc",
				"openai-organization": "org-123",
				"openai-project": "proj_1",
				"x-request-id": "req_1",
				"x-ratelimit-remaining-requests": "9",
				"retry-after": "30",
			}),
		);
		expect(redacted).toEqual({
			"set-cookie": "[redacted]",
			"openai-organization": "[redacted]",
			"openai-project": "[redacted]",
			"x-request-id": "req_1",
			"x-ratelimit-remaining-requests": "9",
			"retry-after": "30",
		});
	});
});
