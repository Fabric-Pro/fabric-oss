import { describe, expect, it } from "vitest";
import {
	ANTHROPIC_EPHEMERAL_CACHE,
	cacheableSystem,
	isPromptCacheTarget,
	supportsAnthropicMidConversationSystem,
	withRollingCacheBreakpoint,
} from "../prompt-cache";

describe("isPromptCacheTarget", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-sonnet-4-5", true],
		["ANTHROPIC_DIRECT", "custom-model-alias", true],
		["VERCEL_GATEWAY", "claude-sonnet-4-5", true],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-4-5", true],
		["VERCEL_GATEWAY", "openai/gpt-5", false],
		["AWS_BEDROCK", "anthropic.claude-sonnet-4-5-v1:0", false],
		["OPENROUTER", "anthropic/claude-sonnet-4-5", false],
	])("targets %s / %s: %s", (provider, modelString, expected) => {
		expect(isPromptCacheTarget(provider, modelString)).toBe(expected);
	});
});

describe("supportsAnthropicMidConversationSystem", () => {
	it.each([
		["ANTHROPIC_DIRECT", "claude-fable-5-1", true],
		["ANTHROPIC_DIRECT", "claude-mythos-5-20260901", true],
		["ANTHROPIC_DIRECT", "claude-opus-4-8", true],
		["ANTHROPIC_DIRECT", "claude-opus-5-20260901", true],
		["VERCEL_GATEWAY", "anthropic/claude-fable-5-1", true],
		["VERCEL_GATEWAY", "anthropic/claude-mythos-5", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-4.8", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-4-8", true],
		["VERCEL_GATEWAY", "anthropic/claude-opus-5", true],
		["ANTHROPIC_DIRECT", "claude-sonnet-5", false],
		["ANTHROPIC_DIRECT", "claude-sonnet-4-5", false],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-5", false],
		["VERCEL_GATEWAY", "anthropic/claude-sonnet-4-5", false],
		["ANTHROPIC_DIRECT", "production-claude-alias", false],
		["VERCEL_GATEWAY", "claude-opus-4-8", false],
		["OPENROUTER", "anthropic/claude-opus-4-8", false],
	])("reports %s / %s: %s", (provider, modelString, expected) => {
		expect(
			supportsAnthropicMidConversationSystem(provider, modelString),
		).toBe(expected);
	});
});

describe("cacheableSystem", () => {
	it("wraps content in a system message with the ephemeral cache marker", () => {
		const msg = cacheableSystem("you are a helpful auditor");
		expect(msg).toEqual({
			role: "system",
			content: "you are a helpful auditor",
			providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
		});
	});

	it("marker is the additive anthropic ephemeral breakpoint", () => {
		expect(ANTHROPIC_EPHEMERAL_CACHE).toEqual({
			anthropic: { cacheControl: { type: "ephemeral" } },
		});
	});
});

describe("withRollingCacheBreakpoint", () => {
	it("marks only the last message", () => {
		const out = withRollingCacheBreakpoint([
			{ role: "user", content: "a" },
			{ role: "assistant", content: "b" },
			{ role: "user", content: "c" },
		]) as any[];
		expect(out[0].providerOptions).toBeUndefined();
		expect(out[1].providerOptions).toBeUndefined();
		expect(out[2].providerOptions).toEqual(ANTHROPIC_EPHEMERAL_CACHE);
	});

	it("does not mutate the input array or its messages", () => {
		const input = [
			{ role: "user", content: "a" },
			{ role: "user", content: "b" },
		];
		const out = withRollingCacheBreakpoint(input) as any[];
		expect(input[1]).not.toHaveProperty("providerOptions");
		expect(out).not.toBe(input);
	});

	it("returns a copy for empty input without throwing", () => {
		const input: unknown[] = [];
		const out = withRollingCacheBreakpoint(input);
		expect(out).toEqual([]);
		expect(out).not.toBe(input);
	});

	it("leaves a non-object last element untouched", () => {
		const out = withRollingCacheBreakpoint(["a", "b"]) as unknown[];
		expect(out).toEqual(["a", "b"]);
	});
});

