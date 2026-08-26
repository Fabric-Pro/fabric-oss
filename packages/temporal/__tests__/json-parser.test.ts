/**
 * JSON Parser Utility Tests
 *
 * Tests for the safeParseJson utility that extracts JSON from AI model responses.
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it } from "vitest";
import { safeParseJson } from "../src/activities/orchestrator/utils/json-parser";

describe("safeParseJson", () => {
	describe("object parsing", () => {
		it("should parse valid JSON object directly", () => {
			const input = '{"key": "value", "number": 42}';
			const result = safeParseJson<{ key: string; number: number }>(
				input,
			);

			expect(result).toEqual({ key: "value", number: 42 });
		});

		it("should extract JSON from markdown code block", () => {
			const input = `Here is the response:
\`\`\`json
{"name": "test", "active": true}
\`\`\`
That's the output.`;
			const result = safeParseJson<{ name: string; active: boolean }>(
				input,
			);

			expect(result).toEqual({ name: "test", active: true });
		});

		it("should extract JSON with text before and after", () => {
			const input = `The routing decision is: {"agent": "document_generator", "confidence": 0.9} based on the analysis.`;
			const result = safeParseJson<{ agent: string; confidence: number }>(
				input,
			);

			expect(result).toEqual({
				agent: "document_generator",
				confidence: 0.9,
			});
		});

		it("should handle nested objects", () => {
			const input = `{"outer": {"inner": {"deep": true}}, "array": [1, 2, 3]}`;
			const result = safeParseJson<{
				outer: { inner: { deep: boolean } };
				array: number[];
			}>(input);

			expect(result).toEqual({
				outer: { inner: { deep: true } },
				array: [1, 2, 3],
			});
		});

		it("should return null for empty input", () => {
			const result = safeParseJson("");
			expect(result).toBeNull();
		});

		it("should return null when no JSON found", () => {
			const input = "This is just plain text without any JSON";
			const result = safeParseJson(input);

			expect(result).toBeNull();
		});

		it("should return null for malformed JSON", () => {
			const input = '{"key": "value", "incomplete": ';
			const result = safeParseJson(input);

			expect(result).toBeNull();
		});

		it("should return null for unbalanced brackets", () => {
			const input = '{"key": "value", "nested": {"missing": true}';
			const result = safeParseJson(input);

			expect(result).toBeNull();
		});
	});

	describe("array parsing", () => {
		it("should parse valid JSON array directly", () => {
			const input = '[1, 2, 3, "four"]';
			const result = safeParseJson<(number | string)[]>(input, "array");

			expect(result).toEqual([1, 2, 3, "four"]);
		});

		it("should extract array from markdown code block", () => {
			const input = `The list is:
\`\`\`json
["item1", "item2", "item3"]
\`\`\``;
			const result = safeParseJson<string[]>(input, "array");

			expect(result).toEqual(["item1", "item2", "item3"]);
		});

		it("should extract array with text around it", () => {
			const input = `Steps: ["step1", "step2"] are the required actions.`;
			const result = safeParseJson<string[]>(input, "array");

			expect(result).toEqual(["step1", "step2"]);
		});

		it("should handle array of objects", () => {
			const input =
				'[{"name": "agent1", "score": 0.8}, {"name": "agent2", "score": 0.6}]';
			const result = safeParseJson<{ name: string; score: number }[]>(
				input,
				"array",
			);

			expect(result).toEqual([
				{ name: "agent1", score: 0.8 },
				{ name: "agent2", score: 0.6 },
			]);
		});

		it("should return null for object when expecting array", () => {
			const input = '{"key": "value"}';
			const result = safeParseJson(input, "array");

			expect(result).toBeNull();
		});
	});

	describe("edge cases", () => {
		it("should handle whitespace around JSON", () => {
			const input = '   \n\n  { "key": "value" }  \n  ';
			const result = safeParseJson<{ key: string }>(input);

			expect(result).toEqual({ key: "value" });
		});

		it("should handle multiple JSON blocks (returns first)", () => {
			const input = 'First: {"first": 1} and second: {"second": 2}';
			const result = safeParseJson<{ first: number }>(input);

			expect(result).toEqual({ first: 1 });
		});

		it("should handle special characters in strings", () => {
			const input =
				'{"message": "Hello\\nWorld", "path": "C:\\\\Users\\\\test"}';
			const result = safeParseJson<{ message: string; path: string }>(
				input,
			);

			expect(result).toEqual({
				message: "Hello\nWorld",
				path: "C:\\Users\\test",
			});
		});

		it("should handle unicode in strings", () => {
			const input = '{"emoji": "🚀", "japanese": "こんにちは"}';
			const result = safeParseJson<{ emoji: string; japanese: string }>(
				input,
			);

			expect(result).toEqual({ emoji: "🚀", japanese: "こんにちは" });
		});

		it("should handle case-insensitive json code blocks", () => {
			const input = `\`\`\`JSON
{"key": "value"}
\`\`\``;
			const result = safeParseJson<{ key: string }>(input);

			expect(result).toEqual({ key: "value" });
		});
	});
});
