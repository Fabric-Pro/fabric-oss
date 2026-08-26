/**
 * Tests for Deployment Execution Workflow
 *
 * Tests the workflow types, context building, and activity logic.
 * Full workflow integration tests require Temporal's test server.
 *
 * Run with: pnpm --filter @repo/temporal test
 */

import { describe, expect, it } from "vitest";
import {
	buildAgentExecutionContext,
	buildSystemPrompt,
	buildUserInputContext,
	type ConnectionMappings,
	extractMcpConfigIds,
	type InstanceConfig,
	type TemplateConfig,
} from "../src/activities/agent-execution-core";
import type {
	DeploymentExecutionInput,
	DeploymentExecutionOutput,
	ExecutionProgress,
} from "../src/workflows/deployment-execution";

// =============================================================================
// WORKFLOW INPUT/OUTPUT TYPES
// =============================================================================

describe("Deployment Execution Workflow Types", () => {
	describe("DeploymentExecutionInput", () => {
		it("should accept valid input with all required fields", () => {
			const input: DeploymentExecutionInput = {
				executionId: "exec-123",
				deploymentId: "deploy-456",
				instanceId: "instance-789",
				userId: "user-abc",
				input: { message: "Hello agent" },
				triggerType: "manual",
				timeoutMs: 30000,
			};

			expect(input.executionId).toBe("exec-123");
			expect(input.deploymentId).toBe("deploy-456");
			expect(input.triggerType).toBe("manual");
		});

		it("should accept input with optional organization context", () => {
			const input: DeploymentExecutionInput = {
				executionId: "exec-123",
				deploymentId: "deploy-456",
				instanceId: "instance-789",
				userId: "user-abc",
				organizationId: "org-xyz",
				input: { message: "Hello agent" },
				triggerType: "webhook",
				triggerId: "trigger-001",
				timeoutMs: 60000,
				supervisorWorkflowId: "agent-supervisor-deploy-456",
			};

			expect(input.organizationId).toBe("org-xyz");
			expect(input.triggerId).toBe("trigger-001");
			expect(input.supervisorWorkflowId).toBe(
				"agent-supervisor-deploy-456",
			);
		});

		it("should accept input with conversation ID for multi-turn", () => {
			const input: DeploymentExecutionInput = {
				executionId: "exec-123",
				deploymentId: "deploy-456",
				instanceId: "instance-789",
				userId: "user-abc",
				input: { message: "Follow up question" },
				triggerType: "manual",
				timeoutMs: 30000,
				conversationId: "conv-999",
			};

			expect(input.conversationId).toBe("conv-999");
		});
	});

	describe("DeploymentExecutionOutput", () => {
		it("should represent successful execution", () => {
			const output: DeploymentExecutionOutput = {
				executionId: "exec-123",
				status: "COMPLETED",
				output: {
					response: "Here is your analysis...",
					toolCalls: [{ name: "execute-sql", result: { rows: 10 } }],
				},
				durationMs: 5000,
				tokenUsage: {
					inputTokens: 1500,
					outputTokens: 800,
				},
			};

			expect(output.status).toBe("COMPLETED");
			expect(output.output?.response).toBeDefined();
			expect(output.tokenUsage?.inputTokens).toBe(1500);
		});

		it("should represent failed execution", () => {
			const output: DeploymentExecutionOutput = {
				executionId: "exec-123",
				status: "FAILED",
				error: "Database connection failed",
				durationMs: 1200,
			};

			expect(output.status).toBe("FAILED");
			expect(output.error).toBe("Database connection failed");
			expect(output.output).toBeUndefined();
		});

		it("should represent cancelled execution", () => {
			const output: DeploymentExecutionOutput = {
				executionId: "exec-123",
				status: "CANCELLED",
				error: "User cancelled execution",
				durationMs: 500,
			};

			expect(output.status).toBe("CANCELLED");
		});
	});

	describe("ExecutionProgress", () => {
		it("should track initialization phase", () => {
			const progress: ExecutionProgress = {
				phase: "initializing",
				message: "Initializing execution...",
				completedToolCalls: [],
				updatedAt: Date.now(),
			};

			expect(progress.phase).toBe("initializing");
			expect(progress.completedToolCalls).toHaveLength(0);
		});

		it("should track knowledge fetch progress", () => {
			const progress: ExecutionProgress = {
				phase: "fetching_knowledge",
				message: "Fetching knowledge from 3 source(s)...",
				completedToolCalls: [],
				knowledgeProgress: {
					totalSources: 3,
					fetchedSources: 1,
					totalChunks: 15,
				},
				updatedAt: Date.now(),
			};

			expect(progress.phase).toBe("fetching_knowledge");
			expect(progress.knowledgeProgress?.totalSources).toBe(3);
			expect(progress.knowledgeProgress?.totalChunks).toBe(15);
		});

		it("should track tool calls during execution", () => {
			const progress: ExecutionProgress = {
				phase: "executing_agent",
				message: "Executing agent with claude-sonnet-4...",
				currentToolCall: {
					name: "execute-sql",
					startedAt: Date.now() - 2000,
				},
				completedToolCalls: [{ name: "search", durationMs: 500 }],
				updatedAt: Date.now(),
			};

			expect(progress.phase).toBe("executing_agent");
			expect(progress.currentToolCall?.name).toBe("execute-sql");
			expect(progress.completedToolCalls).toHaveLength(1);
		});
	});
});