it("Advisor removes inherited option markers while retaining tool inputs named cacheControl", async () => {
	const { withAdvisorCacheBreakpoints } = await import("../prompt-cache");
	const { createRequestFingerprint } = await import("../request-observation");
	const history: import("ai").ModelMessage[] = [
		{
			role: "user",
			content: "example",
			providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "example",
					toolName: "example",
					input: {
						cacheControl: "retain this argument",
						cache_control: "also data",
					},
					providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "example",
					toolName: "example",
					output: { type: "text", value: "example" },
					providerOptions: ANTHROPIC_EPHEMERAL_CACHE,
				},
			],
		},
	];
	const before = structuredClone(history);
	const messages = withAdvisorCacheBreakpoints(history, 0);
	expect(messages[1]).toMatchObject({
		content: [
			{
				input: {
					cacheControl: "retain this argument",
					cache_control: "also data",
				},
			},
		],
	});
	expect(history).toEqual(before);
	expect(
		createRequestFingerprint({
			modelId: "example",
			route: "example",
			prompt: [cacheableSystem("example"), ...messages],
		}).cacheMarkers,
	).toEqual([
		[1, 0],
		[1, 1],
		[1, 3],
	]);
});

it.each(["direct", "gateway"] as const)(
	"serializes Advisor system and history markers through the installed %s adapter",
	async (route) => {
		const { createAnthropic } = await import("@ai-sdk/anthropic");
		const { createGateway, generateText } = await import("ai");
		const { withAdvisorCacheBreakpoints } = await import("../prompt-cache");
		const { createRequestFingerprint } = await import(
			"../request-observation"
		);
		let body: Record<string, unknown> = {};
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return Response.json(
				route === "direct"
					? {
							id: "example-message",
							type: "message",
							role: "assistant",
							model: "claude-sonnet-4-5",
							content: [{ type: "text", text: "Example answer" }],
							stop_reason: "end_turn",
							stop_sequence: null,
							usage: {
								input_tokens: 10,
								output_tokens: 2,
								cache_read_input_tokens: 100,
								cache_creation_input_tokens: 0,
							},
						}
					: {
							content: [{ type: "text", text: "Example answer" }],
							finishReason: { unified: "stop", raw: "stop" },
							usage: {
								inputTokens: {
									total: 110,
									noCache: 10,
									cacheRead: 100,
									cacheWrite: 0,
								},
								outputTokens: {
									total: 2,
									text: 2,
									reasoning: 0,
								},
							},
							warnings: [],
						},
			);
		};
		const model =
			route === "direct"
				? createAnthropic({
						apiKey: "example-key",
						baseURL: "https://example.com",
						fetch,
					})("claude-sonnet-4-5")
				: createGateway({
						apiKey: "example-key",
						baseURL: "https://example.com",
						fetch,
					})("anthropic/claude-sonnet-4-5");
		const messages: import("ai").ModelMessage[] =
			withAdvisorCacheBreakpoints(
				[
					{ role: "user", content: "Example request" },
					{
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "example",
								toolName: "example",
								input: {},
							},
						],
					},
					{
						role: "tool",
						content: [
							{
								type: "tool-result",
								toolCallId: "example",
								toolName: "example",
								output: {
									type: "text",
									value: "Example finding",
								},
							},
						],
					},
				],
				0,
			);
		messages.push({ role: "user", content: "Example host note" });
		await generateText({
			model,
			instructions: cacheableSystem("Example stable instructions"),
			messages,
			maxRetries: 0,
		});
		if (route === "gateway") {
			expect(
				createRequestFingerprint({
					modelId: "example",
					route,
					prompt: body.prompt,
				}).cacheMarkers,
			).toEqual([
				[1, 0],
				[1, 1],
				[1, 3],
			]);
		} else {
			const system = body.system as Array<Record<string, unknown>>;
			expect(system[0]).toMatchObject({
				type: "text",
				text: "Example stable instructions",
				cache_control: { type: "ephemeral" },
			});
			const sent = body.messages as Array<{
				content: Array<Record<string, unknown>>;
			}>;
			const positions = sent.flatMap((message, index) =>
				message.content.flatMap((part, partIndex) =>
					part.cache_control ? [[index, partIndex]] : [],
				),
			);
			expect(positions).toEqual([
				[0, 0],
				[2, 0],
			]);
			expect(sent.at(-1)?.content.at(-1)).toMatchObject({
				type: "text",
				text: "Example host note",
			});
			expect(sent.at(-1)?.content.at(-1)).not.toHaveProperty(
				"cache_control",
			);
		}
	},
);
