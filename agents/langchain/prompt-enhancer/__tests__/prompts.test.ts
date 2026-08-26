/**
 * Prompts Module Tests
 *
 * Tests for system prompt generation and predict state configuration.
 */

import { describe, expect, it } from "vitest";
import { getPredictStateConfig, getSystemPrompt } from "../prompts";

describe("getSystemPrompt", () => {
	describe("basic functionality", () => {
		it("should return a string", () => {
			const result = getSystemPrompt("test content");
			expect(typeof result).toBe("string");
		});

		it("should include the current content", () => {
			const content = "This is my prompt content";
			const result = getSystemPrompt(content);
			expect(result).toContain(content);
		});

		it("should handle undefined content", () => {
			const result = getSystemPrompt(undefined);
			// When content is undefined, no content section is added
			expect(result).not.toContain("Current prompt:");
		});

		it("should handle empty string content", () => {
			const result = getSystemPrompt("");
			// Empty string is falsy, so no content section is added
			expect(result).not.toContain("Current prompt:");
		});
	});

	describe("instruction content", () => {
		it("should include role as prompt engineer", () => {
			const result = getSystemPrompt("test");
			expect(result.toLowerCase()).toContain("prompt engineer");
		});

		it("should mention enhance_prompt_local tool", () => {
			const result = getSystemPrompt("test");
			expect(result).toContain("enhance_prompt_local");
		});

		it("should instruct about template variable preservation", () => {
			const result = getSystemPrompt("test");
			expect(result).toMatch(/template.*variable|variable.*template/i);
		});

		it("should include enhancement guidelines", () => {
			const result = getSystemPrompt("test");
			expect(result.toLowerCase()).toContain("when making edits");
		});

		it("should instruct about making substantial improvements", () => {
			const result = getSystemPrompt("test");
			expect(result.toLowerCase()).toContain("do not change every word");
		});
	});

	describe("content formatting", () => {
		it("should wrap content with delimiters", () => {
			const result = getSystemPrompt("test content");
			expect(result).toContain("---");
		});

		it("should label as current prompt", () => {
			const result = getSystemPrompt("test");
			expect(result.toLowerCase()).toContain(
				"current state of the prompt",
			);
		});
	});

	describe("edge cases", () => {
		it("should handle content with special characters", () => {
			const content = "Test with {{variable}} and {name}";
			const result = getSystemPrompt(content);
			expect(result).toContain("{{variable}}");
			expect(result).toContain("{name}");
		});

		it("should handle very long content", () => {
			const content = "A".repeat(10000);
			const result = getSystemPrompt(content);
			expect(result).toContain(content);
		});

		it("should handle content with newlines", () => {
			const content = "Line 1\nLine 2\nLine 3";
			const result = getSystemPrompt(content);
			expect(result).toContain(content);
		});

		it("should handle content with code blocks", () => {
			const content = "```javascript\nconst x = 1;\n```";
			const result = getSystemPrompt(content);
			expect(result).toContain(content);
		});
	});
});

describe("getPredictStateConfig", () => {
	describe("configuration structure", () => {
		it("should return an array", () => {
			const result = getPredictStateConfig();
			expect(Array.isArray(result)).toBe(true);
		});

		it("should have correct number of configurations", () => {
			const result = getPredictStateConfig();
			expect(result.length).toBe(2);
		});
	});

	describe("streamingContent configuration", () => {
		it("should configure streamingContent state key", () => {
			const result = getPredictStateConfig();
			const streamingConfig = result.find(
				(c) => c.state_key === "streamingContent",
			);
			expect(streamingConfig).toBeDefined();
		});

		it("should map to enhance_prompt_local tool", () => {
			const result = getPredictStateConfig();
			const streamingConfig = result.find(
				(c) => c.state_key === "streamingContent",
			);
			expect(streamingConfig?.tool).toBe("enhance_prompt_local");
		});

		it("should map to enhancedContent tool argument", () => {
			const result = getPredictStateConfig();
			const streamingConfig = result.find(
				(c) => c.state_key === "streamingContent",
			);
			expect(streamingConfig?.tool_argument).toBe("enhancedContent");
		});
	});

	describe("focusAnchor configuration", () => {
		it("should configure focusAnchor state key", () => {
			const result = getPredictStateConfig();
			const focusConfig = result.find(
				(c) => c.state_key === "focusAnchor",
			);
			expect(focusConfig).toBeDefined();
		});

		it("should map to enhance_prompt_local tool", () => {
			const result = getPredictStateConfig();
			const focusConfig = result.find(
				(c) => c.state_key === "focusAnchor",
			);
			expect(focusConfig?.tool).toBe("enhance_prompt_local");
		});

		it("should map to focusAnchor tool argument", () => {
			const result = getPredictStateConfig();
			const focusConfig = result.find(
				(c) => c.state_key === "focusAnchor",
			);
			expect(focusConfig?.tool_argument).toBe("focusAnchor");
		});
	});

	describe("AG-UI protocol compliance", () => {
		it("should have required state_key property", () => {
			const result = getPredictStateConfig();
			result.forEach((config) => {
				expect(config).toHaveProperty("state_key");
			});
		});

		it("should have required tool property", () => {
			const result = getPredictStateConfig();
			result.forEach((config) => {
				expect(config).toHaveProperty("tool");
			});
		});

		it("should have required tool_argument property", () => {
			const result = getPredictStateConfig();
			result.forEach((config) => {
				expect(config).toHaveProperty("tool_argument");
			});
		});

		it("should use same tool for all configurations", () => {
			const result = getPredictStateConfig();
			const tools = result.map((c) => c.tool);
			expect(new Set(tools).size).toBe(1);
		});
	});
});

describe("Integration", () => {
	it("should produce consistent configurations", () => {
		// Multiple calls should return same structure
		const config1 = getPredictStateConfig();
		const config2 = getPredictStateConfig();
		expect(config1).toEqual(config2);
	});

	it("should produce system prompt referencing tools in predict config", () => {
		const systemPrompt = getSystemPrompt("test");
		const predictConfig = getPredictStateConfig();

		// System prompt should mention the tool used in predict config
		const toolName = predictConfig[0].tool;
		expect(systemPrompt).toContain(toolName);
	});
});
