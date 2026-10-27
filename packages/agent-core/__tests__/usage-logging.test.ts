import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentConfigurable } from "../src/services/agent-configurable";
import {
	__resetChatGptPlanExchanges,
	rememberChatGptPlanExchange,
} from "../src/services/chatgpt-plan-reexchange";
import { recordServedModel } from "../src/services/served-model";
import {
	agentUsageConfigFromInput,
	extractUsageFromLangChainResponse,
	logAgentUsageFromRunnableConfig,
} from "../src/services/usage-logging";

describe("extractUsageFromLangChainResponse", () => {
	it("reads token counts + cache/reasoning breakdown + gateway generationId", () => {
		const message = {
			usage_metadata: {
				input_tokens: 100,
				output_tokens: 40,
				total_tokens: 140,
				input_token_details: { cache_read: 80, cache_creation: 20 },
				output_token_details: { reasoning: 12 },
			},
			response_metadata: { gateway: { generationId: "gen_01ABC" } },
		};
		expect(extractUsageFromLangChainResponse(message)).toEqual({
			inputTokens: 100,
			outputTokens: 40,
			totalTokens: 140,
			cachedInputTokens: 80,
			cacheCreationInputTokens: 20,
			reasoningTokens: 12,
			gatewayGenerationId: "gen_01ABC",
		});
	});

	it("falls back to response_metadata.tokenUsage and leaves optional fields undefined", () => {
		const message = {
			response_metadata: {
				tokenUsage: {
					promptTokens: 10,
					completionTokens: 5,
					totalTokens: 15,
				},
			},
		};
		const usage = extractUsageFromLangChainResponse(message);
		expect(usage).toMatchObject({
			inputTokens: 10,
			outputTokens: 5,
			totalTokens: 15,
		});
		expect(usage?.cachedInputTokens).toBeUndefined();
		expect(usage?.reasoningTokens).toBeUndefined();
		expect(usage?.gatewayGenerationId).toBeUndefined();
	});

	it("returns null for a non-object response", () => {
		expect(extractUsageFromLangChainResponse(null)).toBeNull();
		expect(extractUsageFromLangChainResponse("nope")).toBeNull();
	});

	it("falls back to response_metadata.usage.cache_creation_input_tokens for Databricks-served Claude", () => {
		// @langchain/openai never maps a cache-WRITE count into
		// usage_metadata.input_token_details.cache_creation — no OpenAI wire
		// shape carries one. For Databricks (which sends `system_fingerprint`),
		// its completions parser spreads the raw wire usage object verbatim onto
		// response_metadata.usage, so the Anthropic-named field survives there.
		const message = {
			usage_metadata: {
				input_tokens: 4573,
				output_tokens: 4,
				total_tokens: 4577,
				// The compat-layer normalization already mapped the cache-READ
				// count onto prompt_tokens_details.cached_tokens before this
				// parser ran, so input_token_details.cache_read is populated as
				// usual — only the cache-WRITE count has no such mapping.
				input_token_details: { cache_read: 0 },
			},
			response_metadata: {
				usage: {
					cache_creation: {
						ephemeral_1h_input_tokens: 0,
						ephemeral_5m_input_tokens: 4570,
					},
					cache_creation_input_tokens: 4570,
					cache_read_input_tokens: 0,
					completion_tokens: 4,
					prompt_tokens: 4573,
					total_tokens: 4577,
				},
			},
		};
		expect(extractUsageFromLangChainResponse(message)).toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 0,
			cacheCreationInputTokens: 4570,
		});
	});

	it("prefers usage_metadata.input_token_details.cache_creation over the response_metadata.usage fallback", () => {
		const message = {
			usage_metadata: {
				input_tokens: 100,
				output_tokens: 10,
				input_token_details: { cache_creation: 25 },
			},
			response_metadata: {
				usage: { cache_creation_input_tokens: 999 },
			},
		};
		expect(
			extractUsageFromLangChainResponse(message)
				?.cacheCreationInputTokens,
		).toBe(25);
	});

	it("does not fabricate cacheCreationInputTokens when neither source has it", () => {
		const message = {
			usage_metadata: { input_tokens: 5, output_tokens: 1 },
			response_metadata: { usage: { prompt_tokens: 5 } },
		};
		expect(
			extractUsageFromLangChainResponse(message)
				?.cacheCreationInputTokens,
		).toBeUndefined();
	});
});

