import { describe, expect, it } from "vitest";
import {
	gradeResultQuality,
	resultQualityChecksSchema,
	resultQualityComparisonCompatible,
	resultQualityGradeSchema,
} from "../result-quality";

describe("recorded result quality", () => {
	it("preserves legacy check shape and literal case-sensitive behavior", () => {
		const checks = {
			requiredPhrases: ["Done"],
			forbiddenPhrases: ["secret"],
		};
		expect(resultQualityChecksSchema.parse(checks)).toEqual(checks);
		const report = gradeResultQuality("done", checks);
		expect(report.status).toBe("FAILED");
		expect(report.passed).toBe(1);
		expect(gradeResultQuality("Done", checks).status).toBe("PASSED");
	});
	it.each(["", " \n\t", "🧵".repeat(300_000)])(
		"rejects empty or oversized answers instead of passing forbidden-only checks",
		(text) => {
			expect(() =>
				gradeResultQuality(text, { forbiddenPhrases: ["missing"] }),
			).toThrow();
		},
	);
	it("requires explicit v2 for richer checks and at least one check", () => {
		expect(resultQualityChecksSchema.safeParse({}).success).toBe(false);
		expect(
			resultQualityChecksSchema.safeParse({
				jsonAssertions: [{ pointer: "", type: "object" }],
			}).success,
		).toBe(false);
	});
	it("checks structured output without persisting values or raw answer", () => {
		const report = gradeResultQuality(
			'{"status":"ready","score":7,"items":[true]}',
			{
				version: 2,
				jsonSchema: {
					type: "object",
					required: ["status", "score", "items"],
					additionalProperties: false,
					properties: {
						status: { type: "string", enum: ["ready"] },
						score: { type: "integer", minimum: 5, maximum: 10 },
						items: {
							type: "array",
							minItems: 1,
							maxItems: 2,
							items: { type: "boolean" },
						},
					},
				},
				jsonAssertions: [
					{ pointer: "/status", equals: "ready" },
					{ pointer: "/score", minimum: 5, maximum: 7 },
					{ pointer: "/items/0", equals: true },
				],
			},
		);
		expect(report.status).toBe("PASSED");
		expect(report.total).toBe(4);
		expect(JSON.stringify(report)).not.toContain('"ready"');
		expect(JSON.stringify(report)).not.toContain('"score"');
	});
	it.each([
		'{"n":0}',
		'{"n":"7"}',
		"{}",
		"not json",
		'```json\n{"n":7}\n```',
	])("fails missing, mistyped or invalid JSON: %s", (answer) => {
		expect(
			gradeResultQuality(answer, {
				version: 2,
				jsonAssertions: [
					{ pointer: "/n", type: "integer", minimum: 5 },
				],
			}).status,
		).toBe("FAILED");
	});
	it("handles null, root pointers and RFC6901 escapes without inherited access", () => {
		expect(
			gradeResultQuality('{"a/b":{"~x":null},"list":[false]}', {
				version: 2,
				jsonAssertions: [
					{ pointer: "", type: "object" },
					{ pointer: "/a~1b/~0x", equals: null },
					{ pointer: "/list/0", equals: false },
				],
			}).status,
		).toBe("PASSED");
		expect(
			gradeResultQuality('{"list":[false]}', {
				version: 2,
				jsonAssertions: [{ pointer: "/list/length", type: "integer" }],
			}).status,
		).toBe("FAILED");
	});
	it.each([
		"/constructor",
		"/__proto__/secret",
		"/prototype",
		"/bad~2",
		"/bad~",
		"n",
		"/".repeat(20),
	])("rejects unsafe or invalid pointer %s", (pointer) => {
		expect(
			resultQualityChecksSchema.safeParse({
				version: 2,
				jsonAssertions: [{ pointer, type: "string" }],
			}).success,
		).toBe(false);
	});
	it.each([
		{ type: "object", $ref: "https://example.com/schema" },
		{ type: "string", pattern: "(a+)+$" },
		{ type: "object", allOf: [] },
		{ type: "array", properties: { a: { type: "string" } } },
		{ type: "number", minimum: 5, maximum: 2 },
		{ type: "array", items: true },
	])("rejects unsupported or contradictory schemas", (schema) => {
		expect(
			resultQualityChecksSchema.safeParse({
				version: 2,
				jsonSchema: schema,
			}).success,
		).toBe(false);
	});
	it("bounds schema depth and count", () => {
		let schema: unknown = { type: "string" };
		for (let i = 0; i < 10; i++) {
			schema = { type: "array", items: schema };
		}
		expect(
			resultQualityChecksSchema.safeParse({
				version: 2,
				jsonSchema: schema,
			}).success,
		).toBe(false);
		expect(
			resultQualityChecksSchema.safeParse({
				version: 2,
				jsonSchema: {
					type: "object",
					properties: Object.fromEntries(
						Array.from({ length: 21 }, (_, i) => [
							`p${i}`,
							{ type: "string" },
						]),
					),
				},
			}).success,
		).toBe(false);
	});
	it("checks additional properties, required keys, string and array bounds", () => {
		const checks = {
			version: 2,
			jsonSchema: {
				type: "object",
				additionalProperties: false,
				required: ["s", "a"],
				properties: {
					s: { type: "string", minLength: 2, maxLength: 3 },
					a: {
						type: "array",
						minItems: 1,
						maxItems: 2,
						items: { type: "number" },
					},
				},
			},
		};
		for (const text of [
			'{"s":"ab","a":[2],"other":1}',
			'{"s":"ab"}',
			'{"s":"a","a":[2]}',
			'{"s":"abcd","a":[2]}',
			'{"s":"ab","a":[]}',
			'{"s":"ab","a":[1,2,3]}',
		]) {
			expect(gradeResultQuality(text, checks).status).toBe("FAILED");
		}
	});
	it("never certifies grounding from citations or client evidence", () => {
		const report = gradeResultQuality("Done [source:1]", {
			version: 2,
			requiredPhrases: ["Done"],
			grounding: { requireCitations: true },
		});
		expect(report.status).toBe("NOT_ASSESSED");
		expect(report.unavailable).toBe(1);
		expect(report.passed).toBe(1);
		expect(
			resultQualityChecksSchema.safeParse({
				version: 2,
				grounding: { requireCitations: true, verified: true },
			}).success,
		).toBe(false);
		expect(
			gradeResultQuality("not done", {
				version: 2,
				requiredPhrases: ["Done"],
				grounding: { requireCitations: true },
			}).status,
		).toBe("FAILED");
	});
	it("rejects tampered report counts, availability and status", () => {
		const report = gradeResultQuality("yes", { requiredPhrases: ["yes"] });
		expect(
			resultQualityGradeSchema.safeParse({
				...report,
				status: "NOT_ASSESSED",
			}).success,
		).toBe(false);
		expect(
			resultQualityGradeSchema.safeParse({ ...report, passed: 0 })
				.success,
		).toBe(false);
		expect(
			resultQualityGradeSchema.safeParse({
				...report,
				results: [{ ...report.results[0], available: false }],
			}).success,
		).toBe(false);
	});
	it("rejects comparisons across scorer versions or methods", () => {
		const a = { version: 2, method: "deterministic", scorerVersion: "a" };
		expect(resultQualityComparisonCompatible(a, a)).toBe(true);
		expect(
			resultQualityComparisonCompatible(a, { ...a, scorerVersion: "b" }),
		).toBe(false);
		expect(
			resultQualityComparisonCompatible(a, {
				version: 1,
				method: "exact-text",
			}),
		).toBe(false);
	});
});

it("reports unavailable when a schema exceeds the evaluation budget instead of manufacturing a failure", () => {
	const report = gradeResultQuality(
		JSON.stringify(Array.from({ length: 10_001 }, () => true)),
		{
			version: 2,
			jsonSchema: { type: "array", items: { type: "boolean" } },
		},
	);
	expect(report.status).toBe("NOT_ASSESSED");
	expect(report.unavailable).toBe(1);
	expect(report.passed).toBe(0);
});

it("exports a representable MCP input schema while enforcing nested schema rules server-side", async () => {
	const { z } = await import("zod");
	const json = z.toJSONSchema(resultQualityChecksSchema);
	expect(JSON.stringify(json)).toContain("jsonAssertions");
	expect(
		resultQualityChecksSchema.safeParse({
			version: 2,
			jsonSchema: {
				type: "object",
				properties: { secret: { type: "string", pattern: ".*" } },
			},
		}).success,
	).toBe(false);
});
