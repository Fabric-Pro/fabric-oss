import { embed, generateText, jsonSchema, streamText, tool } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => {
	const fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock };
});
vi.mock("undici", async () => ({
	...(await vi.importActual<typeof import("undici")>("undici")),
	fetch: fetchMock,
}));

import { getEmbeddingModel, getImageModel, getModel } from "../model-factory";

afterEach(() => fetchMock.mockReset());

const connections = [
	{
		provider: "OPENROUTER",
		apiKey: "sk-or-test",
		baseUrl: "https://example.com/openrouter/v1",
	},
	{
		provider: "CLOUDFLARE_AI",
		apiKey: "cloudflare-test-key",
		baseUrl: "https://example.com/cloudflare/openai",
	},
];

function capture() {
	const requests: {
		url: string;
		headers: Headers;
		body: Record<string, unknown>;
		dispatcher: unknown;
	}[] = [];
	fetchMock.mockImplementation(
		async (url: string, init: RequestInit & { dispatcher?: unknown }) => {
			requests.push({
				url: String(url),
				headers: new Headers(init.headers),
				body: JSON.parse(String(init.body)),
				dispatcher: init.dispatcher,
			});
			return Response.json(
				String(url).endsWith("/embeddings")
					? {
							data: [{ index: 0, embedding: [0.1, 0.2] }],
							usage: { prompt_tokens: 1, total_tokens: 1 },
						}
					: {
							id: "example-completion",
							created: 1,
							model: "example-model",
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: "hello",
									},
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 1,
								completion_tokens: 1,
								total_tokens: 2,
							},
						},
			);
		},
	);
	return requests;
}