/**
 * Chat and summarization send usage without awaiting it. The logger catches
 * failures so telemetry does not reject into those callers.
 */
describe("logAgentUsageFromRunnableConfig — never rejects", () => {
	const config = {
		configurable: {
			ai_token: "token",
			ai_provider: "OPENAI_DIRECT",
			ai_model: "gpt-4o-mini",
		},
	};

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("resolves when the transport rejects", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("connection refused");
			}),
		);

		await expect(
			logAgentUsageFromRunnableConfig(
				config,
				{ usage_metadata: { input_tokens: 1, output_tokens: 2 } },
				{ taskType: "TOOL_CALLING" },
			),
		).resolves.toBeUndefined();
	});

	it("resolves when shaping the payload throws", async () => {
		const exploding = {};
		Object.defineProperty(exploding, "usage_metadata", {
			get() {
				throw new Error("boom");
			},
		});

		await expect(
			logAgentUsageFromRunnableConfig(config, exploding, {
				taskType: "TOOL_CALLING",
			}),
		).resolves.toBeUndefined();
	});
});

describe("logAgentUsageFromRunnableConfig — cache accounting", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function captureUsageBody(
		provider: string,
		cacheRead = 3000,
		cacheCreation = 1570,
	) {
		const rawInput = 3;
		const output = 4;
		const inclusiveInput = rawInput + cacheRead + cacheCreation;
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response(null, { status: 204 });
			}),
		);

		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					ai_token: "token",
					ai_provider: provider,
					ai_model: "claude-sonnet-4-5",
				},
			},
			{
				usage_metadata: {
					// @langchain/anthropic includes both cache buckets here.
					input_tokens: inclusiveInput,
					output_tokens: output,
					total_tokens: inclusiveInput + output,
					input_token_details: {
						cache_read: cacheRead,
						cache_creation: cacheCreation,
					},
				},
				response_metadata: {
					model_provider:
						provider === "ANTHROPIC_DIRECT"
							? "anthropic"
							: "openai",
				},
			},
			{ taskType: "TOOL_CALLING" },
		);

		return requestBody;
	}

	// One contract for every writer: `inputTokens`/`totalTokens` are the
	// provider's inclusive totals and the cache columns break them down. The
	// AI SDK path already records it this way, and the estimator subtracts the
	// cache buckets back out for every Anthropic provider.
	it("keeps native Anthropic cache reads inside the inclusive input total", async () => {
		await expect(
			captureUsageBody("ANTHROPIC_DIRECT", 4570, 0),
		).resolves.toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 4570,
			cacheCreationInputTokens: 0,
		});
	});

	it("keeps native Anthropic cache writes inside the inclusive input total", async () => {
		await expect(
			captureUsageBody("ANTHROPIC_DIRECT", 0, 4570),
		).resolves.toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 0,
			cacheCreationInputTokens: 4570,
		});
	});

	it("records native Anthropic and Databricks Claude with the same inclusive shape", async () => {
		const native = await captureUsageBody("ANTHROPIC_DIRECT");
		const databricks = await captureUsageBody("DATABRICKS");
		const pick = (body: Record<string, unknown> | undefined) => ({
			inputTokens: body?.inputTokens,
			totalTokens: body?.totalTokens,
			cachedInputTokens: body?.cachedInputTokens,
			cacheCreationInputTokens: body?.cacheCreationInputTokens,
		});
		expect(pick(native)).toEqual(pick(databricks));
	});

	it("keeps Databricks Claude cache buckets inside input tokens", async () => {
		await expect(captureUsageBody("DATABRICKS")).resolves.toMatchObject({
			inputTokens: 4573,
			outputTokens: 4,
			totalTokens: 4577,
			cachedInputTokens: 3000,
			cacheCreationInputTokens: 1570,
		});
	});
});

// Fizzy #2770: the usage row of a call on a shared ChatGPT plan account names
// the account; the agent passes on the plan the exchange handed it.
describe("logAgentUsageFromRunnableConfig — plan source", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the plan source the exchange returned", async () => {
		let requestBody: Record<string, unknown> | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init?: RequestInit) => {
				requestBody = JSON.parse(String(init?.body));
				return new Response(null, { status: 204 });
			}),
		);
		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					ai_token: "token",
					ai_provider: "OPENAI_CHATGPT_PLAN",
					ai_model: "gpt-6-astra",
					ai_plan_source: "org:acc-1",
				},
			},
			{
				usage_metadata: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
				},
			},
			{ taskType: "TOOL_CALLING" },
		);
		expect(requestBody).toMatchObject({
			provider: "OPENAI_CHATGPT_PLAN",
			planSource: "org:acc-1",
		});
	});
});

