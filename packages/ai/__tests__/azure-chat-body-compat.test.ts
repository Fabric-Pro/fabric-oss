import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toStrictJsonSchema } from "../lib/strict-json-schema-middleware";
import { applyAzureChatBodyCompat } from "../model-factory";

describe("applyAzureChatBodyCompat", () => {
	it("preserves a middleware-converted schema with defaults and nested optional objects", async () => {
		const schema = toStrictJsonSchema(
			await zodSchema(
				z.object({
					meta: z
						.object({
							note: z.string().max(200).default("example"),
						})
						.optional(),
					rows: z.array(z.object({ note: z.string().optional() })),
				}),
			).jsonSchema,
		);
		expect(schema).toBeDefined();
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: { strict: true, schema },
			},
		};
		expect(applyAzureChatBodyCompat(body, "gpt-4.1-mini")).toBe(false);
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(body.response_format.json_schema.schema).toBe(schema);
	});
	it.each(["properties", "items", "anyOf", "$defs", "definitions"])(
		"relaxes incompatible nested objects through %s",
		(path) => {
			const invalid = {
				type: "object",
				properties: { note: { type: "string" } },
				required: ["note"],
			};
			const root = {
				type: "object",
				properties: {},
				required: [],
				additionalProperties: false,
			};
			const schema =
				path === "properties"
					? {
							...root,
							properties: { entry: invalid },
							required: ["entry"],
						}
					: path === "items"
						? {
								...root,
								properties: {
									rows: { type: "array", items: invalid },
								},
								required: ["rows"],
							}
						: path === "anyOf"
							? {
									...root,
									properties: {
										entry: {
											anyOf: [invalid, { type: "null" }],
										},
									},
									required: ["entry"],
								}
							: { ...root, [path]: { entry: invalid } };
			const body = {
				response_format: {
					type: "json_schema",
					json_schema: { strict: true, schema },
				},
			};
			expect(applyAzureChatBodyCompat(body, "gpt-4.1-mini")).toBe(true);
			expect(body.response_format.json_schema.strict).toBe(false);
		},
	);
	it("relaxes a closed object that does not require each property", () => {
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: {
					strict: true,
					schema: {
						type: "object",
						properties: { note: { type: "string" } },
						required: [],
						additionalProperties: false,
					},
				},
			},
		};
		expect(applyAzureChatBodyCompat(body, "gpt-4.1-mini")).toBe(true);
		expect(body.response_format.json_schema.strict).toBe(false);
	});

	it("relaxes an unconverted strict schema at the fetch boundary", () => {
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: {
					strict: true,
					schema: {
						type: "object",
						properties: { note: { type: "string" } },
					},
				},
			},
		};
		expect(applyAzureChatBodyCompat(body, "gpt-4.1-mini")).toBe(true);
		expect(body.response_format.json_schema.strict).toBe(false);
	});

	it("preserves the structured-output middleware strict decision", () => {
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: {
					name: "Proposal",
					strict: true,
					schema: {
						type: "object",
						properties: {},
						required: [],
						additionalProperties: false,
					},
				},
			},
		} as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4.1-mini");
		expect(modified).toBe(false);
		expect(
			(
				body.response_format as {
					json_schema: { strict: boolean };
				}
			).json_schema.strict,
		).toBe(true);
	});

	it("leaves an already non-strict json_schema untouched", () => {
		const body = {
			response_format: {
				type: "json_schema",
				json_schema: { name: "Proposal", strict: false, schema: {} },
			},
		} as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4.1-mini");
		expect(modified).toBe(false);
	});

	it("removes temperature (Azure deployments may reject it)", () => {
		const body = { temperature: 0.7, messages: [] } as Record<
			string,
			unknown
		>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(true);
		expect(body.temperature).toBeUndefined();
	});

	it("converts max_tokens → max_completion_tokens for modern models", () => {
		const body = { max_tokens: 256 } as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(true);
		expect(body.max_tokens).toBeUndefined();
		expect(body.max_completion_tokens).toBe(256);
	});

	it("keeps max_tokens for legacy models (gpt-4 / gpt-35)", () => {
		const body = { max_tokens: 256 } as Record<string, unknown>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4");
		expect(modified).toBe(false);
		expect(body.max_tokens).toBe(256);
	});

	it("returns false and leaves a plain body unchanged", () => {
		const body = { messages: [{ role: "user", content: "hi" }] } as Record<
			string,
			unknown
		>;
		const modified = applyAzureChatBodyCompat(body, "gpt-4o");
		expect(modified).toBe(false);
		expect(body).toEqual({ messages: [{ role: "user", content: "hi" }] });
	});
});
