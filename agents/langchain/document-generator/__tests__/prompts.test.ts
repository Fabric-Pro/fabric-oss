/**
 * Unit tests for Document Generator Prompts Module
 */

import { describe, expect, it } from "vitest";
import { buildSystemPrompt, getPredictStateConfig } from "../prompts";

describe("Prompts Module", () => {
	describe("buildSystemPrompt", () => {
		it("should return custom prompt when provided", () => {
			const customPrompt = "You are a custom document writer.";
			const result = buildSystemPrompt(
				customPrompt,
				"general",
				undefined,
			);
			expect(result).toContain(customPrompt);
			expect(result).toContain("Markdown Formatting Rules");
		});

		it("should use default prompt when no custom prompt provided", () => {
			const result = buildSystemPrompt(undefined, "general", undefined);
			expect(result).toBeTruthy();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(50);
		});

		it("should include document type in default prompt", () => {
			const result = buildSystemPrompt(
				undefined,
				"technical_spec",
				undefined,
			);
			expect(result).toBeTruthy();
		});

		it("should handle existing document context", () => {
			const existingDoc = "# Existing Document\n\nSome content here.";
			const result = buildSystemPrompt(undefined, "general", existingDoc);
			expect(result).toBeTruthy();
		});
	});

	describe("getPredictStateConfig", () => {
		it("should return an array", () => {
			const config = getPredictStateConfig();
			expect(Array.isArray(config)).toBe(true);
		});

		it("should have document state key configuration", () => {
			const config = getPredictStateConfig();
			const documentConfig = config.find(
				(c) => c.state_key === "document",
			);
			expect(documentConfig).toBeDefined();
			expect(documentConfig?.tool).toBe("write_document_local");
			expect(documentConfig?.tool_argument).toBe("document");
		});

		it("should have focusAnchor state key configuration", () => {
			const config = getPredictStateConfig();
			const focusConfig = config.find(
				(c) => c.state_key === "focusAnchor",
			);
			expect(focusConfig).toBeDefined();
			expect(focusConfig?.tool).toBe("write_document_local");
			expect(focusConfig?.tool_argument).toBe("focusAnchor");
		});

		it("should have exactly 2 configurations", () => {
			const config = getPredictStateConfig();
			expect(config).toHaveLength(2);
		});
	});
});
