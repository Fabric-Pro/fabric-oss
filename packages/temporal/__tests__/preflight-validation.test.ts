/**
 * Preflight Validation Tests
 *
 * Tests to ensure validation rules work correctly for all node types.
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it, vi } from "vitest";
import {
	preflightValidation,
	validateWorkflowGraph,
} from "../src/activities/preflight-validation";

// Mock the database module
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		agentTask: {
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockResolvedValue({ id: "mock-task-id" }),
		},
	},
}));

vi.mock("@repo/database/prisma/queries/approvals", () => ({
	createApproval: vi.fn().mockResolvedValue({ id: "mock-approval-id" }),
	getApprovalStatus: vi.fn().mockResolvedValue(null),
}));

describe("Preflight Validation", () => {
	describe("ai-generate-text validation", () => {
		const baseInput = {
			executionId: "test-execution-123",
			stepId: "ai-generate-text-node-1",
			stepType: "ai-generate-text",
			userId: "user-123",
			organizationId: "org-123",
		};

		it("should pass validation when aiPrompt is provided (workflow builder format)", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					aiPrompt: "Generate a summary of the document",
					aiModel: "gpt-4o-mini",
				},
			});

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should pass validation when prompt is provided (SDK format)", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					prompt: "Generate a summary of the document",
				},
			});

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should pass validation when systemPrompt is provided", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					systemPrompt: "You are a helpful assistant",
				},
			});

			expect(result.valid).toBe(true);
			expect(result.issues).toHaveLength(0);
		});

		it("should fail validation when no prompt field is provided", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					aiModel: "gpt-4o-mini",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues).toHaveLength(1);
			expect(result.issues[0].field).toBe("prompt");
			expect(result.issues[0].message).toBe("Prompt is required");
		});

		it("should fail validation when aiPrompt is empty string", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					aiPrompt: "",
					aiModel: "gpt-4o-mini",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues[0].message).toBe("Prompt is required");
		});

		it("should warn about high temperature", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					aiPrompt: "Generate text",
					temperature: 1.5,
				},
			});

			expect(result.valid).toBe(true);
			expect(result.warnings.some((w) => w.includes("temperature"))).toBe(
				true,
			);
		});
	});

	describe("http-request validation", () => {
		const baseInput = {
			executionId: "test-execution-123",
			stepId: "http-request-node-1",
			stepType: "http-request",
			userId: "user-123",
		};

		it("should pass validation with valid URL", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					url: "https://api.example.com/data",
					method: "GET",
				},
			});

			expect(result.valid).toBe(true);
		});

		it("should fail validation without URL", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					method: "GET",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues[0].field).toBe("url");
		});

		it("should fail validation with invalid URL format", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					url: "not-a-valid-url",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues[0].message).toContain("http://");
		});
	});

	describe("slack-send validation", () => {
		const baseInput = {
			executionId: "test-execution-123",
			stepId: "slack-send-node-1",
			stepType: "slack-send",
			userId: "user-123",
		};

		it("should pass with slackChannel and slackMessage (workflow builder format)", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					slackChannel: "#general",
					slackMessage: "Hello world",
				},
			});

			expect(result.valid).toBe(true);
		});

		it("should pass with channel and message (SDK format)", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					channel: "#general",
					message: "Hello world",
				},
			});

			expect(result.valid).toBe(true);
		});

		it("should pass with channelId and text", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					channelId: "C1234567890",
					text: "Hello world",
				},
			});

			expect(result.valid).toBe(true);
		});

		it("should fail without channel", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					slackMessage: "Hello world",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues[0].field).toBe("channel");
		});

		it("should fail without message", async () => {
			const result = await preflightValidation({
				...baseInput,
				stepConfig: {
					slackChannel: "#general",
				},
			});

			expect(result.valid).toBe(false);
			expect(result.issues[0].field).toBe("message");
		});
	});

	describe("unknown step type", () => {
		it("should pass validation for unknown step types (no rules defined)", async () => {
			const result = await preflightValidation({
				executionId: "test-execution-123",
				stepId: "custom-node-1",
				stepType: "my-custom-step",
				stepConfig: {},
				userId: "user-123",
			});

			expect(result.valid).toBe(true);
		});
	});

	describe("risk assessment", () => {
		it("should assess high risk for http-request with external URL and POST method", async () => {
			const result = await preflightValidation({
				executionId: "test-execution-123",
				stepId: "http-request-node-1",
				stepType: "http-request",
				stepConfig: {
					url: "https://api.example.com/data",
					method: "POST",
				},
				userId: "user-123",
			});

			expect(result.riskAssessment).toBeDefined();
			expect(result.riskAssessment?.score).toBeGreaterThan(40);
			expect(result.riskAssessment?.factors.length).toBeGreaterThan(0);
		});

		it("should trigger approval requirement for high-risk steps when enabled", async () => {
			const result = await preflightValidation({
				executionId: "test-execution-123",
				stepId: "http-request-node-1",
				stepType: "http-request",
				stepConfig: {
					url: "https://api.example.com/data",
					method: "DELETE",
				},
				userId: "user-123",
				requireApprovalForHighRisk: true,
				approvalThreshold: 50,
				riskScore: 60,
			});

			expect(result.riskAssessment?.score).toBeGreaterThanOrEqual(50);
		});
	});
});

describe("Graph Validation", () => {
	describe("empty graph validation", () => {
		it("should fail for empty graph", async () => {
			const result = await validateWorkflowGraph({
				workflowId: "workflow-123",
				nodes: [],
				edges: [],
				userId: "user-123",
			});

			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Workflow has no nodes. Add at least one node to execute.",
			);
		});
	});

	describe("cycle detection", () => {
		it("should detect cycles in graph", async () => {
			const result = await validateWorkflowGraph({
				workflowId: "workflow-123",
				nodes: [
					{ id: "a", type: "trigger" },
					{ id: "b", type: "ai-generate-text" },
					{ id: "c", type: "slack-send" },
				],
				edges: [
					{ id: "e1", source: "a", target: "b" },
					{ id: "e2", source: "b", target: "c" },
					{ id: "e3", source: "c", target: "b" }, // Creates cycle
				],
				userId: "user-123",
			});

			expect(result.hasCycles).toBe(true);
			expect(result.valid).toBe(false);
		});

		it("should pass for acyclic graph", async () => {
			const result = await validateWorkflowGraph({
				workflowId: "workflow-123",
				nodes: [
					{ id: "a", type: "trigger" },
					{ id: "b", type: "ai-generate-text" },
					{ id: "c", type: "slack-send" },
				],
				edges: [
					{ id: "e1", source: "a", target: "b" },
					{ id: "e2", source: "b", target: "c" },
				],
				userId: "user-123",
			});

			expect(result.hasCycles).toBe(false);
			expect(result.valid).toBe(true);
		});
	});

	describe("orphaned nodes", () => {
		it("should warn about orphaned nodes", async () => {
			const result = await validateWorkflowGraph({
				workflowId: "workflow-123",
				nodes: [
					{ id: "a", type: "trigger" },
					{ id: "b", type: "ai-generate-text" },
					{ id: "c", type: "slack-send" }, // Orphaned - not connected
				],
				edges: [{ id: "e1", source: "a", target: "b" }],
				userId: "user-123",
			});

			expect(result.orphanedNodes).toContain("c");
			expect(
				result.warnings.some((w) => w.includes("not connected")),
			).toBe(true);
		});
	});

	describe("execution order", () => {
		it("should compute correct execution order", async () => {
			const result = await validateWorkflowGraph({
				workflowId: "workflow-123",
				nodes: [
					{ id: "trigger", type: "trigger" },
					{ id: "generate", type: "ai-generate-text" },
					{ id: "send", type: "slack-send" },
				],
				edges: [
					{ id: "e1", source: "trigger", target: "generate" },
					{ id: "e2", source: "generate", target: "send" },
				],
				userId: "user-123",
			});

			expect(result.executionOrder).toEqual([
				"trigger",
				"generate",
				"send",
			]);
		});
	});
});
