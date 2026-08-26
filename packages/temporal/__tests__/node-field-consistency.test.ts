/**
 * Node Field Consistency Tests
 *
 * These tests ensure that:
 * 1. Validation rules match workflow builder node definitions
 * 2. Step implementations use the same field names
 * 3. All required fields are properly validated
 *
 * This prevents the issue where validation fails because field names
 * don't match between the UI and the validation logic.
 */

import { describe, expect, it, vi } from "vitest";
import {
	getNodeFieldDefinition,
	hasValidFieldValue,
	NODE_FIELD_DEFINITIONS,
	validateNodeFields,
} from "../src/activities/lib/node-field-mappings";

// Mock the database module before importing validation
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

// Import the actual validation to compare
import { preflightValidation } from "../src/activities/preflight-validation";

describe("Node Field Mappings", () => {
	describe("getNodeFieldDefinition", () => {
		it("should return definition for known node types", () => {
			expect(getNodeFieldDefinition("ai-generate-text")).toBeDefined();
			expect(getNodeFieldDefinition("http-request")).toBeDefined();
			expect(getNodeFieldDefinition("slack-send")).toBeDefined();
		});

		it("should return undefined for unknown node types", () => {
			expect(getNodeFieldDefinition("unknown-node-type")).toBeUndefined();
		});
	});

	describe("hasValidFieldValue", () => {
		it("should find value using primary field name", () => {
			const config = { aiPrompt: "Hello world" };
			const field = {
				primary: "aiPrompt",
				aliases: ["prompt", "systemPrompt"],
				label: "Prompt",
				required: true,
			};
			expect(hasValidFieldValue(config, field)).toBe(true);
		});

		it("should find value using alias field name", () => {
			const config = { prompt: "Hello world" };
			const field = {
				primary: "aiPrompt",
				aliases: ["prompt", "systemPrompt"],
				label: "Prompt",
				required: true,
			};
			expect(hasValidFieldValue(config, field)).toBe(true);
		});

		it("should reject empty strings", () => {
			const config = { aiPrompt: "" };
			const field = {
				primary: "aiPrompt",
				aliases: ["prompt"],
				label: "Prompt",
				required: true,
			};
			expect(hasValidFieldValue(config, field)).toBe(false);
		});

		it("should reject whitespace-only strings", () => {
			const config = { aiPrompt: "   " };
			const field = {
				primary: "aiPrompt",
				aliases: ["prompt"],
				label: "Prompt",
				required: true,
			};
			expect(hasValidFieldValue(config, field)).toBe(false);
		});
	});

	describe("validateNodeFields", () => {
		it("should pass for valid ai-generate-text config", () => {
			const result = validateNodeFields("ai-generate-text", {
				aiPrompt: "Generate a summary",
			});
			expect(result.valid).toBe(true);
			expect(result.missingFields).toHaveLength(0);
		});

		it("should fail for missing required fields", () => {
			const result = validateNodeFields("ai-generate-text", {
				aiModel: "gpt-4",
			});
			expect(result.valid).toBe(false);
			expect(result.missingFields).toContain("Prompt");
		});

		it("should pass for unknown node types", () => {
			const result = validateNodeFields("custom-node", {});
			expect(result.valid).toBe(true);
		});
	});
});

describe("Validation Consistency", () => {
	/**
	 * This test ensures that the preflight validation accepts the same
	 * field names that are defined in NODE_FIELD_DEFINITIONS
	 */
	describe("ai-generate-text", () => {
		const definition = getNodeFieldDefinition("ai-generate-text");
		expect(definition).toBeDefined();
		// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: test asserts definition is defined on the previous line
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by the expect above
		const promptField = definition?.requiredFields.find(
			(f) => f.primary === "aiPrompt",
		)!;

		it("should have prompt field defined", () => {
			expect(promptField).toBeDefined();
		});

		it("preflight validation should accept primary field name", async () => {
			const result = await preflightValidation({
				executionId: "test",
				stepId: "test-node",
				stepType: "ai-generate-text",
				stepConfig: { [promptField.primary]: "test prompt" },
				userId: "user-123",
			});
			expect(result.valid).toBe(true);
		});

		it("preflight validation should accept all alias field names", async () => {
			for (const alias of promptField.aliases) {
				const result = await preflightValidation({
					executionId: "test",
					stepId: "test-node",
					stepType: "ai-generate-text",
					stepConfig: { [alias]: "test prompt" },
					userId: "user-123",
				});
				expect(result.valid).toBe(true);
			}
		});
	});

	describe("slack-send", () => {
		const definition = getNodeFieldDefinition("slack-send");
		expect(definition).toBeDefined();
		// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: test asserts definition is defined on the previous line
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by the expect above
		const channelField = definition?.requiredFields.find(
			(f) => f.primary === "slackChannel",
		)!;
		// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: test asserts definition is defined on the previous line
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by the expect above
		const messageField = definition?.requiredFields.find(
			(f) => f.primary === "slackMessage",
		)!;

		it("should have channel and message fields defined", () => {
			expect(channelField).toBeDefined();
			expect(messageField).toBeDefined();
		});

		it("preflight validation should accept primary field names", async () => {
			const result = await preflightValidation({
				executionId: "test",
				stepId: "test-node",
				stepType: "slack-send",
				stepConfig: {
					[channelField.primary]: "#general",
					[messageField.primary]: "Hello",
				},
				userId: "user-123",
			});
			expect(result.valid).toBe(true);
		});

		it("preflight validation should accept alias field names", async () => {
			// Test with channel alias and message alias
			const result = await preflightValidation({
				executionId: "test",
				stepId: "test-node",
				stepType: "slack-send",
				stepConfig: {
					channel: "#general",
					text: "Hello",
				},
				userId: "user-123",
			});
			expect(result.valid).toBe(true);
		});
	});

	describe("linear-create-ticket", () => {
		const definition = getNodeFieldDefinition("linear-create-ticket");
		expect(definition).toBeDefined();
		// biome-ignore lint/suspicious/noNonNullAssertedOptionalChain: test asserts definition is defined on the previous line
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by the expect above
		const titleField = definition?.requiredFields.find(
			(f) => f.primary === "ticketTitle",
		)!;

		it("should have title field defined", () => {
			expect(titleField).toBeDefined();
		});

		it("preflight validation should accept primary field name", async () => {
			const result = await preflightValidation({
				executionId: "test",
				stepId: "test-node",
				stepType: "linear-create-ticket",
				stepConfig: { [titleField.primary]: "Bug fix" },
				userId: "user-123",
			});
			expect(result.valid).toBe(true);
		});

		it("preflight validation should accept alias field names", async () => {
			for (const alias of titleField.aliases) {
				const result = await preflightValidation({
					executionId: "test",
					stepId: "test-node",
					stepType: "linear-create-ticket",
					stepConfig: { [alias]: "Bug fix" },
					userId: "user-123",
				});
				expect(result.valid).toBe(true);
			}
		});
	});
});