describe("delegated conversation attribution", () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each(["conversation-example", undefined])(
		"uses only usage_conversation_id (%s)",
		async (conversationId) => {
			const send = vi.fn(
				async (_url: string, _init: RequestInit) => new Response("{}"),
			);
			vi.stubGlobal("fetch", send);
			await logAgentUsageFromRunnableConfig(
				{
					configurable: {
						ai_token: "token-example",
						ai_provider: "CUSTOM",
						ai_model: "model-example",
						usage_conversation_id: conversationId,
						thread_id: "thread-example",
						executionId: "execution-example",
					},
				},
				{ usage_metadata: { input_tokens: 1, output_tokens: 2 } },
				{ taskType: "CHAT" },
			);
			const body = JSON.parse(send.mock.calls[0][1].body as string);
			expect(body.conversationId).toBe(conversationId);
		},
	);
});

it("writes the complete delegated origin without changing the graph retrieval project", async () => {
	const send = vi.fn(
		async (_url: string, _init: RequestInit) => new Response("{}"),
	);
	vi.stubGlobal("fetch", send);
	try {
		const configurable = buildAgentConfigurable({
			ai_token: "token-example",
			ai_provider: "CUSTOM",
			ai_model: "model-example",
			project_id: "retrieval-project",
			usage_project_id: "origin-project",
			usage_conversation_id: "origin-conversation",
			usage_frame_id: "origin-frame",
			usage_feature_key: "chat-agent",
			thread_id: "execution-only",
		});
		await logAgentUsageFromRunnableConfig(
			{ configurable },
			{ usage_metadata: { input_tokens: 1, output_tokens: 2 } },
			{
				model: undefined,
				taskType: "CHAT",
				projectId: "retrieval-project",
			},
		);
		expect(JSON.parse(String(send.mock.calls[0][1].body))).toMatchObject({
			projectId: "origin-project",
			conversationId: "origin-conversation",
			frameId: "origin-frame",
			featureKey: "chat-agent",
		});
		expect(configurable.fabric_usage).toMatchObject({
			project_id: "retrieval-project",
		});
		expect(configurable).not.toHaveProperty("ai_token");
	} finally {
		vi.unstubAllGlobals();
	}
});

it("does not infer frame or feature origin from a thread, context or execution", async () => {
	const send = vi.fn(
		async (_url: string, _init: RequestInit) => new Response("{}"),
	);
	vi.stubGlobal("fetch", send);
	try {
		await logAgentUsageFromRunnableConfig(
			{
				configurable: agentUsageConfigFromInput({
					ai_token: "token-example",
					ai_provider: "CUSTOM",
					ai_model: "model-example",
					thread_id: "thread-only",
					contextId: "context-only",
					frameId: "unverified-frame",
				}),
			},
			{ usage_metadata: { input_tokens: 1 } },
			{ model: undefined, taskType: "CHAT" },
		);
		const body = JSON.parse(String(send.mock.calls[0][1].body));
		expect(body).not.toHaveProperty("frameId");
		expect(body).not.toHaveProperty("featureKey");
		expect(body).not.toHaveProperty("conversationId");
	} finally {
		vi.unstubAllGlobals();
	}
});

it("carries A2A usage configuration into the logger without thread or execution fallbacks", async () => {
	const send = vi.fn(
		async (_url: string, _init: RequestInit) => new Response("{}"),
	);
	vi.stubGlobal("fetch", send);
	try {
		const configurable = agentUsageConfigFromInput({
			ai_token: "token-example",
			ai_provider: "CUSTOM",
			ai_model: "model-example",
			usage_conversation_id: "conversation-example",
			contextId: "a2a-example",
			thread_id: "thread-example",
		});
		await logAgentUsageFromRunnableConfig(
			{ configurable },
			{ usage_metadata: { input_tokens: 1 } },
			{ taskType: "CHAT" },
		);
		expect(
			JSON.parse(send.mock.calls[0][1].body as string).conversationId,
		).toBe("conversation-example");
		expect(configurable).not.toHaveProperty("thread_id");
		expect(configurable).not.toHaveProperty("contextId");
	} finally {
		vi.unstubAllGlobals();
	}
});

