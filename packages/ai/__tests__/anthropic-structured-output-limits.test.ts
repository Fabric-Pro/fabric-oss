import type { LanguageModelMiddleware } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	countAnthropicSchemaParameters,
	createAnthropicStructuredOutputLimitsMiddleware,
} from "../lib/prompt-steered-structured-output-middleware";

const { fetchMock } = vi.hoisted(() => {
	const fetchMock = vi.fn();
	globalThis.fetch = fetchMock as unknown as typeof fetch;
	return { fetchMock };
});

// Gateway models use undici's transport rather than global fetch.
vi.mock("undici", async (importOriginal) => ({
	...(await importOriginal<typeof import("undici")>()),
	fetch: fetchMock,
}));

function schemaWith(optional: number, unions = 0) {
	const properties = Object.fromEntries(
		Array.from({ length: Math.max(optional, unions) }, (_, i) => [
			`field${i}`,
			i < unions ? { type: ["string", "null"] } : { type: "string" },
		]),
	);
	return {
		type: "object",
		properties,
		required: Object.keys(properties).slice(optional),
	};
}

const paramsFor = (schema: unknown) => ({
	prompt: [{ role: "system", content: "You summarize." }],
	responseFormat: {
		type: "json",
		schema,
		name: "Summary",
		description: "A summary",
	},
	maxOutputTokens: 1234,
	providerOptions: {
		anthropic: { thinking: { type: "adaptive" }, effort: "high" },
	},
});

async function transform(params: Record<string, unknown>) {
	return createAnthropicStructuredOutputLimitsMiddleware().transformParams?.({
		type: "generate",
		params: params as never,
		model: { modelId: "claude-sonnet-4-5" } as never,
	});
}

afterEach(() => {
	vi.restoreAllMocks();
	fetchMock.mockReset();
});

describe("countAnthropicSchemaParameters", () => {
	it.each([16, 17])(
		"counts nullable type arrays and anyOf equally at %i unions",
		async (unions) => {
			const compact = schemaWith(24, unions);
			const legacy = {
				...compact,
				properties: Object.fromEntries(
					Object.entries(compact.properties).map(([key, schema]) => [
						key,
						Array.isArray(schema.type)
							? { anyOf: schema.type.map((type) => ({ type })) }
							: schema,
					]),
				),
			};
			expect(countAnthropicSchemaParameters(compact)).toEqual({
				optionalParameters: 24,
				unionParameters: unions,
			});
			expect(countAnthropicSchemaParameters(legacy)).toEqual(
				countAnthropicSchemaParameters(compact),
			);
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			for (const schema of [compact, legacy]) {
				const params = paramsFor(schema);
				const out = await transform(params);
				expect(out?.responseFormat !== undefined).toBe(unions <= 16);
				if (unions <= 16) {
					expect(out).toBe(params);
				}
			}
			warn.mockRestore();
		},
	);

	it("counts properties through nested objects, tuples, branches and definitions", () => {
		const leaf = { properties: { value: { type: ["string", "null"] } } };
		expect(
			countAnthropicSchemaParameters({
				properties: {
					required: { type: "string" },
					nested: leaf,
					array: { items: leaf },
					tuple: { items: [leaf, leaf] },
					prefix: { prefixItems: [leaf] },
					choice: { anyOf: [leaf, { type: "null" }] },
					other: { oneOf: [leaf] },
					intersection: { allOf: [leaf] },
					map: { additionalProperties: leaf },
				},
				required: ["required"],
				$defs: { Leaf: leaf },
				definitions: { Legacy: leaf },
			}),
		).toEqual({ optionalParameters: 19, unionParameters: 13 });
	});

	it.each([
		{ $ref: "#/$defs/Leaf" },
		{ properties: { nested: { $ref: "#/definitions/Leaf" } } },
		{ if: { properties: { uncertain: {} } } },
		{ items: "invalid" },
	])("treats uncountable schemas as over limit: %j", (schema) => {
		expect(
			countAnthropicSchemaParameters(schema).optionalParameters,
		).toBeGreaterThan(24);
	});

	it("counts unions outside property schemas: root, array items and nested branches", () => {
		expect(
			countAnthropicSchemaParameters({
				anyOf: [
					{
						type: "object",
						properties: {
							list: {
								type: "array",
								items: {
									anyOf: [
										{ type: "string" },
										{ type: "number" },
									],
								},
							},
						},
						required: ["list"],
					},
					{ type: ["string", "null"] },
				],
			}),
		).toEqual({ optionalParameters: 0, unionParameters: 3 });
	});

	it("accepts boolean schemas without counting annotations as schemas", () => {
		expect(
			countAnthropicSchemaParameters({
				properties: { value: true },
				required: ["value"],
				additionalProperties: false,
				default: { $ref: "example" },
			}),
		).toEqual({ optionalParameters: 0, unionParameters: 0 });
	});
});

