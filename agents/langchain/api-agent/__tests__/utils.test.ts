/**
 * Unit tests for API Agent Utils Module
 */

import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import type { ApiAgentStateType } from "../state";
import type { OpenAPIToolDescriptor } from "../types";
import { extractTask, formatToolSummary, getAgentModel } from "../utils";

describe("Utils Module", () => {
	describe("extractTask", () => {
		it("should return taskDescription if present", () => {
			const state = createTestState({
				taskDescription: "Explicit task description",
				messages: [new HumanMessage("Message content")],
			});
			const task = extractTask(state);
			expect(task).toBe("Explicit task description");
		});

		it("should extract task from last human message", () => {
			const state = createTestState({
				messages: [
					new HumanMessage("First message"),
					new AIMessage("AI response"),
					new HumanMessage("Last human message"),
				],
			});
			const task = extractTask(state);
			expect(task).toBe("Last human message");
		});

		it("should skip AI messages when looking for human message", () => {
			const state = createTestState({
				messages: [
					new HumanMessage("Human message"),
					new AIMessage("AI response 1"),
					new AIMessage("AI response 2"),
				],
			});
			const task = extractTask(state);
			expect(task).toBe("Human message");
		});

		it("should return empty string if no messages", () => {
			const state = createTestState({ messages: [] });
			const task = extractTask(state);
			expect(task).toBe("");
		});

		it("should handle messages with array content", () => {
			const state = createTestState({
				messages: [
					{
						content: [{ text: "Part 1" }, { text: "Part 2" }],
						constructor: { name: "HumanMessage" },
					} as any,
				],
			});
			const task = extractTask(state);
			expect(task).toBe("Part 1 Part 2");
		});
	});

	describe("getAgentModel", () => {
		it("should be a function", () => {
			expect(typeof getAgentModel).toBe("function");
		});

		it("should require provider configuration", async () => {
			// Without a RunnableConfig carrying tenant/provider config, the
			// shared agent-core factory has nothing to resolve and throws.
			await expect(getAgentModel()).rejects.toThrow(
				"No AI provider configured",
			);
		});
	});

	describe("formatToolSummary", () => {
		const mockTools: OpenAPIToolDescriptor[] = [
			{
				id: "tool-1",
				name: "getUser",
				description: "Get user by ID",
				serviceId: "svc-1",
				serviceName: "UserService",
			},
			{
				id: "tool-2",
				name: "createOrder",
				description: "Create a new order",
				serviceId: "svc-2",
				serviceName: "OrderService",
			},
			{
				id: "tool-3",
				name: "deleteItem",
				description: undefined,
				serviceId: "svc-3",
				serviceName: "ItemService",
			},
		];

		it("should format tools as numbered list", () => {
			const summary = formatToolSummary(mockTools);
			expect(summary).toContain("1. getUser");
			expect(summary).toContain("2. createOrder");
			expect(summary).toContain("3. deleteItem");
		});

		it("should include service names", () => {
			const summary = formatToolSummary(mockTools);
			expect(summary).toContain("(UserService)");
			expect(summary).toContain("(OrderService)");
		});

		it("should include descriptions", () => {
			const summary = formatToolSummary(mockTools);
			expect(summary).toContain("Get user by ID");
			expect(summary).toContain("Create a new order");
		});

		it("should show 'No description' for tools without description", () => {
			const summary = formatToolSummary(mockTools);
			expect(summary).toContain("No description");
		});

		it("should limit number of tools", () => {
			const manyTools: OpenAPIToolDescriptor[] = Array.from(
				{ length: 50 },
				(_, i) => ({
					id: `tool-${i}`,
					name: `tool${i}`,
					description: `Tool ${i}`,
					serviceId: `svc-${i}`,
					serviceName: `Service${i}`,
				}),
			);

			const summary = formatToolSummary(manyTools, 5);
			expect(summary).toContain("1. tool0");
			expect(summary).toContain("5. tool4");
			expect(summary).not.toContain("6. tool5");
		});

		it("should use default limit of 30", () => {
			const manyTools: OpenAPIToolDescriptor[] = Array.from(
				{ length: 40 },
				(_, i) => ({
					id: `tool-${i}`,
					name: `tool${i}`,
					description: `Tool ${i}`,
					serviceId: `svc-${i}`,
					serviceName: `Service${i}`,
				}),
			);

			const summary = formatToolSummary(manyTools);
			expect(summary).toContain("30. tool29");
			expect(summary).not.toContain("31. tool30");
		});

		it("should handle empty tool array", () => {
			const summary = formatToolSummary([]);
			expect(summary).toBe("");
		});
	});
});

/**
 * Create a minimal test state
 */
function createTestState(
	overrides: Partial<ApiAgentStateType> = {},
): ApiAgentStateType {
	return {
		messages: [],
		stage: "analyzing",
		taskDescription: undefined,
		context: undefined,
		availableTools: [],
		fabricApiUrl: undefined,
		userId: undefined,
		organizationId: undefined,
		selectedTool: undefined,
		toolArguments: undefined,
		executionResult: undefined,
		response: undefined,
		error: undefined,
		...overrides,
	};
}
