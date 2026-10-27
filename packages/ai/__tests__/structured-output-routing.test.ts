import { generateObject, generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The gateway routes send through undici's fetch; the direct providers use
// the global fetch. Both point at the same capture.
const { fetchMock } = vi.hoisted(() => {
	const fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return { fetchMock };
});

vi.mock("undici", async () => {
	const actual = await vi.importActual<typeof import("undici")>("undici");
	return { ...actual, fetch: fetchMock };
});

const schema = z.object({
	description: z.string(),
	acceptanceCriteria: z.string().optional(),
});

type Context = { apiKey: string; provider: string; baseUrl?: string };

async function sentBody(
	modelName: string,
	context: Context,
	providerOptions?: Record<string, Record<string, boolean>>,
): Promise<Record<string, unknown>> {
	let body: Record<string, unknown> | undefined;
	fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
		body = JSON.parse(String(init?.body));
		return new Response("stubbed", { status: 500 });
	});
	const { getModel } = await import("../model-factory");
	await generateObject({
		model: getModel(modelName, context),
		schema,
		prompt: "Draft a feature.",
		maxRetries: 0,
		...(providerOptions ? { providerOptions } : {}),
	}).catch(() => undefined);
	if (!body) {
		throw new Error("request was never sent");
	}
	return body;
}

afterEach(() => {
	fetchMock.mockReset();
	vi.restoreAllMocks();
});

describe("getModel structured-output routing", () => {
	it("OpenAI direct (Responses API) sends a converted strict schema", async () => {
		const body = await sentBody("gpt-6.1-sol", {
			apiKey: "example-openai-key",
			provider: "OPENAI_DIRECT",
		});
		expect(body).toHaveProperty("text.format.type", "json_schema");
		expect(body).toHaveProperty("text.format.strict", true);
	});

	it("an explicit strictJsonSchema: true still reaches OpenAI direct", async () => {
		const body = await sentBody(
			"gpt-6.1-sol",
			{ apiKey: "example-openai-key", provider: "OPENAI_DIRECT" },
			{ openai: { strictJsonSchema: true } },
		);
		expect(body).toHaveProperty("text.format.strict", true);
	});

	it("Groq sends strict: false", async () => {
		const body = await sentBody("llama-4-scout", {
			apiKey: "example-groq-key",
			provider: "GROQ",
		});
		expect(body).toHaveProperty("response_format.type", "json_schema");
		expect(body).toHaveProperty(
			"response_format.json_schema.strict",
			false,
		);
	});

	it("an explicit groq strictJsonSchema: true still reaches Groq", async () => {
		const body = await sentBody(
			"llama-4-scout",
			{ apiKey: "example-groq-key", provider: "GROQ" },
			{ groq: { strictJsonSchema: true } },
		);
		expect(body).toHaveProperty("response_format.json_schema.strict", true);
	});

	it("Cerebras sends strict: false", async () => {
		const body = await sentBody("gpt-oss-120b", {
			apiKey: "example-cerebras-key",
			provider: "CEREBRAS",
		});
		expect(body).toHaveProperty("response_format.type", "json_schema");
		expect(body).toHaveProperty(
			"response_format.json_schema.strict",
			false,
		);
	});

	it("an explicit openaiCompatible strictJsonSchema: true still reaches Cerebras", async () => {
		const body = await sentBody(
			"gpt-oss-120b",
			{ apiKey: "example-cerebras-key", provider: "CEREBRAS" },
			{ openaiCompatible: { strictJsonSchema: true } },
		);
		expect(body).toHaveProperty("response_format.json_schema.strict", true);
	});

	it.each(["VERCEL_GATEWAY"])(
		"%s forwards strict only for the confirmed OpenAI gateway upstream",
		async (provider) => {
			const body = await sentBody("openai/gpt-6.1-sol", {
				apiKey: "example-gateway-key",
				provider,
			});
			expect(body).toHaveProperty("responseFormat.type", "json");
			expect(body).toHaveProperty("providerOptions", {
				openai: { strictJsonSchema: true },
				groq: { strictJsonSchema: false },
				cerebras: { strictJsonSchema: false },
			});
		},
	);

	it.each(["OPENROUTER", "CLOUDFLARE_AI"])(
		"%s uses non-strict Chat Completions schema at its connection",
		async (provider) => {
			const body = await sentBody("openai/gpt-6.1-sol", {
				apiKey: "example-key",
				provider,
				baseUrl: "https://example.com/v1",
			});
			expect(body).toHaveProperty("response_format.type", "json_schema");
			expect(body).toHaveProperty(
				"response_format.json_schema.strict",
				false,
			);
			expect(body).not.toHaveProperty("providerOptions");
		},
	);

	it("gateway uses the sent OpenAI name for an unprefixed model", async () => {
		const body = await sentBody("gpt-6.1-sol", {
			apiKey: "example-gateway-key",
			provider: "VERCEL_GATEWAY",
		});
		expect(body).toHaveProperty(
			"providerOptions.openai.strictJsonSchema",
			true,
		);
		expect(body).toHaveProperty("responseFormat.schema.required", [
			"description",
			"acceptanceCriteria",
		]);
	});

	it("isolates identical Azure deployments on different resources through getModel", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const sent: { url: string; body: Record<string, any> }[] = [];
		fetchMock.mockImplementation(
			async (url: unknown, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				sent.push({ url: String(url), body });
				if (body.response_format.json_schema.strict) {
					return new Response(
						JSON.stringify({
							error: {
								message: "Invalid schema for response_format",
								type: "invalid_request_error",
							},
						}),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return new Response(
					JSON.stringify({
						id: "example",
						created: 1,
						model: "gpt-4o",
						object: "chat.completion",
						choices: [
							{
								index: 0,
								message: {
									role: "assistant",
									content: '{"description":"Example"}',
								},
								finish_reason: "stop",
							},
						],
						usage: {
							prompt_tokens: 1,
							completion_tokens: 1,
							total_tokens: 2,
						},
					}),
					{ headers: { "content-type": "application/json" } },
				);
			},
		);
		const { getModel } = await import("../model-factory");
		for (const baseUrl of [
			"https://example-a.openai.azure.com",
			"https://example-a.openai.azure.com",
			"https://example-b.openai.azure.com",
		]) {
			const result = await generateObject({
				model: getModel("gpt-4o", {
					apiKey: "example-azure-key",
					provider: "AZURE_AI_FOUNDRY",
					baseUrl,
				}),
				schema,
				prompt: "Example",
				maxRetries: 0,
			});
			expect(result.object).toEqual({ description: "Example" });
		}
		expect(
			sent.map(({ body }) => body.response_format.json_schema.strict),
		).toEqual([true, false, false, true, false]);
		expect(sent.map(({ url }) => new URL(url).hostname)).toEqual([
			"example-a.openai.azure.com",
			"example-a.openai.azure.com",
			"example-a.openai.azure.com",
			"example-b.openai.azure.com",
			"example-b.openai.azure.com",
		]);
	});

	it("leaves a plain text call on the gateway without provider options", async () => {
		let body: Record<string, unknown> | undefined;
		fetchMock.mockImplementation(
			async (_url: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				return new Response("stubbed", { status: 500 });
			},
		);
		const { getModel } = await import("../model-factory");
		await generateText({
			model: getModel("openai/gpt-6.1-sol", {
				apiKey: "example-gateway-key",
				provider: "VERCEL_GATEWAY",
			}),
			prompt: "hello",
			maxRetries: 0,
		}).catch(() => undefined);
		expect(body).toBeDefined();
		expect(body).not.toHaveProperty("providerOptions");
	});
});