describe("direct Anthropic schema-limit middleware", () => {
	it("preserves native output at both inclusive limits", async () => {
		const params = paramsFor(schemaWith(24, 16));
		expect(await transform(params)).toBe(params);
	});

	it.each([
		[25, 0],
		[0, 17],
	])(
		"prompt-steers %i optional / %i union parameters",
		async (optional, unions) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const params = paramsFor(schemaWith(optional, unions));
			const out = await transform(params);
			expect(out).not.toHaveProperty("responseFormat");
			expect(out?.prompt[0]).toMatchObject({
				role: "system",
				content: expect.stringContaining(
					`JSON Schema:\n${JSON.stringify(params.responseFormat.schema)}`,
				),
			});
			expect(out?.prompt[0]).toHaveProperty(
				"content",
				expect.stringContaining("You summarize."),
			);
			expect(out?.providerOptions).toBe(params.providerOptions);
			expect(out?.maxOutputTokens).toBe(1234);
			expect(warn).toHaveBeenCalledOnce();
			expect(warn.mock.calls[0]?.[0]).toContain("claude-sonnet-4-5");
			expect(warn.mock.calls[0]?.[0]).toContain(`${optional} optional`);
			expect(warn.mock.calls[0]?.[0]).toContain(`${unions} union`);
		},
	);

	it("supports empty tools and inserts a missing system message", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const out = await transform({
			...paramsFor(schemaWith(25)),
			prompt: [],
			tools: [],
		});
		expect(out?.prompt[0]).toMatchObject({
			role: "system",
			content: expect.stringContaining("JSON Schema:"),
		});
		expect(out).not.toHaveProperty("responseFormat");
	});

	it("falls back for references whose counts are unknown", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(
			await transform(paramsFor({ $ref: "#/$defs/Leaf" })),
		).not.toHaveProperty("responseFormat");
	});

	it.each([
		{ tools: [{ type: "function", name: "lookup", inputSchema: {} }] },
		{ responseFormat: { type: "text" } },
		{ responseFormat: { type: "json" } },
		{ responseFormat: undefined },
	])(
		"passes through calls outside the fallback contract: %j",
		async (override) => {
			const params = { ...paramsFor(schemaWith(25)), ...override };
			expect(await transform(params)).toBe(params);
		},
	);
});

describe("getModel provider wiring", () => {
	it.each([
		["ANTHROPIC_DIRECT", "example-anthropic-key", true],
		["VERCEL_GATEWAY", "example-gateway-key", false],
		["ANTHROPIC_DIRECT", "vck_example-gateway-key", false],
	] as const)("%s with %s steers=%s", async (provider, apiKey, steered) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let body: Record<string, unknown> | undefined;
		const stop = new Error("captured request");
		fetchMock.mockImplementation(
			async (_url: unknown, init?: RequestInit) => {
				body = JSON.parse(String(init?.body));
				throw stop;
			},
		);
		const { getModel } = await import("../model-factory");
		const model = getModel("anthropic/claude-sonnet-4-5", {
			provider,
			apiKey,
		}) as Parameters<
			NonNullable<LanguageModelMiddleware["transformParams"]>
		>[0]["model"];
		await expect(
			model.doGenerate({
				...paramsFor(schemaWith(25)),
				prompt: [
					{ role: "system", content: "You summarize." },
					{
						role: "user",
						content: [{ type: "text", text: "Summarize" }],
					},
				],
			} as never),
		).rejects.toThrow();
		expect(body).toBeDefined();
		if (steered) {
			expect(body).not.toHaveProperty("output_config.format");
			expect(JSON.stringify(body?.system)).toContain("JSON Schema:");
		} else {
			expect(body).toHaveProperty("responseFormat.type", "json");
			expect(JSON.stringify(body?.prompt)).not.toContain("JSON Schema:");
		}
	});
});
