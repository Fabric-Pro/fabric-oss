import { zodSchema } from "ai";
import { describe, expect, it } from "vitest";
import { jsonSchemaToZod } from "../schema-utils";

describe.each(["top level", "nested"])(
	"additionalProperties at %s",
	(level) => {
		function convert(additionalProperties: unknown) {
			const objectSchema = {
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
				...(additionalProperties === undefined
					? {}
					: { additionalProperties }),
			};
			return jsonSchemaToZod(
				level === "nested"
					? {
							type: "object",
							properties: { metadata: objectSchema },
							required: ["metadata"],
						}
					: objectSchema,
			);
		}

		function input(extra: unknown) {
			const value = { name: "example", extra };
			return level === "nested" ? { metadata: value } : value;
		}

		function declaredOnly() {
			return level === "nested"
				? { metadata: { name: "example" } }
				: { name: "example" };
		}

		async function emittedObject(schema: ReturnType<typeof convert>) {
			const emitted = await zodSchema(schema).jsonSchema;
			if (level === "nested") {
				expect(emitted.additionalProperties).toBe(false);
				return emitted.properties?.metadata as typeof emitted;
			}
			return emitted;
		}

		it.each([true, {}])(
			"keeps extra keys allowed by %j",
			async (policy) => {
				const schema = convert(policy);
				expect(schema.parse(input({ enabled: true }))).toEqual(
					input({ enabled: true }),
				);
				const emitted = await emittedObject(schema);
				expect(emitted).toHaveProperty("additionalProperties");
				expect(emitted.additionalProperties).not.toBe(false);
			},
		);

		it("validates extra keys against the additional property schema", async () => {
			const schema = convert({ type: "number" });
			expect(schema.parse(input(42))).toEqual(input(42));
			expect(schema.safeParse(input("invalid")).success).toBe(false);
			expect((await emittedObject(schema)).additionalProperties).toEqual({
				type: "number",
			});
		});

		it("strips extra keys when additionalProperties is omitted", async () => {
			const schema = convert(undefined);
			expect(schema.parse(input(42))).toEqual(declaredOnly());
			// Closed objects preserve strict-mode compatibility (packages/ai/lib/strict-json-schema-middleware.ts).
			expect((await emittedObject(schema)).additionalProperties).toBe(
				false,
			);
		});

		it.each([false, []])(
			"strips extra keys when additionalProperties is %j",
			async (policy) => {
				const schema = convert(policy);
				expect(schema.parse(input(42))).toEqual(declaredOnly());
				expect((await emittedObject(schema)).additionalProperties).toBe(
					false,
				);
			},
		);
	},
);

it.each([undefined, false, true, {}, { type: "number" }])(
	"preserves no-properties passthrough for %j",
	(additionalProperties) => {
		const schema = jsonSchemaToZod({
			type: "object",
			additionalProperties,
		});
		expect(schema.parse({ extra: "example" })).toEqual({
			extra: "example",
		});
	},
);
