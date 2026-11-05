import { promptResponseContract } from "@repo/ai/lib/prompt-response-contract";
import { describe, expect, it } from "vitest";
import {
	prepareResponseContract,
	validateResponse,
} from "../response-contract";

const schema = {
	type: "object",
	properties: { done: { type: "boolean" } },
	required: ["done"],
	additionalProperties: false,
};
describe("response contract validation", () => {
	it("validates values without dropping unknown properties or coercing types", () => {
		const contract = promptResponseContract.parse({
			format: "JSON",
			schema,
		});
		const validate = prepareResponseContract(contract);
		expect(
			validateResponse('{"done":true}', contract, validate).status,
		).toBe("passed");
		expect(
			validateResponse('{"done":"true"}', contract, validate).status,
		).toBe("failed");
		expect(
			validateResponse('{"done":true,"extra":2}', contract, validate)
				.status,
		).toBe("failed");
		expect(
			validateResponse('```json\n{"done":true}\n```', contract, validate)
				.status,
		).toBe("failed");
	});
	it.each(["$ref", "pattern", "patternProperties", "if", "$id"])(
		"rejects %s before compilation",
		(key) => {
			expect(() =>
				prepareResponseContract({
					format: "JSON",
					schema: { type: "object", [key]: "https://example.com" },
				}),
			).toThrow();
		},
	);
	it("bounds deep schemas before recursive JSON validation", () => {
		let value: Record<string, unknown> = { type: "string" };
		for (let i = 0; i < 100; i++) {
			value = { type: "object", properties: { nested: value } };
		}
		expect(
			promptResponseContract.safeParse({ format: "JSON", schema: value })
				.success,
		).toBe(false);
	});
	it.each([
		"<report><done>true</done></report>",
		'<?xml version="1.0"?><report/>',
	])("accepts a single well formed XML document: %s", (text) =>
		expect(validateResponse(text, { format: "XML" }).status).toBe("passed"),
	);
	it.each([
		"<report>",
		"<a/><b/>",
		'<!DOCTYPE report SYSTEM "https://example.com"><report/>',
		'<!ENTITY name "value"><report/>',
	])("rejects invalid XML or declarations: %s", (text) =>
		expect(validateResponse(text, { format: "XML" }).status).toBe("failed"),
	);
});

it.each([
	{ type: "object", properties: { answer: { type: "unknown" } } },
	{ type: "object", properties: { answer: { type: "string", minimum: 0 } } },
	{ type: "object", properties: { answer: { type: "array" } } },
	{ type: "object", pattern: "unsafe" },
	{ type: "object", required: "answer" },
])(
	"rejects unsupported JSON schema in the shared UI and transport contract",
	(schema) => {
		expect(
			promptResponseContract.safeParse({ format: "JSON", schema })
				.success,
		).toBe(false);
		expect(() =>
			prepareResponseContract({ format: "JSON", schema } as never),
		).toThrow();
	},
);
