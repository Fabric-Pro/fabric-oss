/**
 * Unit tests for Story Breakdown Prompts Module
 */

import { describe, expect, it } from "vitest";
import {
	buildUserMessage,
	getDefaultSystemPrompt,
	getPredictStateConfig,
} from "../prompts";

describe("Prompts Module", () => {
	describe("getDefaultSystemPrompt", () => {
		it("should return a non-empty prompt", () => {
			const prompt = getDefaultSystemPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(100);
		});

		it("should include story format instructions", () => {
			const prompt = getDefaultSystemPrompt();
			expect(prompt).toContain("Feature Format");
			expect(prompt).toContain("F-001");
			expect(prompt).toContain("As a");
			expect(prompt).toContain("I want");
			expect(prompt).toContain("So that");
		});

		it("should include INVEST criteria", () => {
			const prompt = getDefaultSystemPrompt();
			expect(prompt).toContain("INVEST");
		});

		it("should include acceptance criteria format", () => {
			const prompt = getDefaultSystemPrompt();
			expect(prompt).toContain("Acceptance Criteria");
			expect(prompt).toContain("Given");
			expect(prompt).toContain("when");
			expect(prompt).toContain("then");
		});

		it("should mention write_document_local tool", () => {
			const prompt = getDefaultSystemPrompt();
			expect(prompt).toContain("write_document_local");
		});
	});

	describe("buildUserMessage", () => {
		it("should include project name", () => {
			const message = buildUserMessage(
				"Test Project",
				undefined,
				"PRD content",
			);
			expect(message).toContain("Project: Test Project");
		});

		it("should include project description when provided", () => {
			const message = buildUserMessage(
				"Test Project",
				"A test description",
				"PRD content",
			);
			expect(message).toContain("Test Project - A test description");
		});

		it("should not include description separator when not provided", () => {
			const message = buildUserMessage(
				"Test Project",
				undefined,
				"PRD content",
			);
			expect(message).not.toContain(" - ");
		});

		it("should include PRD content", () => {
			const prdContent = "# Feature 1\n\nDescription of feature";
			const message = buildUserMessage("Project", undefined, prdContent);
			expect(message).toContain("PRD:");
			expect(message).toContain(prdContent);
		});

		it("should include breakdown instruction", () => {
			const message = buildUserMessage("Project", undefined, "PRD");
			expect(message).toContain("Break down into features");
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