// =============================================================================
// CONTEXT BUILDER TESTS
// =============================================================================

describe("Agent Execution Context Builder", () => {
	const mockTemplate: TemplateConfig = {
		id: "template-1",
		name: "sql-expert",
		displayName: "SQL Expert",
		description: "A SQL specialist that helps with database queries",
		instructions: [
			"## Role",
			"You are a SQL expert who helps users analyze data.",
			"",
			"## Company Context",
			"Acme Corp sells widgets globally.",
			"",
			"## Process",
			"- Understand the user's question",
			"- Write optimized SQL",
			"- Explain the results",
			"",
			"## Output Format",
			"Always explain your SQL queries step by step.",
		].join("\n"),
		knowledgeSources: ["DATABASE"],
		tools: ["execute-sql", "search"],
		suggestedModel: "anthropic/claude-sonnet-4-20250514",
	};

	const mockInstance: InstanceConfig = {
		id: "instance-1",
		name: "My SQL Expert",
		description: "Configured for our sales database",
		customInstructions: {
			additionalContext: "Focus on sales metrics and revenue analysis.",
		},
		modelOverride: null,
		modelConfig: null,
	};

	const mockConnections: ConnectionMappings = {
		integrationConfigurations: [
			{
				integrationId: "integration-db-123",
				integrationType: "DATABASE",
			},
		],
		toolConnections: {
			"execute-sql": {
				type: "mcp",
				configId: "mcp-config-456",
				connectionId: "db-conn-789",
			},
			search: {
				type: "builtin",
			},
		},
		workspaceIds: ["workspace-1", "workspace-2"],
	};

	describe("buildSystemPrompt", () => {
		it("should build prompt with template instructions", () => {
			const prompt = buildSystemPrompt(mockTemplate, mockInstance);

			expect(prompt).toContain("# SQL Expert");
			expect(prompt).toContain("A SQL specialist");
			expect(prompt).toContain("## Role");
			expect(prompt).toContain("You are a SQL expert");
			expect(prompt).toContain("## Company Context");
			expect(prompt).toContain("Acme Corp");
			expect(prompt).toContain("## Process");
			expect(prompt).toContain("Understand the user's question");
			expect(prompt).toContain("## Output Format");
		});

		it("should include custom instructions from instance", () => {
			const prompt = buildSystemPrompt(mockTemplate, mockInstance);

			expect(prompt).toContain("## Additional Context");
			expect(prompt).toContain("Focus on sales metrics");
		});

		it("should include instance description", () => {
			const prompt = buildSystemPrompt(mockTemplate, mockInstance);

			expect(prompt).toContain("## Instance Notes");
			expect(prompt).toContain("Configured for our sales database");
		});

		it("should handle template without instructions", () => {
			const simpleTemplate: TemplateConfig = {
				...mockTemplate,
				instructions: "",
			};

			const prompt = buildSystemPrompt(simpleTemplate, mockInstance);

			expect(prompt).toContain("# SQL Expert");
			expect(prompt).toContain("A SQL specialist");
			// Should not contain section headers from template
			expect(prompt).not.toContain("## Role\nYou are a SQL expert");
		});
	});

	describe("buildAgentExecutionContext", () => {
		it("should build complete execution context", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-123",
				"org-456",
			);

			expect(context.systemPrompt).toContain("SQL Expert");
			expect(context.model).toBe("anthropic/claude-sonnet-4-20250514");
			expect(context.tools).toHaveLength(2);
			expect(context.knowledgeSources).toHaveLength(1);
			expect(context.workspaceIds).toEqual([
				"workspace-1",
				"workspace-2",
			]);
			expect(context.userId).toBe("user-123");
			expect(context.organizationId).toBe("org-456");
		});

		it("should use model override from instance", () => {
			const instanceWithOverride: InstanceConfig = {
				...mockInstance,
				modelOverride: "anthropic/claude-opus-4-20250514",
			};

			const context = buildAgentExecutionContext(
				mockTemplate,
				instanceWithOverride,
				mockConnections,
				"user-123",
			);

			expect(context.model).toBe("anthropic/claude-opus-4-20250514");
		});

		it("should use default model when none specified", () => {
			const templateNoModel: TemplateConfig = {
				...mockTemplate,
				suggestedModel: null,
			};

			const context = buildAgentExecutionContext(
				templateNoModel,
				mockInstance,
				mockConnections,
				"user-123",
			);

			// DEFAULT_MODELS.CHAT from ai-model-catalog.ts
			expect(context.model).toBe("gpt-4o");
		});

		it("should map tools correctly", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-123",
			);

			const sqlTool = context.tools.find((t) => t.name === "execute-sql");
			const searchTool = context.tools.find((t) => t.name === "search");

			expect(sqlTool?.type).toBe("mcp");
			expect(sqlTool?.configId).toBe("mcp-config-456");
			expect(searchTool?.type).toBe("builtin");
		});

		it("should map knowledge sources correctly", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-123",
			);

			expect(context.knowledgeSources).toHaveLength(1);
			expect(context.knowledgeSources[0].type).toBe("database");
			expect(context.knowledgeSources[0].integrationId).toBe(
				"integration-db-123",
			);
		});
	});

	describe("extractMcpConfigIds", () => {
		it("should extract MCP config IDs from tools", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-123",
			);

			const mcpConfigIds = extractMcpConfigIds(context.tools);

			expect(mcpConfigIds).toHaveLength(1);
			expect(mcpConfigIds).toContain("mcp-config-456");
		});

		it("should return empty array when no MCP tools", () => {
			const connectionsNoMcp: ConnectionMappings = {
				...mockConnections,
				toolConnections: {
					search: { type: "builtin" },
				},
			};

			const context = buildAgentExecutionContext(
				{ ...mockTemplate, tools: ["search"] },
				mockInstance,
				connectionsNoMcp,
				"user-123",
			);

			const mcpConfigIds = extractMcpConfigIds(context.tools);

			expect(mcpConfigIds).toHaveLength(0);
		});

		it("should deduplicate config IDs", () => {
			const connectionsMultipleMcp: ConnectionMappings = {
				...mockConnections,
				toolConnections: {
					"execute-sql": { type: "mcp", configId: "shared-mcp" },
					"run-query": { type: "mcp", configId: "shared-mcp" },
				},
			};

			const templateMultiTools: TemplateConfig = {
				...mockTemplate,
				tools: ["execute-sql", "run-query"],
			};

			const context = buildAgentExecutionContext(
				templateMultiTools,
				mockInstance,
				connectionsMultipleMcp,
				"user-123",
			);

			const mcpConfigIds = extractMcpConfigIds(context.tools);

			expect(mcpConfigIds).toHaveLength(1);
			expect(mcpConfigIds[0]).toBe("shared-mcp");
		});
	});

	describe("buildUserInputContext", () => {
		it("should extract message field", () => {
			const result = buildUserInputContext({
				message: "What are our sales?",
			});
			expect(result).toBe("What are our sales?");
		});

		it("should extract prompt field", () => {
			const result = buildUserInputContext({ prompt: "Analyze revenue" });
			expect(result).toBe("Analyze revenue");
		});

		it("should extract query field", () => {
			const result = buildUserInputContext({
				query: "Show me top customers",
			});
			expect(result).toBe("Show me top customers");
		});

		it("should prefer message over prompt over query", () => {
			const result = buildUserInputContext({
				message: "Message wins",
				prompt: "Prompt loses",
				query: "Query loses",
			});
			expect(result).toBe("Message wins");
		});

		it("should fallback to JSON for unknown structure", () => {
			const result = buildUserInputContext({
				customField: "value",
				anotherField: 123,
			});

			const parsed = JSON.parse(result);
			expect(parsed.customField).toBe("value");
			expect(parsed.anotherField).toBe(123);
		});
	});
});