it("keeps copied credentials out of graph consumers while preserving usage auth and plan source", async () => {
	const copied = agentUsageConfigFromInput({
		ai_token: "usage-token-example",
		ai_provider: "OPENAI_CHATGPT_PLAN",
		ai_model: "usage-model-example",
		ai_plan_source: "org:account-example",
		usage_conversation_id: "conversation-example",
	});
	expect(copied).not.toHaveProperty("ai_token");
	expect(copied).not.toHaveProperty("ai_model");
	expect(copied).not.toHaveProperty("ai_provider");
	expect(copied).not.toHaveProperty("tenant_user_id");
	const send = vi.fn(
		async (_url: string, _init: RequestInit) => new Response("{}"),
	);
	vi.stubGlobal("fetch", send);
	try {
		await logAgentUsageFromRunnableConfig(
			{ configurable: copied },
			{ usage_metadata: { input_tokens: 1 } },
			{ taskType: "CHAT" },
		);
		expect(
			(send.mock.calls[0][1].headers as Record<string, string>)[
				"X-AI-Token"
			],
		).toBe("usage-token-example");
		expect(JSON.parse(send.mock.calls[0][1].body as string)).toMatchObject({
			planSource: "org:account-example",
			conversationId: "conversation-example",
		});
	} finally {
		vi.unstubAllGlobals();
	}
});
it("prefers updated serving-model fields over initial A2A usage metadata", async () => {
	const copied = agentUsageConfigFromInput({
		ai_token: "old-token-example",
		ai_provider: "CUSTOM",
		ai_model: "old-model-example",
	});
	const send = vi.fn(
		async (_url: string, _init: RequestInit) => new Response("{}"),
	);
	vi.stubGlobal("fetch", send);
	try {
		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					...copied,
					ai_token: "current-token-example",
					ai_provider: "CUSTOM",
					ai_model: "current-model-example",
				},
			},
			{ usage_metadata: { input_tokens: 1 } },
			{ taskType: "CHAT" },
		);
		expect(JSON.parse(send.mock.calls[0][1].body as string).model).toBe(
			"current-model-example",
		);
	} finally {
		vi.unstubAllGlobals();
	}
});

it("does not enable model resolution through the usage-only record", async () => {
	const { extractProviderConfig, getAgentModelAsync } = await import(
		"../src/services/langchain-models"
	);
	const configurable = agentUsageConfigFromInput({
		ai_token: "token-example",
		ai_model: "model-example",
		ai_provider: "CUSTOM",
		tenant_user_id: "user-example",
		ai_api_key: "key-example",
	});
	const send = vi.fn();
	vi.stubGlobal("fetch", send);
	try {
		expect(extractProviderConfig({ configurable })).toBeUndefined();
		await expect(getAgentModelAsync({ configurable })).rejects.toThrow(
			"No AI provider configured",
		);
		expect(send).not.toHaveBeenCalled();
	} finally {
		vi.unstubAllGlobals();
	}
});

describe("served model attribution", () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each(["recorded", "no instance", "unrecorded", "undefined provider"])(
		"uses the served identity with fallback: %s",
		async (scenario) => {
			const model = scenario === "no instance" ? undefined : {};
			if (model && scenario !== "unrecorded") {
				recordServedModel(model, {
					model: "served-model",
					provider:
						scenario === "undefined provider"
							? undefined
							: "ANTHROPIC_DIRECT",
				});
			}
			const send = vi.fn(
				async (_url: string, _init: RequestInit) =>
					new Response(null, { status: 204 }),
			);
			vi.stubGlobal("fetch", send);
			await logAgentUsageFromRunnableConfig(
				{
					configurable: {
						ai_token: "example-token",
						ai_provider: "GROQ",
						ai_model: "exchanged-model",
					},
				},
				{ usage_metadata: { input_tokens: 10, output_tokens: 2 } },
				{ taskType: "COMPLEX", model },
			);
			expect(send).toHaveBeenCalledTimes(1);
			expect(
				JSON.parse(send.mock.calls[0][1].body as string),
			).toMatchObject({
				provider: scenario === "recorded" ? "ANTHROPIC_DIRECT" : "GROQ",
				model:
					scenario === "recorded" || scenario === "undefined provider"
						? "served-model"
						: "exchanged-model",
			});
		},
	);
});