describe.each(connections)("$provider connection routing", (connection) => {
	it("sends Chat Completions to the connection with its full model ID and no Vercel metadata", async () => {
		const requests = capture();
		const result = await generateText({
			model: getModel("google/gemini-4-argon", {
				...connection,
				headers: { "x-example-header": "example" },
				serviceTier: "flex",
			}),
			prompt: "hello",
			maxRetries: 0,
			providerOptions: {
				gateway: { order: ["google"], serviceTier: "flex" },
			},
		}).catch(() => undefined);
		expect(requests[0].url).toBe(`${connection.baseUrl}/chat/completions`);
		expect(requests[0].url).not.toContain("ai-gateway.vercel.sh");
		expect(requests[0].headers.get("authorization")).toBe(
			`Bearer ${connection.apiKey}`,
		);
		expect(requests[0].headers.get("x-example-header")).toBe("example");
		expect(requests[0].dispatcher).toBeDefined();
		expect(requests[0].body.model).toBe("google/gemini-4-argon");
		expect(requests[0].body).not.toHaveProperty("providerOptions");
		expect(requests[0].body).not.toHaveProperty("service_tier");
		expect(result?.text).toBe("hello");
		expect(result?.providerMetadata).not.toHaveProperty(
			"gateway.generationId",
		);
	});

	it.each(["openai/text-embedding-3-small", "text-embedding-3-small"])(
		"sends embeddings with unchanged model ID %s",
		async (modelId) => {
			const requests = capture();
			await embed({
				model: getEmbeddingModel(modelId, connection),
				value: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
			expect(requests[0].url).toBe(`${connection.baseUrl}/embeddings`);
			expect(requests[0].headers.get("authorization")).toBe(
				`Bearer ${connection.apiKey}`,
			);
			expect(requests[0].body.model).toBe(modelId);
		},
	);

	it("isolates cached clients by URL, key and headers", async () => {
		const requests = capture();
		const variants = [
			connection,
			{ ...connection, baseUrl: "https://example.com/other/v1" },
			{ ...connection, apiKey: "example-other-key" },
			{ ...connection, headers: { "x-example-header": "other" } },
		];
		for (const context of variants) {
			await embed({
				model: getEmbeddingModel(
					"openai/text-embedding-3-small",
					context,
				),
				value: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
		}
		for (const [index, context] of variants.entries()) {
			expect(requests[index].url).toBe(`${context.baseUrl}/embeddings`);
			expect(requests[index].headers.get("authorization")).toBe(
				`Bearer ${context.apiKey}`,
			);
		}
		expect(requests[3].headers.get("x-example-header")).toBe("other");
	});
});

it.each([getModel, getEmbeddingModel])(
	"Cloudflare requires a base URL (%#)",
	(factory) => {
		expect(() =>
			factory("openai/example-model", {
				provider: "CLOUDFLARE_AI",
				apiKey: "cloudflare-test-key",
			}),
		).toThrow("Cloudflare AI Gateway requires a base URL");
	},
);
it.each(["chat", "embedding"])(
	"OpenRouter defaults to its own endpoint for %s",
	async (kind) => {
		const requests = capture();
		const context = { provider: "OPENROUTER", apiKey: "sk-or-test" };
		if (kind === "chat") {
			await generateText({
				model: getModel("openai/gpt-4o", context),
				prompt: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
		} else {
			await embed({
				model: getEmbeddingModel(
					"openai/text-embedding-3-small",
					context,
				),
				value: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
		}
		expect(requests[0].url).toBe(
			`https://openrouter.ai/api/v1/${kind === "chat" ? "chat/completions" : "embeddings"}`,
		);
	},
);
it.each(["chat", "embedding"])(
	"Vercel retains its gateway transport for %s",
	async (kind) => {
		const requests = capture();
		const context = {
			provider: "VERCEL_GATEWAY",
			apiKey: "example-vercel-key",
		};
		if (kind === "chat") {
			await generateText({
				model: getModel("openai/gpt-4o", context),
				prompt: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
		} else {
			await embed({
				model: getEmbeddingModel("text-embedding-3-small", context),
				value: "hello",
				maxRetries: 0,
			}).catch(() => undefined);
		}
		expect(requests[0].url).toContain("https://ai-gateway.vercel.sh/");
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer example-vercel-key",
		);
		expect(
			requests[0].headers.get(
				kind === "chat" ? "ai-language-model-id" : "ai-model-id",
			),
		).toBe(
			kind === "chat" ? "openai/gpt-4o" : "openai/text-embedding-3-small",
		);
	},
);

it.each(["OPENROUTER", "CLOUDFLARE_AI"])(
	"getImageModel refuses unsupported %s image protocols",
	(provider) => {
		expect(() =>
			getImageModel("openai/dall-e-3", {
				provider,
				apiKey: "example-key",
			}),
		).toThrow(
			`Image generation through getImageModel is not supported for ${provider}`,
		);
	},
);

describe.each(["OPENROUTER", "CLOUDFLARE_AI"])(
	"Vercel key stored under %s",
	(provider) => {
		it.each(["chat", "embedding"])(
			"reroutes %s before compatible endpoint resolution",
			async (kind) => {
				const requests = capture();
				const context = { provider, apiKey: "vck_example_key" };
				if (kind === "chat") {
					await generateText({
						model: getModel("openai/gpt-4o", context),
						prompt: "hello",
						maxRetries: 0,
					}).catch(() => undefined);
				} else {
					await embed({
						model: getEmbeddingModel(
							"text-embedding-3-small",
							context,
						),
						value: "hello",
						maxRetries: 0,
					}).catch(() => undefined);
				}
				expect(requests[0].url).toContain(
					"https://ai-gateway.vercel.sh/",
				);
				expect(requests[0].headers.get("authorization")).toBe(
					"Bearer vck_example_key",
				);
				expect(
					requests[0].headers.get(
						kind === "chat"
							? "ai-language-model-id"
							: "ai-model-id",
					),
				).toBe(
					kind === "chat"
						? "openai/gpt-4o"
						: "openai/text-embedding-3-small",
				);
			},
		);
		it("accepts the Vercel key for the OpenAI-compatible image helper", () => {
			expect(() =>
				getImageModel("openai/dall-e-3", {
					provider,
					apiKey: "vck_example_key",
				}),
			).not.toThrow();
		});
	},
);

describe("Databricks canonical prompt caching", () => {
	it.each([
		["custom-chat", "claude-sonnet-5", true],
		["custom-chat", "llama-3-3-70b", false],
		["claude-alias", "llama-3-3-70b", false],
		["claude-alias", undefined, true],
		["custom-chat", undefined, false],
	])(
		"%s backed by %s caches: %s",
		async (endpoint, canonicalModelName, expected) => {
			const requests: Record<string, unknown>[] = [];
			fetchMock.mockImplementation(async (_url, init) => {
				requests.push(JSON.parse(String(init?.body)));
				return Response.json({
					id: "example",
					created: 1,
					model: endpoint,
					choices: [
						{
							index: 0,
							message: { role: "assistant", content: "hello" },
							finish_reason: "stop",
						},
					],
					usage: {
						prompt_tokens: 1,
						completion_tokens: 1,
						total_tokens: 2,
					},
				});
			});
			try {
				await generateText({
					model: getModel(endpoint, {
						provider: "DATABRICKS",
						apiKey: "example-key",
						baseUrl: "https://example.com",
						canonicalModelName,
					}),
					system: "Stable instructions",
					prompt: "Hello",
					maxRetries: 0,
				});
				expect(requests).toHaveLength(1);
				expect(
					JSON.stringify(requests[0]).includes('"cache_control"'),
				).toBe(expected);
			} finally {
				fetchMock.mockReset();
			}
		},
	);
});

describe.each(["OPENROUTER", "DATABRICKS"])(
	"%s text call recovery wiring",
	(provider) => {
		it.each([false, true])(
			"recovers text calls with streaming=%s through the real factory",
			async (streaming) => {
				const text =
					'Fetching. <function=example_lookup>{"feature":"F-019"}</function>';
				fetchMock.mockImplementation(async () => {
					if (!streaming) {
						return Response.json({
							id: "example",
							created: 1,
							model: "example-model",
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: text,
									},
									finish_reason: "stop",
								},
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 5,
								total_tokens: 15,
							},
						});
					}
					const payloads = [
						{
							choices: [
								{
									index: 0,
									delta: { role: "assistant", content: text },
									finish_reason: null,
								},
							],
						},
						{
							choices: [
								{ index: 0, delta: {}, finish_reason: "stop" },
							],
							usage: {
								prompt_tokens: 10,
								completion_tokens: 5,
								total_tokens: 15,
							},
						},
					];
					return new Response(
						`${payloads
							.map(
								(payload) =>
									`data: ${JSON.stringify({ id: "example", created: 1, model: "example-model", ...payload })}\n\n`,
							)
							.join("")}data: [DONE]\n\n`,
						{ headers: { "content-type": "text/event-stream" } },
					);
				});
				const options = {
					model: getModel("example-model", {
						provider,
						apiKey: "example-key",
						baseUrl: "https://example.com/v1",
					}),
					prompt: "Fetch a feature",
					tools: {
						example_lookup: tool({
							inputSchema: jsonSchema<{ feature: string }>({
								type: "object",
								properties: { feature: { type: "string" } },
								required: ["feature"],
							}),
						}),
					},
					maxRetries: 0,
				};
				if (!streaming) {
					const result = await generateText(options);
					expect(result.text).toBe("Fetching. ");
					expect(result.toolCalls).toMatchObject([
						{
							toolName: "example_lookup",
							input: { feature: "F-019" },
						},
					]);
					expect(result.finishReason).toBe("tool-calls");
				} else {
					const result = streamText(options);
					let shown = "";
					for await (const part of result.stream) {
						if (part.type === "text-delta") {
							shown += part.text;
						}
					}
					expect(shown).toBe("Fetching. ");
					expect(await result.toolCalls).toMatchObject([
						{
							toolName: "example_lookup",
							input: { feature: "F-019" },
						},
					]);
					expect(await result.finishReason).toBe("tool-calls");
				}
			},
		);
	},
);