// =============================================================================
// TENANT ISOLATION TESTS
// =============================================================================

describe("Tenant Isolation", () => {
	describe("Context Builder Tenant Tracking", () => {
		const mockTemplate: TemplateConfig = {
			id: "t1",
			name: "test",
			displayName: "Test",
			description: "Test template",
			instructions: "",
			knowledgeSources: [],
			tools: [],
			suggestedModel: null,
		};

		const mockInstance: InstanceConfig = {
			id: "i1",
			name: "Test Instance",
			description: null,
			customInstructions: null,
			modelOverride: null,
			modelConfig: null,
		};

		const mockConnections: ConnectionMappings = {
			integrationConfigurations: [],
			toolConnections: {},
			workspaceIds: [],
		};

		it("should include userId in context", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-personal-123",
			);

			expect(context.userId).toBe("user-personal-123");
			expect(context.organizationId).toBeUndefined();
		});

		it("should include organizationId when in org context", () => {
			const context = buildAgentExecutionContext(
				mockTemplate,
				mockInstance,
				mockConnections,
				"user-123",
				"org-456",
			);

			expect(context.userId).toBe("user-123");
			expect(context.organizationId).toBe("org-456");
		});
	});
});

// =============================================================================
// INTEGRATION TEST SCENARIOS (for manual testing)
// =============================================================================

