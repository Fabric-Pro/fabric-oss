/**
 * Unit tests for Project Document Generator Utils Module
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { countToolRoundsSinceLastHuman as sharedCountToolRoundsSinceLastHuman } from "@repo/agent-core/recursion";
import { describe, expect, it } from "vitest";
import {
	buildPatchToolResponseContent,
	buildReplaceAllFollowUpNote,
	calculateRetryDelay,
	countToolRoundsSinceLastHuman,
	DEFAULT_RECURSION_LIMIT,
	extractProviderConfig,
	getAgentModel,
	isJsonParseError,
	isVisionUnsupportedError,
	MAX_JSON_RETRIES,
	MAX_RETRIES,
	MAX_TOOL_ITERATIONS,
	sleep,
} from "../utils";

describe("Utils Module", () => {
	describe("Constants", () => {
		it("should have DEFAULT_RECURSION_LIMIT defined", () => {
			expect(DEFAULT_RECURSION_LIMIT).toBe(50);
		});

		it("should keep DEFAULT_RECURSION_LIMIT above the tool-iteration guard's floor", () => {
			// Each tool round costs 2 supersteps (chat_node + tool_node), the
			// finalize call after the last budgeted round costs 1 more, and
			// retries cost 1 each, cumulative up to MAX_RETRIES. See the doc
			// comment on DEFAULT_RECURSION_LIMIT in utils/index.ts.
			expect(DEFAULT_RECURSION_LIMIT).toBeGreaterThanOrEqual(
				2 * MAX_TOOL_ITERATIONS + 1 + MAX_RETRIES,
			);
		});

		it("should have MAX_RETRIES defined", () => {
			expect(MAX_RETRIES).toBe(5);
		});

		it("should have MAX_JSON_RETRIES defined", () => {
			expect(MAX_JSON_RETRIES).toBe(3);
		});
	});

	describe("getAgentModel", () => {
		it("should be a function", () => {
			expect(typeof getAgentModel).toBe("function");
		});

		it("should require runtime AI provider configuration", () => {
			// Agents are stateless and must receive config at runtime
			expect(() => getAgentModel()).toThrow("No AI provider configured");
		});

		it("should require ai_api_key in configurable", () => {
			expect(() => getAgentModel({ configurable: {} })).toThrow(
				"No AI provider configured",
			);
		});
	});

	describe("extractProviderConfig", () => {
		it("should be a function", () => {
			expect(typeof extractProviderConfig).toBe("function");
		});

		it("should return undefined when no config", () => {
			expect(extractProviderConfig()).toBeUndefined();
			expect(extractProviderConfig(null)).toBeUndefined();
		});

		it("should extract provider config from configurable", () => {
			const config = {
				configurable: {
					ai_api_key: "test-key",
					ai_model: "test-model",
					ai_gateway_url: "https://test.com",
				},
			};
			const result = extractProviderConfig(config);
			expect(result).toBeDefined();
			expect(result?.apiKey).toBe("test-key");
			expect(result?.model).toBe("test-model");
			expect(result?.baseUrl).toBe("https://test.com");
		});
	});

	describe("isJsonParseError", () => {
		it("should return true for JSON parse errors", () => {
			const error = new Error(
				"Failed to parse tool call arguments as JSON",
			);
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return true for Invalid JSON errors", () => {
			const error = new Error("Invalid JSON");
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return true for JSON parse error messages", () => {
			const error = new Error("JSON parse error: unexpected token");
			expect(isJsonParseError(error)).toBe(true);
		});

		it("should return false for non-JSON errors", () => {
			const error = new Error("timeout");
			expect(isJsonParseError(error)).toBe(false);
		});
	});

	describe("isVisionUnsupportedError", () => {
		it("returns true for provider-side image rejection", () => {
			expect(
				isVisionUnsupportedError(
					new Error("this model does not support image input"),
				),
			).toBe(true);
		});

		it("returns true for vision phrasing", () => {
			expect(
				isVisionUnsupportedError(
					new Error("Model does not support vision"),
				),
			).toBe(true);
		});

		it("returns true for multimodal phrasing", () => {
			expect(
				isVisionUnsupportedError(
					new Error("does not support multimodal input"),
				),
			).toBe(true);
		});

		it("returns true for image_url is not supported", () => {
			expect(
				isVisionUnsupportedError(
					new Error("Field image_url is not supported by this model"),
				),
			).toBe(true);
		});

		// Observed in staging: an Azure AI Foundry deployment named "gpt-4o"
		// that resolves to a non-vision-capable underlying model returns this
		// exact message (full form includes the supported-format list, but
		// some wrappers — Vercel AI Gateway, CopilotKit error envelopes —
		// truncate it). Each clause below is matched independently so we
		// catch the message no matter where the trailing detail gets cut.
		it("returns true for OpenAI/Azure 'uploaded an unsupported image' phrasing", () => {
			expect(
				isVisionUnsupportedError(
					new Error(
						"400 You uploaded an unsupported image. Please make sure your image is below 20 MB in size and is of one the following formats: ['png', 'jpeg', 'gif', 'webp']",
					),
				),
			).toBe(true);
		});

		it("returns true for the truncated 'uploaded an unsupported image' form", () => {
			expect(
				isVisionUnsupportedError(
					new Error(
						"You uploaded an unsupported image. Please make sure your image is valid.",
					),
				),
			).toBe(true);
		});

		it("returns true for the trailing 'make sure your image is valid' clause alone", () => {
			expect(
				isVisionUnsupportedError(
					new Error("Please make sure your image is valid"),
				),
			).toBe(true);
		});

		it("returns true for the negated variant 'make sure your image is not valid' (defensive)", () => {
			// Synthetic guard against a hypothetical wrapper that re-shapes
			// the trailing clause; the regex allows the optional "not ".
			expect(
				isVisionUnsupportedError(
					new Error("Please make sure your image is not valid"),
				),
			).toBe(true);
		});

		it("returns true for 'your image must be ...' OpenAI variant", () => {
			expect(
				isVisionUnsupportedError(
					new Error(
						"your image must be one of the following formats: png, jpeg, gif, webp",
					),
				),
			).toBe(true);
		});

		it("returns true for 'provided an unsupported image' wording", () => {
			expect(
				isVisionUnsupportedError(
					new Error("Client provided an unsupported image format"),
				),
			).toBe(true);
		});

		it("returns false for unrelated errors", () => {
			expect(isVisionUnsupportedError(new Error("timeout"))).toBe(false);
			expect(isVisionUnsupportedError(new Error("rate limited"))).toBe(
				false,
			);
			// Make sure the broadened patterns don't accidentally match the
			// generic "request is not valid" / "user input must be ..." family.
			expect(
				isVisionUnsupportedError(new Error("request is not valid")),
			).toBe(false);
			expect(
				isVisionUnsupportedError(
					new Error("your input must be a string"),
				),
			).toBe(false);
		});

		// Codex review of PR #1140 flagged that a naive
		// /(image|file)\s+is\s+(not\s+)?valid/ regex would false-positive on
		// generic oRPC / upload-layer validation strings. The current
		// implementation anchors on "make sure your image is" (OpenAI/Azure
		// vision-call context) precisely to avoid this category. Lock both
		// branches so a future broadening cannot regress:
		it("returns false for generic upload validation 'the uploaded image is not valid'", () => {
			expect(
				isVisionUnsupportedError(
					new Error(
						"The uploaded image is not valid for this user story",
					),
				),
			).toBe(false);
		});

		it("returns false for generic 'file is not valid' upload errors", () => {
			expect(
				isVisionUnsupportedError(
					new Error("The selected file is not valid"),
				),
			).toBe(false);
		});
	});

	describe("calculateRetryDelay", () => {
		it("should return base delay for first retry", () => {
			expect(calculateRetryDelay(0)).toBe(500); // 500 * 2^0
		});

		it("should double delay for each retry", () => {
			expect(calculateRetryDelay(1)).toBe(1000); // 500 * 2^1
			expect(calculateRetryDelay(2)).toBe(2000); // 500 * 2^2
			expect(calculateRetryDelay(3)).toBe(4000); // 500 * 2^3
		});

		it("should cap at 4000ms", () => {
			expect(calculateRetryDelay(4)).toBe(4000);
			expect(calculateRetryDelay(5)).toBe(4000);
			expect(calculateRetryDelay(10)).toBe(4000);
		});
	});

	describe("sleep", () => {
		it("should be a function", () => {
			expect(typeof sleep).toBe("function");
		});

		it("should return a promise", () => {
			const result = sleep(1);
			expect(result).toBeInstanceOf(Promise);
		});

		it("should resolve after specified time", async () => {
			const start = Date.now();
			await sleep(50);
			const elapsed = Date.now() - start;
			expect(elapsed).toBeGreaterThanOrEqual(45);
		});
	});

	describe("countToolRoundsSinceLastHuman", () => {
		it("is the shared agent-core helper", () => {
			expect(countToolRoundsSinceLastHuman).toBe(
				sharedCountToolRoundsSinceLastHuman,
			);
		});

		it("returns 0 for an empty message history", () => {
			expect(countToolRoundsSinceLastHuman([])).toBe(0);
		});

		it("returns 0 when there are no tool-calling AI messages", () => {
			const messages = [
				new HumanMessage({ content: "hi" }),
				new AIMessage({ content: "hello there" }),
			];
			expect(countToolRoundsSinceLastHuman(messages)).toBe(0);
		});

		it("counts AI-with-tool_calls messages after the last human message", () => {
			const messages = [
				new HumanMessage({ content: "research this" }),
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "1",
							name: "search_x",
							args: {},
							type: "tool_call",
						},
					],
				}),
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "2",
							name: "search_y",
							args: {},
							type: "tool_call",
						},
					],
				}),
			];
			expect(countToolRoundsSinceLastHuman(messages)).toBe(2);
		});

		it("breaks at the most recent human message and ignores earlier rounds", () => {
			const messages = [
				new HumanMessage({ content: "first request" }),
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "1",
							name: "search_x",
							args: {},
							type: "tool_call",
						},
					],
				}),
				new HumanMessage({ content: "second request" }),
				new AIMessage({
					content: "",
					tool_calls: [
						{
							id: "2",
							name: "search_y",
							args: {},
							type: "tool_call",
						},
					],
				}),
			];
			expect(countToolRoundsSinceLastHuman(messages)).toBe(1);
		});

		it("handles the camelCase toolCalls variant", () => {
			const messages = [
				new HumanMessage({ content: "hi" }),
				{
					_getType: () => "ai",
					toolCalls: [{ id: "1", name: "search_x", args: {} }],
				},
			];
			expect(countToolRoundsSinceLastHuman(messages as any)).toBe(1);
		});

		it("handles role-based messages (role: 'assistant' / role: 'user')", () => {
			const messages = [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					tool_calls: [{ id: "1", name: "search_x", args: {} }],
				},
				{
					role: "assistant",
					tool_calls: [{ id: "2", name: "search_y", args: {} }],
				},
			];
			expect(countToolRoundsSinceLastHuman(messages as any)).toBe(2);
		});

		it("does not count AI messages with an empty tool_calls array", () => {
			const messages = [
				new HumanMessage({ content: "hi" }),
				new AIMessage({ content: "no tools needed", tool_calls: [] }),
			];
			expect(countToolRoundsSinceLastHuman(messages)).toBe(0);
		});
	});

	describe("buildPatchToolResponseContent", () => {
		it("returns the plain confirmation when no stats are provided", () => {
			expect(buildPatchToolResponseContent()).toBe("Patches applied.");
			expect(buildPatchToolResponseContent([])).toBe("Patches applied.");
		});

		it("stays plain for single-occurrence patches with no residuals", () => {
			expect(
				buildPatchToolResponseContent([
					{
						patchIndex: 0,
						find: "old text",
						occurrences: 1,
						replaceAll: false,
						residualOccurrences: 0,
					},
				]),
			).toBe("Patches applied.");
		});

		it("reports multi-occurrence counts and residual warnings", () => {
			const content = buildPatchToolResponseContent([
				{
					patchIndex: 2,
					find: "Documents area",
					occurrences: 7,
					replaceAll: true,
					residualOccurrences: 2,
				},
			]);
			expect(content).toContain("Patches applied.");
			expect(content).toContain(
				'replace_text patch[2] replaced 7 occurrences of "Documents area".',
			);
			expect(content).toContain(
				'2 occurrence(s) of "Documents area" remain in the document',
			);
		});

		it("truncates long find strings in the report", () => {
			const longFind = "x".repeat(80);
			const content = buildPatchToolResponseContent([
				{
					patchIndex: 0,
					find: longFind,
					occurrences: 3,
					replaceAll: true,
					residualOccurrences: 0,
				},
			]);
			expect(content).toContain(`"${"x".repeat(60)}…"`);
			expect(content).not.toContain("x".repeat(61));
		});
	});

	describe("buildReplaceAllFollowUpNote", () => {
		it("returns undefined when nothing was replaced via replaceAll", () => {
			expect(buildReplaceAllFollowUpNote()).toBeUndefined();
			expect(buildReplaceAllFollowUpNote([])).toBeUndefined();
			expect(
				buildReplaceAllFollowUpNote([
					{
						patchIndex: 0,
						find: "a",
						occurrences: 5,
						replaceAll: false,
						residualOccurrences: 0,
					},
				]),
			).toBeUndefined();
		});

		it("returns undefined for a single replaceAll occurrence", () => {
			expect(
				buildReplaceAllFollowUpNote([
					{
						patchIndex: 0,
						find: "a",
						occurrences: 1,
						replaceAll: true,
						residualOccurrences: 0,
					},
				]),
			).toBeUndefined();
		});

		it("sums occurrences across replaceAll patches", () => {
			expect(
				buildReplaceAllFollowUpNote([
					{
						patchIndex: 0,
						find: "a",
						occurrences: 4,
						replaceAll: true,
						residualOccurrences: 0,
					},
					{
						patchIndex: 1,
						find: "b",
						occurrences: 3,
						replaceAll: true,
						residualOccurrences: 0,
					},
				]),
			).toBe("Replaced 7 occurrences in total.");
		});
	});
});
