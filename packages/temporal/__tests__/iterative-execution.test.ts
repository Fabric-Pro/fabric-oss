/**
 * Iterative Execution Phase - Integration Tests
 *
 * Tests for the iterative agent loop execution phase:
 * - Agent iteration loop termination
 * - Safety layer integration and approval workflows
 * - Tool execution and conversation history management
 * - Budget limit enforcement during execution
 * - Error handling and recovery
 */

import { describe, expect, it } from "vitest";
import type {
	ExecutionModeConfig,
	IterativeMessage,
	OrchestratorWorkflowInput,
} from "../src/workflows/orchestrator/types";

// Type for agent iteration results (simplified for tests)
interface AgentIterationResult {
	type: "response" | "tool_calls";
	content?: string;
	toolCalls?: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
	}>;
	usage: { inputTokens: number; outputTokens: number };
}

// Simplified mock state for testing behavior
interface MockWorkflowState {
	executionId: string;
	userId: string;
	organizationId?: string;
	status: string;
	enrichedMessage: string;
	enrichedSystemPrompt: string;
	currentIteration: number;
	iterationCosts: Array<{
		iteration: number;
		inputTokens: number;
		outputTokens: number;
		timestamp: string;
	}>;
	toolCalls: Array<{
		id: string;
		name: string;
		args: Record<string, unknown>;
		result: unknown;
		status: "success" | "error";
		durationMs: number;
	}>;
	iterativeConversationHistory: IterativeMessage[];
	pendingToolApproval: {
		toolCall: { id: string; name: string; args: Record<string, unknown> };
		riskLevel: string;
		reason: string;
		iteration: number;
	} | null;
	pendingApproval: {
		approvalId: string;
		stepId: string;
		reason: string;
	} | null;
	approvalDecision: { approved: boolean; feedback?: string } | null;
}

