import { readFileSync } from "node:fs";
import {
	generateObject,
	generateText,
	Output,
	wrapLanguageModel,
	zodSchema,
} from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	createStrictJsonSchemaMiddleware,
	toStrictJsonSchema,
} from "../lib/strict-json-schema-middleware";
import {
	STRUCTURED_OUTPUT_CAPABILITIES,
	structuredOutputCapabilityFor,
} from "../lib/structured-output-capabilities";

const capability = structuredOutputCapabilityFor(
	"OPENAI_DIRECT",
	false,
	"gpt-6.1-sol",
);
const simple = z.object({ title: z.string(), note: z.string().optional() });
const json = async (schema: z.ZodType) => await zodSchema(schema).jsonSchema;
const mock = (text: string) =>
	new MockLanguageModelV4({
		doGenerate: {
			content: [{ type: "text", text }],
			finishReason: { unified: "stop", raw: "stop" },
			usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
			warnings: [],
		},
	});
const wrapped = (model: MockLanguageModelV4, provider = "OPENAI_DIRECT") =>
	wrapLanguageModel({
		model,
		middleware: createStrictJsonSchemaMiddleware(
			structuredOutputCapabilityFor(provider, false, model.modelId),
		),
	});

describe("conversion from the AI SDK's real Zod JSON schemas", () => {
	it("requires optional strings as nullable without mutating the original", async () => {
		const original = await json(simple);
		const snapshot = structuredClone(original);
		expect(toStrictJsonSchema(original)).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["title", "note"],
			properties: {
				note: { anyOf: [{ type: "string" }, { type: "null" }] },
			},
		});
		expect(original).toEqual(snapshot);
	});

	it("recurses through optional nested objects and arrays", async () => {
		const schema = z.object({
			meta: z.object({ note: z.string().optional() }).optional(),
			rows: z.array(z.object({ label: z.string().optional() })),
		});
		const converted = toStrictJsonSchema(await json(schema));
		expect(converted).toHaveProperty("properties.meta.anyOf.0.required", [
			"note",
		]);
		expect(converted).toHaveProperty("properties.rows.items.required", [
			"label",
		]);
		expect(converted).toHaveProperty(
			"properties.rows.items.additionalProperties",
			false,
		);
	});

	it("retains already nullable optional fields", async () => {
		expect(
			toStrictJsonSchema(
				await json(
					z.object({ note: z.string().nullable().optional() }),
				),
			),
		).toHaveProperty("properties.note", {
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("normalizes disjoint discriminated unions and their optional fields", async () => {
		const schema = z.object({
			choice: z.discriminatedUnion("kind", [
				z.object({ kind: z.literal("a"), note: z.string().optional() }),
				z.object({
					kind: z.literal("b"),
					note: z.string().nullable().optional(),
				}),
			]),
		});
		const converted = toStrictJsonSchema(await json(schema));
		expect(converted).toHaveProperty("properties.choice.anyOf.0.required", [
			"kind",
			"note",
		]);
		expect(converted).not.toHaveProperty("properties.choice.oneOf");
	});

	it("handles refs, definitions, anyOf, enum and const without losing constraints", () => {
		const converted = toStrictJsonSchema({
			type: "object",
			properties: {
				ref: { $ref: "#/$defs/entry" },
				kind: { type: "string", enum: ["a", "b"] },
				literal: { const: "example" },
			},
			$defs: {
				entry: {
					type: "object",
					properties: { note: { type: "string" } },
				},
			},
		});
		expect(converted).toHaveProperty("properties.ref.anyOf", [
			{ $ref: "#/$defs/entry" },
			{ type: "null" },
		]);
		expect(converted).toHaveProperty("$defs.entry.required", ["note"]);
		expect(converted).toHaveProperty("properties.kind.anyOf.0.enum", [
			"a",
			"b",
		]);
		expect(converted).toHaveProperty(
			"properties.literal.anyOf.0.const",
			"example",
		);
		expect(
			toStrictJsonSchema({
				type: "object",
				properties: { ref: { $ref: "#/definitions/entry" } },
				definitions: {
					entry: { type: ["string", "null"], enum: ["a", null] },
				},
			}),
		).toHaveProperty("properties.ref", { $ref: "#/definitions/entry" });
	});

	it.each([
		["record", z.object({ data: z.record(z.string(), z.string()) })],
		["unconstrained", z.object({ data: z.unknown() })],
	] as const)("falls back without rewriting %s", async (_name, schema) => {
		expect(toStrictJsonSchema(await json(schema))).toBeUndefined();
	});

	it.each([
		["default", z.object({ note: z.string().default("example") })],
		["string bounds", z.object({ note: z.string().min(1).max(8) })],
		["number bounds", z.object({ score: z.number().min(0).max(10) })],
		["array bounds", z.object({ rows: z.array(z.string()).min(1).max(3) })],
	] as const)("enforces structure despite %s", async (_name, schema) => {
		const converted = toStrictJsonSchema(await json(schema));
		expect(converted).toBeDefined();
		expect(converted).toMatchObject({
			type: "object",
			additionalProperties: false,
		});
	});
	it("strips unsupported annotations and retains descriptions", () => {
		expect(
			toStrictJsonSchema({
				type: "object",
				title: "Example",
				$schema: "example",
				properties: {
					note: {
						type: "string",
						default: "example",
						examples: ["example"],
						format: "uri",
						description: "Example note",
					},
				},
				required: ["note"],
			}),
		).toEqual({
			type: "object",
			properties: {
				note: { type: "string", description: "Example note" },
			},
			required: ["note"],
			additionalProperties: false,
		});
	});

	it.each([
		{ additionalProperties: true },
		{ additionalProperties: { type: "string" } },
		{ propertyNames: { type: "string" } },
		{ patternProperties: { ".*": { type: "string" } } },
		{
			if: { type: "string" },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword under test.
			then: { type: "string" },
			else: { type: "object" },
		},
		{ not: { type: "null" } },
		{ newUnsupportedKeyword: true },
		{ allOf: [{ type: "object" }, { type: "object" }] },
		{ oneOf: [{ type: "string" }, { type: "number" }] },
	])("rejects unsupported schema keywords %j", (extra) => {
		expect(
			toStrictJsonSchema({ type: "object", properties: {}, ...extra }),
		).toBeUndefined();
	});
	it("refuses a non-object root, unresolved refs and external refs", () => {
		for (const schema of [
			{ type: "array", items: { type: "string" } },
			{ type: "string" },
			{ type: "object", properties: { data: { $ref: "#/missing" } } },
			{
				type: "object",
				properties: { data: { $ref: "https://example.com/schema" } },
			},
		]) {
			expect(toStrictJsonSchema(schema)).toBeUndefined();
		}
	});
	it("preserves descriptions", async () => {
		expect(
			toStrictJsonSchema(
				await json(
					z.object({
						note: z.string().describe("Example note").optional(),
					}),
				),
			),
		).toHaveProperty("properties.note.anyOf.0.description", "Example note");
	});
});

describe("request policy", () => {
	const transform = async (
		options: {
			provider?: string;
			viaGateway?: boolean;
			type?: "generate" | "stream";
			providerOptions?: Record<string, Record<string, boolean | string>>;
			schema?: unknown;
		} = {},
	) => {
		const middleware = createStrictJsonSchemaMiddleware(
			structuredOutputCapabilityFor(
				options.provider ?? "OPENAI_DIRECT",
				options.viaGateway ?? false,
				"openai/gpt-6.1-sol",
			),
		);
		const params = {
			prompt: [],
			responseFormat: {
				type: "json" as const,
				schema: (options.schema ?? (await json(simple))) as never,
			},
			providerOptions: options.providerOptions,
		};
		return {
			params,
			out: await middleware.transformParams?.({
				params,
				type: options.type ?? "generate",
				model: mock(""),
			}),
		};
	};
	it.each([false, true])(
		"respects explicit strictJsonSchema %s without converting",
		async (value) => {
			const { params, out } = await transform({
				providerOptions: { openai: { strictJsonSchema: value } },
			});
			expect(out).toBe(params);
		},
	);
	it.each(["openai-compatible", "openaiCompatible", "cerebras"])(
		"respects Cerebras alias %s",
		async (alias) => {
			const { params, out } = await transform({
				provider: "CEREBRAS",
				providerOptions: { [alias]: { strictJsonSchema: true } },
			});
			expect(out).toBe(params);
		},
	);
	it("keeps streams non-strict and preserves options", async () => {
		const { params, out } = await transform({
			type: "stream",
			providerOptions: { openai: { reasoningEffort: "low" } },
		});
		expect(out?.responseFormat).toBe(params.responseFormat);
		expect(out?.providerOptions?.openai).toEqual({
			reasoningEffort: "low",
			strictJsonSchema: false,
		});
	});
	it("keeps unsupported schemas unchanged and defaults false", async () => {
		const { params, out } = await transform({
			schema: await json(
				z.object({ data: z.record(z.string(), z.string()) }),
			),
		});
		expect(out?.responseFormat).toBe(params.responseFormat);
		expect(out?.providerOptions?.openai?.strictJsonSchema).toBe(false);
	});
	it("does not convert a gateway call with an explicit upstream choice", async () => {
		const { params, out } = await transform({
			viaGateway: true,
			providerOptions: { groq: { strictJsonSchema: false } },
		});
		expect(out?.responseFormat).toBe(params.responseFormat);
		expect(out?.providerOptions?.openai?.strictJsonSchema).toBe(false);
	});
	it("does nothing after prompt-steered middleware removes responseFormat", async () => {
		const middleware = createStrictJsonSchemaMiddleware(capability);
		const params = { prompt: [] };
		expect(
			await middleware.transformParams?.({
				params,
				type: "generate",
				model: mock(""),
			}),
		).toBe(params);
	});
});

describe("reply repair before AI SDK validation", () => {
	it("repairs optional nulls before Output.object validates the answer", async () => {
		const model = mock('{"title":"Example","note":null}');
		const result = await generateText({
			model: wrapped(model),
			output: Output.object({ schema: simple }),
			prompt: "Draft an example.",
			maxRetries: 0,
		});
		expect(result.output).toEqual({ title: "Example" });
		expect(result.output).not.toHaveProperty("note");
		expect(
			model.doGenerateCalls[0]?.providerOptions?.openai?.strictJsonSchema,
		).toBe(true);
	});
	it("repairs nested objects, arrays and keeps original nullable nulls", async () => {
		const schema = z.object({
			meta: z.object({ note: z.string().optional() }).optional(),
			rows: z.array(z.object({ note: z.string().optional() })),
			nullable: z.string().nullable().optional(),
			missing: z.object({ note: z.string() }).optional(),
		});
		const result = await generateObject({
			model: wrapped(
				mock(
					'{"meta":{"note":null},"rows":[{"note":null}],"nullable":null,"missing":null}',
				),
			),
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ meta: {}, rows: [{}], nullable: null });
	});
	it("repairs Output.array's object envelope", async () => {
		const result = await generateText({
			model: wrapped(
				mock('{"elements":[{"title":"Example","note":null}]}'),
			),
			output: Output.array({ element: simple }),
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.output).toEqual([{ title: "Example" }]);
	});
	it.each(["a", "b"])(
		"selects discriminated-union branch %s",
		async (kind) => {
			const schema = z.object({
				choice: z.discriminatedUnion("kind", [
					z.object({
						kind: z.literal("a"),
						note: z.string().optional(),
					}),
					z.object({
						kind: z.literal("b"),
						note: z.string().nullable().optional(),
					}),
				]),
			});
			const result = await generateObject({
				model: wrapped(
					mock(JSON.stringify({ choice: { kind, note: null } })),
				),
				schema,
				prompt: "Example",
				maxRetries: 0,
			});
			expect(result.object).toEqual({
				choice: kind === "a" ? { kind } : { kind, note: null },
			});
		},
	);
	it("leaves invalid JSON and required nulls for the SDK's error path", async () => {
		for (const text of ["not JSON", '{"title":null,"note":null}']) {
			await expect(
				generateText({
					model: wrapped(mock(text)),
					output: Output.object({ schema: simple }),
					prompt: "Example",
					maxRetries: 0,
				}),
			).rejects.toThrow();
		}
	});
	it("does not repair explicit opt-outs or unsupported schemas", async () => {
		await expect(
			generateObject({
				model: wrapped(mock('{"title":"Example","note":null}')),
				schema: simple,
				prompt: "Example",
				providerOptions: { openai: { strictJsonSchema: false } },
				maxRetries: 0,
			}),
		).rejects.toThrow();
		await expect(
			generateObject({
				model: wrapped(mock('{"note":null}')),
				schema: z.object({
					note: z.string().optional(),
					data: z.record(z.string(), z.string()).optional(),
				}),
				prompt: "Example",
				maxRetries: 0,
			}),
		).rejects.toThrow();
	});
	it("repairs defaulted nulls but still rejects violations of the original bounds", async () => {
		const schema = z.object({
			note: z.string().min(3).max(8).default("example"),
		});
		const result = await generateObject({
			model: wrapped(mock('{"note":null}')),
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ note: "example" });
		await expect(
			generateObject({
				model: wrapped(mock('{"note":"x"}')),
				schema,
				prompt: "Example",
				maxRetries: 0,
			}),
		).rejects.toThrow();
	});

	it("concatenates split text while preserving other content and metadata", async () => {
		const model = mock("");
		model.doGenerate = async () => ({
			content: [
				{
					type: "text",
					text: '{"title":"Example",',
					providerMetadata: { example: { part: 1 } },
				},
				{ type: "reasoning", text: "Example reasoning" },
				{ type: "text", text: '"note":null}' },
			],
			finishReason: { unified: "stop", raw: "stop" },
			usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
			warnings: [],
		});
		const result = await wrapped(model).doGenerate({
			prompt: [],
			responseFormat: { type: "json", schema: await json(simple) },
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: '{"title":"Example"}',
				providerMetadata: { example: { part: 1 } },
			},
			{ type: "reasoning", text: "Example reasoning" },
			{ type: "text", text: "" },
		]);
	});
	it("repairs recursive refs from a real Zod schema", async () => {
		const node: z.ZodType = z.lazy(() =>
			z.object({
				label: z.string().optional(),
				children: z.array(node).optional(),
			}),
		);
		const schema = z.object({ node });
		const original = await json(schema);
		expect(toStrictJsonSchema(original)).toBeDefined();
		const result = await generateObject({
			model: wrapped(
				mock(
					'{"node":{"label":null,"children":[{"label":null,"children":null}]}}',
				),
			),
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ node: { children: [{}] } });
	});
	it("preserves null when ambiguous union branches disagree", async () => {
		const schema = z.object({
			choice: z.union([
				z.object({ note: z.string().optional() }),
				z.object({ note: z.string().nullable().optional() }),
			]),
		});
		const result = await generateObject({
			model: wrapped(mock('{"choice":{"note":null}}')),
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ choice: { note: null } });
	});
	it("keeps enum and const nullability distinct from optionality", async () => {
		const schema = z.object({
			kind: z.enum(["a", "b"]).optional(),
			literal: z.literal("example").optional(),
			nullable: z.enum(["a", "b"]).nullable().optional(),
		});
		const result = await generateObject({
			model: wrapped(
				mock('{"kind":null,"literal":null,"nullable":null}'),
			),
			schema,
			prompt: "Example",
			maxRetries: 0,
		});
		expect(result.object).toEqual({ nullable: null });
	});
	it("isolates concurrent requests on the same middleware", async () => {
		const middleware = createStrictJsonSchemaMiddleware(capability);
		const model = wrapLanguageModel({
			model: mock('{"note":null}'),
			middleware,
		});
		const [optional, nullable] = await Promise.all(
			[
				z.object({ note: z.string().optional() }),
				z.object({ note: z.string().nullable().optional() }),
			].map((schema) =>
				generateObject({
					model,
					schema,
					prompt: "Example",
					maxRetries: 0,
				}),
			),
		);
		expect(optional?.object).toEqual({});
		expect(nullable?.object).toEqual({ note: null });
	});
});

describe("capability table", () => {
	it("explicitly covers the current Prisma enum", () => {
		const prisma = readFileSync(
			new URL("../../database/prisma/schema.prisma", import.meta.url),
			"utf8",
		);
		const block =
			prisma.match(/enum AIProvider \{([\s\S]*?)\n\}/)?.[1] ?? "";
		const names = block
			.split("\n")
			.map((line) => line.replace(/\/\/.*$/, "").trim())
			.filter(Boolean);
		expect(Object.keys(STRUCTURED_OUTPUT_CAPABILITIES).sort()).toEqual(
			names.sort(),
		);
	});
	it.each(Object.entries(STRUCTURED_OUTPUT_CAPABILITIES))(
		"%s uses its explicit route decision",
		(provider, row) => {
			const expected =
				provider === "ANTHROPIC_DIRECT"
					? "native"
					: [
								"DATABRICKS",
								"GROQ",
								"CEREBRAS",
								"DEEPSEEK",
								"OPENAI_CHATGPT_PLAN",
								"VERCEL_GATEWAY",
								"OPENROUTER",
								"CLOUDFLARE_AI",
							].includes(provider)
						? "non-strict"
						: "strict";
			expect(
				structuredOutputCapabilityFor(provider, false, "example").mode,
			).toBe(expected);
			expect(row.evidence.length).toBeGreaterThan(20);
		},
	);
	it.each([
		"VERCEL_GATEWAY",
		"OPENROUTER",
		"CLOUDFLARE_AI",
		"AWS_BEDROCK",
		"GOOGLE_VERTEX_AI",
		undefined,
	])("%s gateway overrides depend on upstream model", (provider) => {
		expect(
			structuredOutputCapabilityFor(provider, true, "openai/gpt-6.1-sol")
				.mode,
		).toBe("strict");
		for (const name of [
			"groq/llama",
			"anthropic/claude",
			"google/gemini",
			"bedrock/example",
			"example",
		]) {
			expect(
				structuredOutputCapabilityFor(provider, true, name).mode,
			).toBe("non-strict");
		}
	});
	it("records the unknown-provider OpenAI fallback", () => {
		expect(
			structuredOutputCapabilityFor("EXAMPLE_UNKNOWN", false, "example")
				.mode,
		).toBe("strict");
	});
});