it("resolves planSource using the effective recorded provider", async () => {
	const model = {};
	recordServedModel(model, {
		provider: "OPENAI_CHATGPT_PLAN",
		model: "served-plan-model",
	});
	rememberChatGptPlanExchange({
		accessToken: "example-access-token",
		aiToken: "example-token",
		fabricBaseUrl: "https://fabric.example.com",
		planSource: "org:example-serving-account",
		expiresInSeconds: 60,
	});
	const send = vi.fn(
		async (_url: string, _init: RequestInit) =>
			new Response(null, { status: 204 }),
	);
	vi.stubGlobal("fetch", send);
	try {
		await logAgentUsageFromRunnableConfig(
			{
				configurable: {
					ai_token: "example-token",
					ai_api_key: "example-access-token",
					ai_provider: "GROQ",
					ai_model: "exchanged-model",
					ai_plan_source: "org:example-initial-account",
				},
			},
			{ usage_metadata: { input_tokens: 10 } },
			{ taskType: "COMPLEX", model },
		);
		expect(JSON.parse(send.mock.calls[0][1].body as string)).toMatchObject({
			provider: "OPENAI_CHATGPT_PLAN",
			model: "served-plan-model",
			planSource: "org:example-serving-account",
		});
	} finally {
		vi.unstubAllGlobals();
		__resetChatGptPlanExchanges();
	}
});

describe("reply provenance usage payload", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("sends the reply id only when the call explicitly opts in", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				return new Response(null, { status: 204 });
			}),
		);
		const id = "msg_1793000000000_0123456789abcdef0123456789abcdef";
		const config = {
			configurable: {
				ai_token: "example-token",
				ai_provider: "VERCEL_GATEWAY",
				ai_model: "example-model",
				output_message_id: id,
			},
		};
		const response = {
			usage_metadata: {
				input_tokens: 2,
				output_tokens: 1,
				total_tokens: 3,
			},
		};
		await logAgentUsageFromRunnableConfig(config, response, {
			model: undefined,
			taskType: "TOOL_CALLING",
			outputMessageId: id,
		});
		await logAgentUsageFromRunnableConfig(config, response, {
			model: undefined,
			taskType: "SIMPLE",
		});
		expect(bodies[0].outputMessageId).toBe(id);
		expect(bodies[1]).not.toHaveProperty("outputMessageId");
	});
});