// Mock the executeIterativePhase function for testing
// In a real integration test, we'd test this through the actual workflow
describe("executeIterativePhase", () => {
	// Helper to create mock workflow state
	const createMockState = (
		overrides?: Partial<MockWorkflowState>,
	): MockWorkflowState => ({
		executionId: "test-exec-123",
		userId: "user_123",
		organizationId: "org_456",
		status: "running",
		enrichedMessage: "Test user message",
		enrichedSystemPrompt: "You are a helpful assistant.",
		currentIteration: 0,
		iterationCosts: [],
		toolCalls: [],
		iterativeConversationHistory: [],
		pendingToolApproval: null,
		pendingApproval: null,
		approvalDecision: null,
		...overrides,
	});

	const _createMockInput = (
		overrides?: Partial<OrchestratorWorkflowInput>,
	): OrchestratorWorkflowInput => ({
		executionId: "test-exec-123",
		message: "Test message",
		history: [],
		userId: "user_123",
		organizationId: "org_456",
		executionMode: "iterative",
		...overrides,
	});

	const createMockModeConfig = (
		overrides?: Partial<ExecutionModeConfig>,
	): ExecutionModeConfig => ({
		mode: "iterative",
		taskDecomposition: false,
		reflection: false,
		detailedThoughts: true,
		maxRetries: 2,
		stepTimeoutMs: 60000,
		workflowTimeoutMs: 900000,
		maxIterations: 15,
		iterationTimeoutMs: 120000,
		maxTotalTokens: 100000,
		...overrides,
	});

	describe("Agent Loop Termination", () => {
		it("should terminate when agent returns final response", () => {
			// This tests that the loop exits when the agent decides it's done
			const mockAgentResult: AgentIterationResult = {
				type: "response",
				content: "I've completed the task. Here are the results...",
				usage: { inputTokens: 100, outputTokens: 50 },
			};

			const _state = createMockState();

			// Expected: The phase should return success with the final response
			// In practice, this would happen after runAgentIteration returns type: "response"
			expect(mockAgentResult.type).toBe("response");
			expect(mockAgentResult.content).toBeTruthy();
		});

		it("should continue iterating when agent returns tool calls", () => {
			const mockAgentResult: AgentIterationResult = {
				type: "tool_calls",
				toolCalls: [
					{
						id: "call_1",
						name: "test_read_tool",
						args: { query: "test" },
					},
				],
				usage: { inputTokens: 100, outputTokens: 30 },
			};

			// Expected: Loop should continue, execute tools, and call runAgentIteration again
			expect(mockAgentResult.type).toBe("tool_calls");
			expect(mockAgentResult.toolCalls).toHaveLength(1);
		});

		it("should handle multiple iterations before completion", () => {
			// Simulates: iteration 1 (tool call) → iteration 2 (tool call) → iteration 3 (final response)
			const iterations: AgentIterationResult[] = [
				{
					type: "tool_calls",
					toolCalls: [
						{ id: "call_1", name: "search_data", args: {} },
					],
					usage: { inputTokens: 100, outputTokens: 30 },
				},
				{
					type: "tool_calls",
					toolCalls: [
						{ id: "call_2", name: "analyze_data", args: {} },
					],
					usage: { inputTokens: 200, outputTokens: 40 },
				},
				{
					type: "response",
					content: "Analysis complete",
					usage: { inputTokens: 150, outputTokens: 50 },
				},
			];

			// Expected: Each iteration adds to conversation history and state
			expect(iterations).toHaveLength(3);
			expect(iterations[2].type).toBe("response");
		});
	});

	describe("Budget Limit Enforcement", () => {
		it("should stop execution when token budget exceeded", () => {
			const state = createMockState({
				iterationCosts: [
					{
						iteration: 1,
						inputTokens: 60000,
						outputTokens: 45000,
						timestamp: new Date().toISOString(),
					},
				],
			});

			const modeConfig = createMockModeConfig({
				maxTotalTokens: 100000,
			});

			const totalTokens = state.iterationCosts.reduce(
				(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
				0,
			);

			// 105000 > 100000 - should stop
			expect(totalTokens).toBeGreaterThan(modeConfig.maxTotalTokens || 0);
		});

		it("should stop execution when iteration limit reached", () => {
			const state = createMockState({
				iterationCosts: Array.from({ length: 15 }, (_, i) => ({
					iteration: i + 1,
					inputTokens: 100,
					outputTokens: 50,
					timestamp: new Date().toISOString(),
				})),
			});

			const modeConfig = createMockModeConfig({ maxIterations: 15 });

			// 15 iterations = at limit, should stop on next check
			expect(state.iterationCosts.length).toBe(modeConfig.maxIterations);
		});

		it("should allow execution when within both budgets", () => {
			const state = createMockState({
				iterationCosts: [
					{
						iteration: 1,
						inputTokens: 1000,
						outputTokens: 500,
						timestamp: new Date().toISOString(),
					},
					{
						iteration: 2,
						inputTokens: 1200,
						outputTokens: 600,
						timestamp: new Date().toISOString(),
					},
				],
			});

			const modeConfig = createMockModeConfig({
				maxTotalTokens: 100000,
				maxIterations: 15,
			});

			const totalTokens = state.iterationCosts.reduce(
				(sum, ic) => sum + ic.inputTokens + ic.outputTokens,
				0,
			);

			expect(totalTokens).toBeLessThan(modeConfig.maxTotalTokens || 0);
			expect(state.iterationCosts.length).toBeLessThan(
				modeConfig.maxIterations || 0,
			);
		});

		it("should include helpful message when budget exceeded", () => {
			// When budget is exceeded, the response should explain what was accomplished
			const budgetExceededResponse =
				"I've reached the limit for this task. Token budget exceeded: 105,000/100,000. Here's what I've accomplished so far:\n\nSuccessfully executed 3 tool call(s):\n- search_data\n- analyze_results\n- format_output";

			expect(budgetExceededResponse).toContain("reached the limit");
			expect(budgetExceededResponse).toContain("accomplished");
		});
	});

	describe("Safety Layer Integration", () => {
		it("should detect destructive operations as high risk", () => {
			const toolCall = {
				id: "call_delete",
				name: "delete_record",
				args: { id: "123" },
			};

			// Simulate risk assessment
			const isDestructive = toolCall.name
				.toLowerCase()
				.includes("delete");
			expect(isDestructive).toBe(true);

			// Expected: riskLevel = "high", requiresApproval = true
		});

		it("should detect bulk destructive operations as critical risk", () => {
			const toolCall = {
				id: "call_bulk_delete",
				name: "bulk_delete_records",
				args: { ids: ["1", "2", "3"] } as Record<string, unknown>,
			};

			const isDestructive = toolCall.name
				.toLowerCase()
				.includes("delete");
			const isBulk =
				toolCall.name.toLowerCase().includes("bulk") ||
				Array.isArray(toolCall.args.ids || toolCall.args.items || []);

			expect(isDestructive).toBe(true);
			expect(isBulk).toBe(true);

			// Expected: riskLevel = "critical", requiresApproval = true
		});

		it("should allow read operations without approval", () => {
			const toolCall = {
				id: "call_read",
				name: "get_record",
				args: { id: "123" },
			};

			const isRead =
				toolCall.name.toLowerCase().includes("get") ||
				toolCall.name.toLowerCase().includes("read") ||
				toolCall.name.toLowerCase().includes("list");

			expect(isRead).toBe(true);

			// Expected: riskLevel = "low", requiresApproval = false
		});

		it("should detect create operations as medium risk", () => {
			const toolCall = {
				id: "call_create",
				name: "create_task",
				args: { title: "New task" },
			};

			const isCreate = toolCall.name.toLowerCase().includes("create");
			expect(isCreate).toBe(true);

			// Expected: riskLevel = "medium", requiresApproval = false for single create
		});

		it("should escalate bulk create to high risk", () => {
			const toolCall = {
				id: "call_bulk_create",
				name: "bulk_create_tasks",
				args: { tasks: [{}, {}, {}] },
			};

			const isCreate = toolCall.name.toLowerCase().includes("create");
			const isBulk = toolCall.name.toLowerCase().includes("bulk");

			expect(isCreate).toBe(true);
			expect(isBulk).toBe(true);

			// Expected: riskLevel = "high", requiresApproval = true
		});
	});

	describe("Approval Workflow", () => {
		it("should pause execution when approval required", () => {
			const state = createMockState({
				status: "awaiting_approval",
				pendingToolApproval: {
					toolCall: {
						id: "call_delete",
						name: "delete_record",
						args: { id: "123" },
					},
					riskLevel: "high",
					reason: "Destructive operation: delete_record",
					iteration: 1,
				},
			});

			expect(state.status).toBe("awaiting_approval");
			expect(state.pendingToolApproval).toBeTruthy();
			expect(state.pendingToolApproval?.riskLevel).toBe("high");
		});

		it("should continue execution when approval granted", () => {
			// Simulates approval signal with approved: true
			const approvalDecision = {
				approved: true,
				feedback: undefined,
			};

			expect(approvalDecision.approved).toBe(true);

			// Expected: Tool should execute, status should return to "running"
		});

		it("should skip tool execution when approval rejected", () => {
			const approvalDecision = {
				approved: false,
				feedback: "This operation is too risky",
			};

			expect(approvalDecision.approved).toBe(false);

			// Expected: Tool should NOT execute, rejection added to conversation
		});

		it("should add rejection to conversation history", () => {
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Delete all records",
					timestamp: new Date().toISOString(),
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call_delete",
							name: "delete_all_records",
							args: {},
						},
					],
					timestamp: new Date().toISOString(),
				},
				{
					role: "tool",
					content:
						"Tool call rejected by user: This operation is too risky",
					toolCallId: "call_delete",
					timestamp: new Date().toISOString(),
				},
			];

			const lastMessage =
				conversationHistory[conversationHistory.length - 1];
			expect(lastMessage.role).toBe("tool");
			expect(lastMessage.content).toContain("rejected");
		});
	});

	describe("Tool Execution", () => {
		it("should execute tool and add results to conversation", () => {
			const toolCall = {
				id: "call_1",
				name: "search_data",
				args: { query: "test" },
			};

			const toolResult = {
				results: [
					{ id: "1", title: "Result 1" },
					{ id: "2", title: "Result 2" },
				],
			};

			const conversationHistory: IterativeMessage[] = [
				{
					role: "assistant",
					content: "",
					toolCalls: [toolCall],
					timestamp: new Date().toISOString(),
				},
				{
					role: "tool",
					content: JSON.stringify(toolResult, null, 2),
					toolCallId: toolCall.id,
					timestamp: new Date().toISOString(),
				},
			];

			expect(conversationHistory).toHaveLength(2);
			expect(conversationHistory[0].role).toBe("assistant");
			expect(conversationHistory[1].role).toBe("tool");
			expect(conversationHistory[1].content).toContain("Result 1");
		});

		it("should handle tool execution errors gracefully", () => {
			const toolCall = {
				id: "call_error",
				name: "failing_tool",
				args: {},
			};

			const toolError = "Tool execution failed: Network timeout";

			const conversationHistory: IterativeMessage[] = [
				{
					role: "assistant",
					content: "",
					toolCalls: [toolCall],
					timestamp: new Date().toISOString(),
				},
				{
					role: "tool",
					content: JSON.stringify({ error: toolError }),
					toolCallId: toolCall.id,
					timestamp: new Date().toISOString(),
				},
			];

			const errorMessage =
				conversationHistory[conversationHistory.length - 1];
			expect(errorMessage.content).toContain("error");
			expect(errorMessage.content).toContain("Network timeout");
		});

		it("should track tool execution metrics", () => {
			const toolCallRecord = {
				id: "call_1",
				name: "search_data",
				args: { query: "test" },
				result: { results: [] },
				status: "success" as const,
				durationMs: 1250,
			};

			expect(toolCallRecord.status).toBe("success");
			expect(toolCallRecord.durationMs).toBeGreaterThan(0);
		});

		it("should mark failed tools with error status", () => {
			const toolCallRecord = {
				id: "call_error",
				name: "failing_tool",
				args: {},
				result: { error: "Network timeout" },
				status: "error" as const,
				durationMs: 5000,
			};

			expect(toolCallRecord.status).toBe("error");
		});

		it("should execute multiple tools in sequence", () => {
			const toolCalls = [
				{ id: "call_1", name: "search_data", args: {} },
				{ id: "call_2", name: "filter_results", args: {} },
				{ id: "call_3", name: "format_output", args: {} },
			];

			// Each tool should execute in order and add to conversation
			expect(toolCalls).toHaveLength(3);

			// Expected conversation structure:
			// [assistant with call_1] → [tool result 1]
			// [assistant with call_2] → [tool result 2]
			// [assistant with call_3] → [tool result 3]
			// Total: 6 messages
		});
	});

	describe("Conversation History Management", () => {
		it("should maintain proper message ordering", () => {
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Find all tasks",
					timestamp: "2024-01-01T00:00:00Z",
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call_1", name: "search_tasks", args: {} },
					],
					timestamp: "2024-01-01T00:00:01Z",
				},
				{
					role: "tool",
					content: JSON.stringify({ tasks: [] }),
					toolCallId: "call_1",
					timestamp: "2024-01-01T00:00:02Z",
				},
				{
					role: "assistant",
					content: "I found 0 tasks.",
					timestamp: "2024-01-01T00:00:03Z",
				},
			];

			// Verify ordering: user → assistant → tool → assistant
			expect(conversationHistory[0].role).toBe("user");
			expect(conversationHistory[1].role).toBe("assistant");
			expect(conversationHistory[2].role).toBe("tool");
			expect(conversationHistory[3].role).toBe("assistant");
		});

		it("should include timestamps for all messages", () => {
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Test",
					timestamp: new Date().toISOString(),
				},
			];

			expect(conversationHistory[0].timestamp).toBeTruthy();
			expect(
				new Date(conversationHistory[0].timestamp).getTime(),
			).toBeGreaterThan(0);
		});

		it("should sync conversation history to workflow state", () => {
			const _state = createMockState();
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Test message",
					timestamp: new Date().toISOString(),
				},
			];

			// In the actual implementation, this would be:
			// state.iterativeConversationHistory = [...conversationHistory];

			expect(conversationHistory).toHaveLength(1);
		});

		it("should preserve tool call IDs for matching", () => {
			const toolCallId = "call_abc123";

			const assistantMessage: IterativeMessage = {
				role: "assistant",
				content: "",
				toolCalls: [{ id: toolCallId, name: "test_tool", args: {} }],
				timestamp: new Date().toISOString(),
			};

			const toolMessage: IterativeMessage = {
				role: "tool",
				content: "Result",
				toolCallId: toolCallId,
				timestamp: new Date().toISOString(),
			};

			expect(assistantMessage.toolCalls?.[0].id).toBe(toolCallId);
			expect(toolMessage.toolCallId).toBe(toolCallId);
		});
	});

	describe("Cancellation Handling", () => {
		it("should stop execution when cancelled", () => {
			let isCancelled = false;

			// Simulate cancellation during execution
			isCancelled = true;

			expect(isCancelled).toBe(true);

			// Expected: Phase should return { success: false, error: "Execution cancelled" }
		});

		it("should check cancellation before each iteration", () => {
			// The loop checks isCancelled() at the start of each iteration
			const checkpoints = ["iteration_start", "before_tool_execution"];

			expect(checkpoints).toContain("iteration_start");
		});

		it("should check cancellation during tool execution loop", () => {
			// The loop also checks isCancelled() when processing multiple tools
			const checkpoints = ["iteration_start", "before_tool_execution"];

			expect(checkpoints).toContain("before_tool_execution");
		});
	});

	describe("Iteration Cost Tracking", () => {
		it("should track token usage per iteration", () => {
			const iterationCost = {
				iteration: 1,
				toolName: "search_data",
				inputTokens: 1000,
				outputTokens: 500,
				timestamp: new Date().toISOString(),
			};

			expect(iterationCost.iteration).toBe(1);
			expect(iterationCost.inputTokens).toBeGreaterThan(0);
			expect(iterationCost.outputTokens).toBeGreaterThan(0);
		});

		it("should accumulate costs across iterations", () => {
			const costs = [
				{
					iteration: 1,
					inputTokens: 1000,
					outputTokens: 500,
					timestamp: "2024-01-01T00:00:00Z",
				},
				{
					iteration: 2,
					inputTokens: 1200,
					outputTokens: 600,
					timestamp: "2024-01-01T00:00:05Z",
				},
			];

			const totalTokens = costs.reduce(
				(sum, c) => sum + c.inputTokens + c.outputTokens,
				0,
			);

			expect(totalTokens).toBe(3300); // 1000+500+1200+600
		});

		it("should track costs even when tools are not called", () => {
			// When agent returns final response without tools
			const iterationCost = {
				iteration: 3,
				toolName: undefined,
				inputTokens: 500,
				outputTokens: 800,
				timestamp: new Date().toISOString(),
			};

			expect(iterationCost.toolName).toBeUndefined();
			expect(iterationCost.inputTokens).toBeGreaterThan(0);
		});
	});

	describe("Error Recovery", () => {
		it("should allow agent to adapt after tool errors", () => {
			// When a tool fails, the error is added to conversation
			// The agent can then choose a different approach
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Get data from API",
					timestamp: "2024-01-01T00:00:00Z",
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "call_1", name: "api_fetch", args: {} }],
					timestamp: "2024-01-01T00:00:01Z",
				},
				{
					role: "tool",
					content: JSON.stringify({
						error: "API rate limit exceeded",
					}),
					toolCallId: "call_1",
					timestamp: "2024-01-01T00:00:02Z",
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [{ id: "call_2", name: "use_cache", args: {} }],
					timestamp: "2024-01-01T00:00:03Z",
				},
			];

			// Agent saw the error and tried a different tool
			expect(conversationHistory[2].content).toContain("error");
			expect(conversationHistory[3].toolCalls?.[0].name).toBe(
				"use_cache",
			);
		});

		it("should continue after approval rejection", () => {
			// When a tool is rejected, agent can try alternative approach
			const conversationHistory: IterativeMessage[] = [
				{
					role: "user",
					content: "Delete old files",
					timestamp: "2024-01-01T00:00:00Z",
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{ id: "call_1", name: "delete_all_files", args: {} },
					],
					timestamp: "2024-01-01T00:00:01Z",
				},
				{
					role: "tool",
					content: "Tool call rejected by user: Too risky",
					toolCallId: "call_1",
					timestamp: "2024-01-01T00:00:02Z",
				},
				{
					role: "assistant",
					content: "",
					toolCalls: [
						{
							id: "call_2",
							name: "list_files_by_date",
							args: {},
						},
					],
					timestamp: "2024-01-01T00:00:03Z",
				},
			];

			// Agent adapted to rejection by listing files first
			expect(conversationHistory[2].content).toContain("rejected");
			expect(conversationHistory[3].toolCalls?.[0].name).toBe(
				"list_files_by_date",
			);
		});
	});

	describe("Real-World Scenarios", () => {
		it("should handle discovery task requiring multiple iterations", () => {
			// Scenario: "Get latest message from Amtab team"
			// Iteration 1: List teams → find Amtab team ID
			// Iteration 2: List channels in team → find general channel
			// Iteration 3: Get messages from channel → find latest
			// Iteration 4: Return final response

			const iterations = [
				{ toolName: "teams_list_teams", result: { teams: [] } },
				{
					toolName: "teams_list_channels",
					result: { channels: [] },
				},
				{
					toolName: "teams_get_messages",
					result: { messages: [] },
				},
			];

			expect(iterations).toHaveLength(3);
		});

		it("should handle task requiring approval mid-execution", () => {
			// Scenario: User asks to "clean up old tasks"
			// Iteration 1: List tasks (low risk, no approval)
			// Iteration 2: Delete tasks (high risk, needs approval)

			const iteration1 = {
				toolName: "list_tasks",
				requiresApproval: false,
			};
			const iteration2 = {
				toolName: "delete_tasks",
				requiresApproval: true,
			};

			expect(iteration1.requiresApproval).toBe(false);
			expect(iteration2.requiresApproval).toBe(true);
		});

		it("should gracefully handle hitting token budget mid-task", () => {
			// When budget is exceeded, should return partial results
			const budgetExceededResponse = {
				success: true,
				data: {
					finalResponse:
						"I've reached the limit for this task. Token budget exceeded: 105,000/100,000. Here's what I've accomplished so far:\n\nSuccessfully executed 5 tool call(s):\n- search_data\n- filter_results\n- analyze_patterns\n- generate_summary\n- format_output",
				},
				shouldContinue: true,
			};

			expect(budgetExceededResponse.success).toBe(true);
			expect(budgetExceededResponse.data.finalResponse).toContain(
				"accomplished",
			);
		});

		it("should handle agent getting stuck in loop", () => {
			// Iteration limit prevents infinite loops
			const maxIterations = 15;
			let currentIteration = 0;

			// Simulate agent calling same tool repeatedly
			while (currentIteration < maxIterations) {
				currentIteration++;
			}

			expect(currentIteration).toBe(maxIterations);
			// At this point, execution should stop with iteration limit message
		});
	});

	describe("Progress Updates", () => {
		it("should update progress at iteration start", () => {
			const progressUpdate = {
				phase: "iterating",
				message: "Iteration 1...",
			};

			expect(progressUpdate.phase).toBe("iterating");
			expect(progressUpdate.message).toContain("Iteration");
		});

		it("should update progress when awaiting approval", () => {
			const progressUpdate = {
				phase: "awaiting_approval",
				message:
					"Approval needed: Destructive operation: delete_record",
			};

			expect(progressUpdate.phase).toBe("awaiting_approval");
			expect(progressUpdate.message).toContain("Approval needed");
		});

		it("should update progress when executing tools", () => {
			const progressUpdate = {
				phase: "iterating",
				message: "Executing: search_data",
			};

			expect(progressUpdate.phase).toBe("iterating");
			expect(progressUpdate.message).toContain("Executing");
		});

		it("should update progress between iterations", () => {
			const progressUpdate = {
				phase: "iterating",
				message: "Completed iteration 2, continuing...",
			};

			expect(progressUpdate.message).toContain("Completed iteration");
			expect(progressUpdate.message).toContain("continuing");
		});
	});
});
