/**
 * Unit tests for API Agent Prompts Module
 */

import { describe, expect, it } from "vitest";
import {
	getAnalyzeTaskSystemPrompt,
	getAnalyzeTaskUserPrompt,
	getFormatResponseSystemPrompt,
	getFormatResponseUserPrompt,
} from "../prompts";

describe("Prompts Module", () => {
	describe("getAnalyzeTaskSystemPrompt", () => {
		const toolSummary = `1. getUser (UserService): Get user by ID
2. createOrder (OrderService): Create a new order`;

		it("should return a non-empty prompt", () => {
			const prompt = getAnalyzeTaskSystemPrompt(toolSummary);
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(100);
		});

		it("should include the tool summary", () => {
			const prompt = getAnalyzeTaskSystemPrompt(toolSummary);
			expect(prompt).toContain("getUser");
			expect(prompt).toContain("UserService");
			expect(prompt).toContain("createOrder");
		});

		it("should include API orchestration instructions", () => {
			const prompt = getAnalyzeTaskSystemPrompt(toolSummary);
			expect(prompt.toLowerCase()).toContain("api");
			expect(prompt.toLowerCase()).toContain("orchestration");
		});

		it("should include JSON output format", () => {
			const prompt = getAnalyzeTaskSystemPrompt(toolSummary);
			expect(prompt.toLowerCase()).toContain("json");
			expect(prompt).toContain("selectedToolIndex");
			expect(prompt).toContain("parameters");
		});

		it("should include tool selection instructions", () => {
			const prompt = getAnalyzeTaskSystemPrompt(toolSummary);
			expect(prompt).toContain("1-based index");
			expect(prompt).toContain("reasoning");
		});
	});

	describe("getAnalyzeTaskUserPrompt", () => {
		it("should return prompt with task description", () => {
			const prompt = getAnalyzeTaskUserPrompt("Get user by ID 123");
			expect(prompt).toContain("User Request:");
			expect(prompt).toContain("Get user by ID 123");
		});

		it("should include context when provided", () => {
			const prompt = getAnalyzeTaskUserPrompt(
				"Create an order",
				"User ID is 456, product is ABC",
			);
			expect(prompt).toContain("Create an order");
			expect(prompt).toContain("Additional Context:");
			expect(prompt).toContain("User ID is 456");
		});

		it("should not include context section when not provided", () => {
			const prompt = getAnalyzeTaskUserPrompt("Simple request");
			expect(prompt).not.toContain("Additional Context:");
		});
	});

	describe("getFormatResponseSystemPrompt", () => {
		it("should return a non-empty prompt", () => {
			const prompt = getFormatResponseSystemPrompt();
			expect(prompt).toBeTruthy();
			expect(typeof prompt).toBe("string");
			expect(prompt.length).toBeGreaterThan(50);
		});

		it("should include formatting guidelines", () => {
			const prompt = getFormatResponseSystemPrompt();
			expect(prompt.toLowerCase()).toContain("format");
			expect(prompt.toLowerCase()).toContain("user-friendly");
		});

		it("should include markdown mention", () => {
			const prompt = getFormatResponseSystemPrompt();
			expect(prompt.toLowerCase()).toContain("markdown");
		});

		it("should include JSON avoidance instruction", () => {
			const prompt = getFormatResponseSystemPrompt();
			expect(prompt.toLowerCase()).toContain("json");
		});
	});

	describe("getFormatResponseUserPrompt", () => {
		const responseData = { userId: 123, name: "John Doe" };

		it("should include task description", () => {
			const prompt = getFormatResponseUserPrompt(
				"Get user info",
				"getUser",
				"UserService",
				responseData,
			);
			expect(prompt).toContain("Original Request:");
			expect(prompt).toContain("Get user info");
		});

		it("should include tool and service names", () => {
			const prompt = getFormatResponseUserPrompt(
				"Get user info",
				"getUser",
				"UserService",
				responseData,
			);
			expect(prompt).toContain("Tool Called:");
			expect(prompt).toContain("getUser");
			expect(prompt).toContain("UserService");
		});

		it("should include JSON-formatted response data", () => {
			const prompt = getFormatResponseUserPrompt(
				"Get user info",
				"getUser",
				"UserService",
				responseData,
			);
			expect(prompt).toContain("Response Data:");
			expect(prompt).toContain('"userId"');
			expect(prompt).toContain("123");
			expect(prompt).toContain("John Doe");
		});

		it("should handle complex response data", () => {
			const complexData = {
				users: [
					{ id: 1, name: "Alice" },
					{ id: 2, name: "Bob" },
				],
				total: 2,
			};
			const prompt = getFormatResponseUserPrompt(
				"List users",
				"listUsers",
				"UserService",
				complexData,
			);
			expect(prompt).toContain("Alice");
			expect(prompt).toContain("Bob");
		});
	});
});
