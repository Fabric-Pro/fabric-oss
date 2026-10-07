/**
 * The OpenAI, Groq and OpenAI-compatible (Cerebras) SDKs default
 * `strictJsonSchema` to true, and OpenAI-style strict mode refuses any schema
 * with an optional property (Fizzy #2985). `getModel` defaults the flag off
 * for structured-output calls under the namespace each route's SDK reads,
 * while keeping an explicit caller choice. The end-to-end cases capture the
 * body each route actually sends.
 */
import { generateObject, generateText, type LanguageModelMiddleware } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	createNonStrictJsonSchemaMiddleware,
	strictJsonSchemaNamespacesFor,
} from "../lib/non-strict-json-schema-middleware";

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
});

type LanguageModelV4CallOptions = Parameters<
	NonNullable<LanguageModelMiddleware["transformParams"]>
>[0]["params"];

const baseParams = {
	prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
} as unknown as LanguageModelV4CallOptions;

async function transform(
	params: LanguageModelV4CallOptions,
	provider = "OPENAI_DIRECT",
	viaGateway = false,
): Promise<LanguageModelV4CallOptions> {
	const middleware = createNonStrictJsonSchemaMiddleware(
		strictJsonSchemaNamespacesFor(provider, viaGateway),
	);
	if (!middleware.transformParams) {
		throw new Error("middleware has no transformParams");
	}
	return middleware.transformParams({
		params,
		type: "generate",
		model: {} as never,
	});
}

describe("createNonStrictJsonSchemaMiddleware", () => {
	it("defaults strictJsonSchema off for a JSON response format", async () => {
		const out = await transform({
			...baseParams,
			responseFormat: { type: "json", schema: { type: "object" } },
			providerOptions: { anthropic: { cacheControl: true } },
		});
		expect(out.providerOptions).toEqual({
			anthropic: { cacheControl: true },
			openai: { strictJsonSchema: false },
		});
	});

	it("keeps the caller's other openai options", async () => {
		const out = await transform({
			...baseParams,
			responseFormat: { type: "json" },
			providerOptions: { openai: { reasoningEffort: "low" } },
		});
		expect(out.providerOptions?.openai).toEqual({
			reasoningEffort: "low",
			strictJsonSchema: false,
		});
	});

	it.each([true, false])(
		"respects an explicit strictJsonSchema: %s",
		async (explicit) => {
			const params = {
				...baseParams,
				responseFormat: { type: "json" as const },
				providerOptions: { openai: { strictJsonSchema: explicit } },
			};
			const out = await transform(params);
			expect(out).toBe(params);
		},
	);

	it("keeps an explicit openaiCompatible choice on Cerebras, which merges it under cerebras", async () => {
		const params = {
			...baseParams,
			responseFormat: { type: "json" as const },
			providerOptions: { openaiCompatible: { strictJsonSchema: true } },
		};
		expect(await transform(params, "CEREBRAS")).toBe(params);
	});

	it("defaults only the gateway namespaces the caller left unset", async () => {
		const out = await transform(
			{
				...baseParams,
				responseFormat: { type: "json" },
				providerOptions: { groq: { strictJsonSchema: true } },
			},
			"VERCEL_GATEWAY",
			true,
		);
		expect(out.providerOptions).toEqual({
			openai: { strictJsonSchema: false },
			groq: { strictJsonSchema: true },
			cerebras: { strictJsonSchema: false },
		});
	});

	it.each(["ANTHROPIC_DIRECT", "DEEPSEEK"])(
		"adds nothing for %s, whose SDK sends no strict flag",
		async (provider) => {
			const params = {
				...baseParams,
				responseFormat: { type: "json" as const },
			};
			expect(await transform(params, provider)).toBe(params);
		},
	);

	it("is a no-op without a JSON response format", async () => {
		const text = await transform(baseParams);
		expect(text).toBe(baseParams);
		const explicitText = {
			...baseParams,
			responseFormat: { type: "text" as const },
		};
		expect(await transform(explicitText)).toBe(explicitText);
	});
});

describe("getModel sends non-strict structured output (Fizzy #2985)", () => {
	it("OpenAI direct (Responses API) sends strict: false", async () => {
		const body = await sentBody("gpt-6.1-sol", {
			apiKey: "example-openai-key",
			provider: "OPENAI_DIRECT",
		});
		expect(body).toHaveProperty("text.format.type", "json_schema");
		expect(body).toHaveProperty("text.format.strict", false);
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

	it.each(["VERCEL_GATEWAY", "OPENROUTER", "CLOUDFLARE_AI"])(
		"%s forwards strictJsonSchema: false to the gateway",
		async (provider) => {
			const body = await sentBody("openai/gpt-6.1-sol", {
				apiKey: "example-gateway-key",
				provider,
			});
			expect(body).toHaveProperty("responseFormat.type", "json");
			expect(body).toHaveProperty("providerOptions", {
				openai: { strictJsonSchema: false },
				groq: { strictJsonSchema: false },
				cerebras: { strictJsonSchema: false },
			});
		},
	);

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