describe("NODE_FIELD_DEFINITIONS completeness", () => {
	/**
	 * Ensure all node types that have validation rules also have field definitions
	 */
	const nodeTypesWithValidation = [
		"trigger",
		"ai-generate-text",
		"http-request",
		"slack-send",
		"linear-create-ticket",
		"browser-automation",
	];

	for (const nodeType of nodeTypesWithValidation) {
		it(`should have field definition for ${nodeType}`, () => {
			const definition = getNodeFieldDefinition(nodeType);
			expect(definition).toBeDefined();
			expect(definition?.nodeType).toBe(nodeType);
		});
	}

	/**
	 * Ensure all field definitions have non-empty labels
	 */
	it("all field definitions should have labels", () => {
		for (const nodeDef of NODE_FIELD_DEFINITIONS) {
			for (const field of nodeDef.requiredFields) {
				expect(field.label).toBeDefined();
				expect(field.label.length).toBeGreaterThan(0);
			}
			for (const field of nodeDef.optionalFields || []) {
				expect(field.label).toBeDefined();
				expect(field.label.length).toBeGreaterThan(0);
			}
		}
	});

	/**
	 * Ensure primary field names are unique per node type
	 */
	it("primary field names should be unique per node type", () => {
		for (const nodeDef of NODE_FIELD_DEFINITIONS) {
			const allFields = [
				...nodeDef.requiredFields,
				...(nodeDef.optionalFields || []),
			];
			const primaryNames = allFields.map((f) => f.primary);
			const uniqueNames = new Set(primaryNames);
			expect(primaryNames.length).toBe(uniqueNames.size);
		}
	});
});

describe("Simulated Workflow Builder Scenarios", () => {
	/**
	 * These tests simulate real workflow builder usage scenarios
	 * to ensure the validation works end-to-end
	 */

	it("should validate a typical AI text generation workflow node", async () => {
		// Simulate what the workflow builder saves
		const nodeConfig = {
			aiPrompt: "Summarize the following article: {{Scrape.content}}",
			aiModel: "openai/gpt-4o-mini",
			aiFormat: "text",
		};

		const result = await preflightValidation({
			executionId: "workflow-123",
			stepId: "ai-generate-text-abc",
			stepType: "ai-generate-text",
			stepConfig: nodeConfig,
			userId: "user-123",
		});

		expect(result.valid).toBe(true);
	});

	it("should validate a typical Slack notification workflow node", async () => {
		const nodeConfig = {
			slackChannel: "#notifications",
			slackMessage: "New summary ready: {{GenerateText.text}}",
		};

		const result = await preflightValidation({
			executionId: "workflow-123",
			stepId: "slack-send-xyz",
			stepType: "slack-send",
			stepConfig: nodeConfig,
			userId: "user-123",
		});

		expect(result.valid).toBe(true);
	});

	it("should validate a typical HTTP request workflow node", async () => {
		const nodeConfig = {
			url: "https://api.example.com/webhook",
			method: "POST",
			body: "{{GenerateText.text}}",
		};

		const result = await preflightValidation({
			executionId: "workflow-123",
			stepId: "http-request-123",
			stepType: "http-request",
			stepConfig: nodeConfig,
			userId: "user-123",
		});

		expect(result.valid).toBe(true);
	});

	it("should fail validation when prompt field uses template but is empty", async () => {
		const nodeConfig = {
			aiPrompt: "", // User cleared the prompt
			aiModel: "openai/gpt-4o-mini",
		};

		const result = await preflightValidation({
			executionId: "workflow-123",
			stepId: "ai-generate-text-abc",
			stepType: "ai-generate-text",
			stepConfig: nodeConfig,
			userId: "user-123",
		});

		expect(result.valid).toBe(false);
		expect(result.issues.some((i) => i.message.includes("Prompt"))).toBe(
			true,
		);
	});
});
