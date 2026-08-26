import { describe, expect, it } from "vitest";
import {
	escapeJsonStringValue,
	interpolateTemplate,
} from "../src/activities/lib/steps/utils";
import {
	getToolSchema,
	mapInputsToSchema,
	type ToolSchema,
	validateAndMapInputs,
} from "../src/activities/orchestrator/execution/handlers/schema-mapper";

/**
 * Tests for the dynamic schema-aware input mapper.
 * This ensures tools receive correct parameters regardless of LLM naming mistakes.
 */

describe("Schema-Aware Input Mapper", () => {
	describe("mapInputsToSchema", () => {
		const searchToolSchema: ToolSchema = {
			type: "object",
			properties: {
				query: { type: "string", description: "Search query" },
				maxResults: {
					type: "number",
					description: "Max results",
					default: 5,
				},
			},
			required: ["query"],
		};

		it("should pass through correct parameters unchanged", () => {
			const result = mapInputsToSchema(
				{ query: "AI trends 2024" },
				searchToolSchema,
				"test_search",
			);
			expect(result.inputs.query).toBe("AI trends 2024");
			expect(result.missingRequired).toHaveLength(0);
			expect(result.warnings).toHaveLength(0);
		});

		it("should map alternative parameter names to required ones", () => {
			const result = mapInputsToSchema(
				{ search: "AI trends 2024" }, // 'search' instead of 'query'
				searchToolSchema,
				"test_search",
			);
			expect(result.inputs.query).toBe("AI trends 2024");
			expect(result.missingRequired).toHaveLength(0);
			expect(
				result.warnings.some((w) => w.includes("Mapped 'search'")),
			).toBe(true);
		});

		it("should apply default values for missing optional parameters", () => {
			const result = mapInputsToSchema(
				{ query: "test" },
				searchToolSchema,
				"test_search",
			);
			expect(result.inputs.maxResults).toBe(5);
		});

		it("should report missing required parameters", () => {
			const result = mapInputsToSchema(
				{ maxResults: 10 }, // Missing 'query'
				searchToolSchema,
				"test_search",
			);
			expect(result.missingRequired).toContain("query");
		});

		it("should handle null schema gracefully", () => {
			const result = mapInputsToSchema(
				{ any: "value" },
				null,
				"unknown_tool",
			);
			expect(result.inputs.any).toBe("value");
			expect(result.warnings).toHaveLength(0);
		});
	});

	describe("getToolSchema", () => {
		it("should find Fabric AI tool schemas", () => {
			const schema = getToolSchema("fabric_web_search");
			expect(schema).not.toBeNull();
			expect(schema?.properties?.query).toBeDefined();
		});

		it("should return null for unknown tools", () => {
			const schema = getToolSchema("nonexistent_tool_xyz");
			expect(schema).toBeNull();
		});
	});

	describe("validateAndMapInputs", () => {
		it("should map url to query for fabric_web_search", () => {
			// LLM mistake: using 'url' instead of 'query'
			const result = validateAndMapInputs(
				"fabric_web_search",
				{ url: "AI trends 2024" }, // Wrong param name
			);
			expect(result.query).toBe("AI trends 2024");
		});

		it("should throw helpful error for missing required params", () => {
			expect(() => {
				validateAndMapInputs(
					"fabric_web_search",
					{}, // Missing query
				);
			}).toThrow(/Missing required parameter/);
		});

		it("should pass through when schema not available", () => {
			const result = validateAndMapInputs("unknown_tool", {
				custom: "value",
			});
			expect(result.custom).toBe("value");
		});
	});

	describe("Variable Interpolation Patterns", () => {
		// Helper to simulate interpolation (tests pattern understanding)
		function simulateInterpolation(
			template: string,
			stepResults: Array<{ response?: string }>,
		): string {
			return template.replace(
				/\{\{step-(\d+)\.(\w+)\}\}/g,
				(match, num, prop) => {
					const idx = Number.parseInt(num, 10) - 1;
					if (idx >= 0 && idx < stepResults.length) {
						const aliases: Record<string, string> = {
							output: "response",
							result: "response",
						};
						const key = aliases[prop] || prop;
						const value = (
							stepResults[idx] as Record<string, unknown>
						)[key];
						if (value !== undefined) {
							return typeof value === "string"
								? value
								: JSON.stringify(value);
						}
						// Fallback to full response
						if (stepResults[idx].response) {
							return stepResults[idx].response;
						}
					}
					return match;
				},
			);
		}

		it("should resolve {{step-N.response}}", () => {
			const result = simulateInterpolation(
				"Process: {{step-1.response}}",
				[{ response: "Search results here" }],
			);
			expect(result).toBe("Process: Search results here");
		});

		it("should resolve {{step-N.output}} as alias for response", () => {
			const result = simulateInterpolation("Process: {{step-1.output}}", [
				{ response: "Search results here" },
			]);
			expect(result).toBe("Process: Search results here");
		});
	});
});