describe("reply usage send ordering", () => {
	afterEach(() => vi.unstubAllGlobals());
	const config = {
		configurable: {
			ai_token: "example-token",
			ai_provider: "VERCEL_GATEWAY",
			ai_model: "example-model",
		},
	};
	const response = {
		usage_metadata: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
	};
	const options = {
		model: undefined,
		taskType: "TOOL_CALLING",
		outputMessageId: "msg_1793000000000_0123456789abcdef0123456789abcdef",
	};
	it("sends the same reply's calls in order while other usage proceeds independently", async () => {
		let releaseFirst!: () => void;
		const firstPost = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const received: string[] = [];
		const post = vi.fn(async (_url, init) => {
			const body = JSON.parse(init.body);
			received.push(body.agentId);
			if (body.agentId === "example-first") {
				await firstPost;
			}
			return new Response(null, { status: 204 });
		});
		vi.stubGlobal("fetch", post);
		const first = logAgentUsageFromRunnableConfig(config, response, {
			...options,
			agentId: "example-first",
		});
		const second = logAgentUsageFromRunnableConfig(config, response, {
			...options,
			agentId: "example-final",
		});
		const otherReply = logAgentUsageFromRunnableConfig(config, response, {
			...options,
			outputMessageId:
				"msg_1793000000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			agentId: "example-other-reply",
		});
		const unchained = logAgentUsageFromRunnableConfig(config, response, {
			...options,
			outputMessageId: undefined,
			agentId: "example-side-call",
		});
		try {
			expect(received).toEqual([
				"example-first",
				"example-other-reply",
				"example-side-call",
			]);
			await Promise.all([otherReply, unchained]);
		} finally {
			releaseFirst();
			await Promise.all([first, second, otherReply, unchained]);
		}
		expect(received).toEqual([
			"example-first",
			"example-other-reply",
			"example-side-call",
			"example-final",
		]);
	});
	it("retains a newer pending tail, then removes the settled chain so a fresh send starts immediately", async () => {
		const releases: (() => void)[] = [];
		const post = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					releases.push(() =>
						resolve(new Response(null, { status: 204 })),
					);
				}),
		);
		vi.stubGlobal("fetch", post);
		const sends: Promise<void>[] = [];
		try {
			sends.push(
				logAgentUsageFromRunnableConfig(config, response, options),
			);
			sends.push(
				logAgentUsageFromRunnableConfig(config, response, options),
			);
			expect(post).toHaveBeenCalledTimes(1);
			releases[0]();
			await sends[0];
			await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
			sends.push(
				logAgentUsageFromRunnableConfig(config, response, options),
			);
			expect(post).toHaveBeenCalledTimes(2);
			releases[1]();
			await sends[1];
			await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(3));
			releases[2]();
			await Promise.all(sends);
			// A retained settled tail would defer this POST to a microtask. Immediate
			// start proves the completed reply's queue entry was removed.
			sends.push(
				logAgentUsageFromRunnableConfig(config, response, options),
			);
			expect(post).toHaveBeenCalledTimes(4);
			releases[3]();
			await sends[3];
		} finally {
			// Complete any requests admitted before a failed assertion, including tails.
			post.mockImplementation(
				async () => new Response(null, { status: 204 }),
			);
			for (const release of releases) {
				release();
			}
			await Promise.all(sends);
		}
	});
	it("continues the chain after a failed POST and cleans it up", async () => {
		const post = vi
			.fn()
			.mockRejectedValueOnce(new Error("example-network-failure"))
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", post);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const first = logAgentUsageFromRunnableConfig(
				config,
				response,
				options,
			);
			const second = logAgentUsageFromRunnableConfig(
				config,
				response,
				options,
			);
			await expect(Promise.all([first, second])).resolves.toEqual([
				undefined,
				undefined,
			]);
			expect(post).toHaveBeenCalledTimes(2);
			const fresh = logAgentUsageFromRunnableConfig(
				config,
				response,
				options,
			);
			expect(post).toHaveBeenCalledTimes(3);
			await fresh;
		} finally {
			error.mockRestore();
		}
	});
});