describe("Integration Test Scenarios", () => {
	it.skip("Manual Test: Create template instance with missing integration", () => {
		// This test documents the expected behavior
		// Run manually via API:
		//
		// 1. Create a template that requires DATABASE integration
		// 2. Try to create instance WITHOUT providing knowledgeConnections.DATABASE
		// 3. Should fail with: "Missing required data source connections: DATABASE"
	});

	it.skip("Manual Test: Deploy instance and execute", () => {
		// This test documents the full flow
		// Run manually via API:
		//
		// 1. Create template with knowledgeSources: ["DATABASE"]
		// 2. Create instance with knowledgeConnections: { DATABASE: "<integration-id>" }
		// 3. Deploy the instance
		// 4. Execute via: agentDeployments.execute({ deploymentId, input: { message: "..." } })
		// 5. Query progress via Temporal: deploymentProgressQuery
		// 6. Verify execution completes with response
	});

	it.skip("Manual Test: Multi-turn conversation", () => {
		// This test documents multi-turn behavior
		// Run manually via API:
		//
		// 1. Deploy an agent instance
		// 2. Create conversation: createTemplateConversation({ instanceId, userId })
		// 3. Execute with conversationId
		// 4. Execute again with same conversationId
		// 5. Verify second execution has access to first message history
	});
});
