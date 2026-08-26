/**
 * Unit tests for API Agent Types Module
 */

import { describe, expect, it } from "vitest";
import type {
	A2AMessage,
	A2ATaskResult,
	ApiAgentStage,
	OpenAPIToolDescriptor,
	ToolExecutionResult,
} from "../types";

describe("Types Module", () => {
	describe("ApiAgentStage", () => {
		it("should support all stage values", () => {
			const stages: ApiAgentStage[] = [
				"analyzing",
				"executing",
				"formatting",
				"complete",
				"error",
			];
			expect(stages).toHaveLength(5);
		});
	});

	describe("OpenAPIToolDescriptor", () => {
		it("should allow creating a tool descriptor", () => {
			const tool: OpenAPIToolDescriptor = {
				id: "tool-123",
				name: "getUser",
				description: "Get user by ID",
				parameters: {
					type: "object",
					properties: {
						userId: { type: "string" },
					},
				},
				serviceId: "svc-1",
				serviceName: "UserService",
			};

			expect(tool.id).toBe("tool-123");
			expect(tool.name).toBe("getUser");
			expect(tool.serviceId).toBe("svc-1");
		});

		it("should allow optional description", () => {
			const tool: OpenAPIToolDescriptor = {
				id: "tool-123",
				name: "getUser",
				serviceId: "svc-1",
				serviceName: "UserService",
			};

			expect(tool.description).toBeUndefined();
		});

		it("should allow optional parameters", () => {
			const tool: OpenAPIToolDescriptor = {
				id: "tool-123",
				name: "getUser",
				serviceId: "svc-1",
				serviceName: "UserService",
			};

			expect(tool.parameters).toBeUndefined();
		});
	});

	describe("ToolExecutionResult", () => {
		it("should allow creating a success result", () => {
			const result: ToolExecutionResult = {
				success: true,
				data: { userId: 123, name: "John" },
				statusCode: 200,
				responseTime: 150,
			};

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ userId: 123, name: "John" });
		});

		it("should allow creating an error result", () => {
			const result: ToolExecutionResult = {
				success: false,
				error: "Not found",
				statusCode: 404,
				responseTime: 50,
			};

			expect(result.success).toBe(false);
			expect(result.error).toBe("Not found");
		});

		it("should allow optional headers", () => {
			const result: ToolExecutionResult = {
				success: true,
				responseTime: 100,
				headers: {
					"content-type": "application/json",
				},
			};

			expect(result.headers).toBeDefined();
		});
	});

	describe("A2AMessage", () => {
		it("should allow creating a user message", () => {
			const message: A2AMessage = {
				role: "user",
				content: "Get user by ID 123",
			};

			expect(message.role).toBe("user");
			expect(message.content).toBe("Get user by ID 123");
		});

		it("should allow creating an assistant message", () => {
			const message: A2AMessage = {
				role: "assistant",
				content: "Here is the user data",
			};

			expect(message.role).toBe("assistant");
		});

		it("should allow optional metadata", () => {
			const message: A2AMessage = {
				role: "user",
				content: "Test",
				metadata: { toolId: "tool-123" },
			};

			expect(message.metadata).toEqual({ toolId: "tool-123" });
		});
	});

	describe("A2ATaskResult", () => {
		it("should allow creating a pending result", () => {
			const result: A2ATaskResult = {
				taskId: "task-123",
				status: "pending",
			};

			expect(result.status).toBe("pending");
		});

		it("should allow creating a completed result", () => {
			const result: A2ATaskResult = {
				taskId: "task-123",
				status: "completed",
				response: "Task completed successfully",
			};

			expect(result.status).toBe("completed");
			expect(result.response).toBeDefined();
		});

		it("should allow creating a failed result", () => {
			const result: A2ATaskResult = {
				taskId: "task-123",
				status: "failed",
				error: "Task failed due to API error",
			};

			expect(result.status).toBe("failed");
			expect(result.error).toBeDefined();
		});

		it("should allow artifacts", () => {
			const result: A2ATaskResult = {
				taskId: "task-123",
				status: "completed",
				artifacts: [
					{
						id: "artifact-1",
						name: "response.json",
						mimeType: "application/json",
						parts: [{ type: "text", text: '{"key": "value"}' }],
					},
				],
			};

			expect(result.artifacts).toHaveLength(1);
			expect(result.artifacts?.[0].name).toBe("response.json");
		});

		it("should support all status values", () => {
			const statuses: A2ATaskResult["status"][] = [
				"pending",
				"running",
				"completed",
				"failed",
				"cancelled",
			];
			expect(statuses).toHaveLength(5);
		});
	});
});