describe("usage payload call-time snapshots", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		__resetChatGptPlanExchanges();
	});
	it("keeps the queued call's serving plan when a later call re-exchanges plans", async () => {
		const root = "example-root-access-token";
		const remember = (planSource: string) =>
			rememberChatGptPlanExchange({
				accessToken: root,
				aiToken: "example-token",
				fabricBaseUrl: "http://localhost:3000",
				planSource,
				expiresInSeconds: 60,
			});
		remember("org:example-call-time-account");
		let releaseFirst!: () => void;
		const firstPost = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url, init) => {
				bodies.push(JSON.parse(init.body));
				if (bodies.length === 1) {
					await firstPost;
				}
				return new Response(null, { status: 204 });
			}),
		);
		const config = {
			configurable: {
				ai_token: "example-token",
				ai_provider: "OPENAI_CHATGPT_PLAN",
				ai_model: "example-model",
				ai_api_key: root,
			},
		};
		const response = {
			usage_metadata: {
				input_tokens: 2,
				output_tokens: 1,
				total_tokens: 3,
			},
		};
		const options = {
			model: undefined,
			taskType: "TOOL_CALLING",
			outputMessageId:
				"msg_1793000000000_0123456789abcdef0123456789abcdef",
		};
		const first = logAgentUsageFromRunnableConfig(
			config,
			response,
			options,
		);
		const queued = logAgentUsageFromRunnableConfig(
			config,
			response,
			options,
		);
		try {
			expect(bodies).toHaveLength(1);
			remember("org:example-later-account");
		} finally {
			releaseFirst();
			await Promise.all([first, queued]);
		}
		expect(bodies).toHaveLength(2);
		expect(bodies[1].planSource).toBe("org:example-call-time-account");
	});
	it.each([true, false])(
		"captures config, options, response, model identity and destination before state changes (queued=%s)",
		async (queued) => {
			vi.stubEnv("FABRIC_API_URL", "http://localhost:3000");
			let releaseFirst!: () => void;
			const firstPost = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			const received: {
				url: string;
				token: string | undefined;
				body: Record<string, unknown>;
			}[] = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url, init) => {
					const body = JSON.parse(init.body);
					received.push({
						url: String(url),
						token: init.headers["X-AI-Token"],
						body,
					});
					if (body.agentId === "example-blocker") {
						await firstPost;
					}
					return new Response(null, { status: 204 });
				}),
			);
			const outputMessageId =
				"msg_1793000000000_0123456789abcdef0123456789abcdef";
			const model = {};
			recordServedModel(model, {
				provider: "VERCEL_GATEWAY",
				model: "example-call-time-model",
			});
			const fabricUsage = {
				ai_token: "example-call-time-token",
				ai_provider: "GROQ",
				ai_model: "example-fallback-model",
				ai_billing_mode: "example-call-time-billing",
				ai_billing_customer_id: "example-call-time-customer",
				ai_plan_source: "org:example-configured-account",
				project_id: "example-config-project",
				usage_conversation_id: "example-config-conversation",
				usage_project_id: "example-call-time-project",
				usage_frame_id: "example-call-time-frame",
				usage_feature_key: "document-generation",
			};
			const config = { configurable: { fabric_usage: fabricUsage } };
			const response = {
				usage_metadata: {
					input_tokens: 10,
					output_tokens: 2,
					total_tokens: 12,
					input_token_details: { cache_read: 3, cache_creation: 4 },
					output_token_details: { reasoning: 1 },
				},
				response_metadata: {
					gateway: { generationId: "example-call-time-generation" },
				},
			};
			const options = {
				model,
				taskType: "TOOL_CALLING",
				outputMessageId: queued ? outputMessageId : undefined,
				agentId: "example-call-time-agent",
				conversationId: "example-call-time-conversation",
				projectId: "example-options-project",
				latencyMs: 42,
			};
			const first = queued
				? logAgentUsageFromRunnableConfig(config, response, {
						...options,
						agentId: "example-blocker",
					})
				: Promise.resolve();
			const send = logAgentUsageFromRunnableConfig(
				config,
				response,
				options,
			);
			try {
				Object.assign(fabricUsage, {
					ai_token: "example-later-token",
					ai_provider: "ANTHROPIC_DIRECT",
					ai_model: "example-later-model",
					ai_billing_mode: "example-later-billing",
					ai_billing_customer_id: "example-later-customer",
					ai_plan_source: "org:example-later-account",
					project_id: "example-later-project",
					usage_conversation_id: "example-later-conversation",
					usage_project_id: "example-later-project",
					usage_frame_id: "example-later-frame",
					usage_feature_key: "clean-spec",
				});
				Object.assign(options, {
					model: {},
					taskType: "SIMPLE",
					agentId: "example-later-agent",
					conversationId: "example-later-conversation",
					projectId: "example-later-project",
					latencyMs: 99,
				});
				response.usage_metadata.input_tokens = 99;
				response.usage_metadata.output_tokens = 99;
				response.usage_metadata.total_tokens = 198;
				response.usage_metadata.input_token_details.cache_read = 99;
				response.usage_metadata.input_token_details.cache_creation = 99;
				response.usage_metadata.output_token_details.reasoning = 99;
				response.response_metadata.gateway.generationId =
					"example-later-generation";
				recordServedModel(model, {
					provider: "GROQ",
					model: "example-later-served-model",
				});
				vi.stubEnv("FABRIC_API_URL", "http://localhost:3001");
			} finally {
				releaseFirst();
				await Promise.all([first, send]);
			}
			expect(received.at(-1)).toEqual({
				url: "http://localhost:3000/api/internal/ai-usage",
				token: "example-call-time-token",
				body: {
					provider: "VERCEL_GATEWAY",
					model: "example-call-time-model",
					taskType: "TOOL_CALLING",
					...(queued ? { outputMessageId } : {}),
					agentId: "example-call-time-agent",
					conversationId: "example-call-time-conversation",
					projectId: "example-call-time-project",
					frameId: "example-call-time-frame",
					featureKey: "document-generation",
					latencyMs: 42,
					inputTokens: 10,
					outputTokens: 2,
					totalTokens: 12,
					cachedInputTokens: 3,
					cacheCreationInputTokens: 4,
					reasoningTokens: 1,
					gatewayGenerationId: "example-call-time-generation",
					billingMode: "example-call-time-billing",
					billingCustomerId: "example-call-time-customer",
					planSource: "org:example-configured-account",
				},
			});
		},
	);
});