describe("JSON String Escaping", () => {
	describe("escapeJsonStringValue", () => {
		it("should escape newlines", () => {
			expect(escapeJsonStringValue("line1\nline2")).toBe("line1\\nline2");
		});

		it("should escape carriage returns", () => {
			expect(escapeJsonStringValue("line1\rline2")).toBe("line1\\rline2");
		});

		it("should escape tabs", () => {
			expect(escapeJsonStringValue("col1\tcol2")).toBe("col1\\tcol2");
		});

		it("should escape backslashes", () => {
			expect(escapeJsonStringValue("path\\to\\file")).toBe(
				"path\\\\to\\\\file",
			);
		});

		it("should escape double quotes", () => {
			expect(escapeJsonStringValue('say "hello"')).toBe(
				'say \\"hello\\"',
			);
		});

		it("should escape form feeds", () => {
			expect(escapeJsonStringValue("a\fb")).toBe("a\\fb");
		});

		it("should escape backspace", () => {
			// Use \x08 for literal backspace character
			expect(escapeJsonStringValue("a\x08b")).toBe("a\\bb");
		});

		it("should escape other control characters as unicode", () => {
			// ASCII 1 (SOH) should be escaped as \u0001
			expect(escapeJsonStringValue("a\x01b")).toBe("a\\u0001b");
		});

		it("should handle strings with multiple escape needs", () => {
			const input = 'Hello\n"World"\tTab\\Slash';
			const expected = 'Hello\\n\\"World\\"\\tTab\\\\Slash';
			expect(escapeJsonStringValue(input)).toBe(expected);
		});

		it("should leave normal strings unchanged", () => {
			expect(escapeJsonStringValue("normal string")).toBe(
				"normal string",
			);
		});
	});

	describe("interpolateTemplate with escapeForJson", () => {
		it("should not escape by default", () => {
			const result = interpolateTemplate("Text: {{value}}", {
				value: "line1\nline2",
			});
			expect(result).toBe("Text: line1\nline2");
		});

		it("should escape when escapeForJson is true", () => {
			const result = interpolateTemplate(
				"Text: {{value}}",
				{ value: "line1\nline2" },
				{ escapeForJson: true },
			);
			expect(result).toBe("Text: line1\\nline2");
		});

		it("should produce valid JSON when escapeForJson is true", () => {
			const template = '{"query": "{{value}}"}';
			const result = interpolateTemplate(
				template,
				{ value: 'Hello\n"World"\twith tabs' },
				{ escapeForJson: true },
			);

			// Should be valid JSON
			expect(() => JSON.parse(result)).not.toThrow();

			// Verify the parsed value
			const parsed = JSON.parse(result);
			expect(parsed.query).toBe('Hello\n"World"\twith tabs');
		});

		it("should handle nested node outputs with JSON escaping", () => {
			const template = '{"content": "{{nodeA.text}}"}';
			const result = interpolateTemplate(
				template,
				{ nodeA: { text: "First line\nSecond line" } },
				{ escapeForJson: true },
			);

			expect(() => JSON.parse(result)).not.toThrow();
			const parsed = JSON.parse(result);
			expect(parsed.content).toBe("First line\nSecond line");
		});

		it("should fail JSON parsing without escaping for control characters", () => {
			const template = '{"query": "{{value}}"}';
			const result = interpolateTemplate(template, {
				value: "line1\nline2",
			});

			// Without escaping, the literal newline breaks JSON
			expect(() => JSON.parse(result)).toThrow();
		});
	});
});
