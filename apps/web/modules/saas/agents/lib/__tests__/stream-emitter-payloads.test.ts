import { expect, it } from "vitest";
import { parseDirectStreamEvent } from "../direct-stream-protocol";
import {
	parseOrchestratorStreamEvent,
	parseResearchStreamEvent,
} from "../orchestrator-stream-protocol";

const tool = {
	toolCallId: "example-tool",
	toolName: "search",
	serverName: "example",
	args: { query: "example" },
	status: "complete",
	mcpAppResourceUri: "ui://example",
	mcpAppConfigId: "example-config",
};
const limit = {
	kind: "internal_budget",
	budgetLimit: "tokens",
	message: "Example",
	budget: { used: 1, total: 2, usagePercentage: 50 },
};
const direct = [
	{ type: "started", executionId: "example-run" },
	{ type: "text", content: "Example" },
	{ type: "reasoning", content: "Example" },
	{ type: "reasoningDuration", durationMs: 1 },
	{ type: "tool_start", ...tool },
	{ type: "tool_input", ...tool },
	{
		type: "tool_result",
		...tool,
		result: { text: "example" },
		error: "Example",
	},
	{
		type: "progress",
		phase: "executing",
		message: "Example",
		progress: 1,
		currentActivity: "example",
	},
	{
		type: "confirmation_required",
		workflowId: "example-workflow",
		workflowName: "Example",
		description: "Example",
		toolName: "execute_workflow",
		args: {},
		draft: {},
		message: "Example",
	},
	{
		type: "sources",
		sources: [
			{
				id: "example-source",
				title: "Example",
				type: "web",
				excerpt: "Example",
				similarity: 1,
				metadata: { url: "https://example.com" },
			},
		],
	},
	{
		type: "error",
		message: "Example",
		code: "EXAMPLE",
		data: {},
		limit,
		partial: true,
	},
	{
		type: "done",
		durationMs: 1,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			totalTokens: 2,
			reasoningTokens: 0,
			cachedInputTokens: 0,
		},
		model: {
			id: "example-model",
			canonicalName: "example-model",
			provider: "example",
			contextWindow: 1,
		},
		toolsFailed: { summary: "Example" },
		truncated: "provider-defined",
		apiBilling: { jobType: "example" },
	},
	{ type: "mcp_default_tool_invoked", payload: { toolName: "search" } },
	{ type: "mcp_default_tool_failed", payload: { toolName: "search" } },
];
const plan = {
	id: "example-plan",
	description: "Example",
	riskLevel: "low",
	steps: [],
};
const orchestration = [
	{
		type: "started",
		executionId: "example-run",
		workflowId: "example-workflow",
		resumed: true,
		turnId: null,
		turnGeneration: null,
	},
	{ type: "start_pending", retryable: true, executionId: "example-run" },
	{ type: "phase", phase: "planning", message: "Example" },
	{
		type: "routing",
		primaryAgent: "example",
		agentName: "Example",
		confidence: 1,
		riskLevel: "low",
		requiredConnections: [],
		missingIntegrations: [],
		blockedOnConnections: false,
	},
	{ type: "planning", plan },
	{
		type: "step_start",
		stepId: "example-step",
		description: "Example",
		order: 0,
	},
	{
		type: "step_complete",
		stepId: "example-step",
		stepDescription: "Example",
		status: "complete",
		response: "Example",
		toolCalls: [
			{
				id: "example-tool",
				name: "search",
				args: {},
				result: {},
				status: "success",
				durationMs: 1,
			},
		],
		durationMs: 1,
	},
	{ type: "text_start", iteration: 1 },
	{ type: "text_delta", content: "Example" },
	{ type: "tool_start", ...tool },
	{ type: "tool_input", ...tool },
	{
		type: "tool_result",
		...tool,
		result: { text: "example" },
		error: "Example",
		durationMs: 1,
	},
	{ type: "limit_signal", signal: limit },
	{
		type: "context_compacted",
		iteration: 1,
		compactedTurns: 1,
		summaryChars: 1,
		historyLengthBefore: 1,
	},
	{
		type: "progress",
		completedSteps: 1,
		totalSteps: 2,
		message: "Example",
		phase: "executing",
	},
	{
		type: "approval_required",
		approvalId: "example-approval",
		stepId: "example-step",
		reason: "Example",
	},
	{
		type: "approval_resolved",
		approvalId: "example-approval",
		stepId: "example-step",
		message: "Example",
	},
	{
		type: "clarifying_question",
		clarificationId: "example-clarification",
		stepId: "example-step",
		question: "Example?",
		options: ["Example"],
	},
	{ type: "clarifying_resolved", clarificationId: "example-clarification" },
	{ type: "stream_timeout", executionId: "example-run", message: "Example" },
	{
		type: "completed",
		status: "completed",
		response: "Example",
		plan,
		variables: {},
		stepResults: [
			{
				stepId: "example-step",
				stepDescription: "Example",
				status: "error",
				error: "Example",
				artifacts: [
					{
						id: "example-artifact",
						type: "error",
						content: "Example",
					},
				],
			},
		],
		toolCalls: [],
		approvalHistory: [],
		artifacts: [],
		limitSignals: [limit],
		tokenBudget: limit.budget,
		handoffRecommended: { reason: "Example", summary: "Example" },
		truncated: "provider-defined",
		budgetStop: {},
		apiBilling: { jobType: "example" },
		turnId: null,
		turnGeneration: null,
		fromTurnRecord: true,
		totalDurationMs: 1,
	},
	{
		type: "error",
		message: "Example",
		error: "Example",
		code: "EXAMPLE",
		data: {},
		budgetStop: {},
		limit,
		approvalHistory: [],
	},
	{ type: "mcp_default_tool_invoked", payload: { toolName: "search" } },
	{ type: "mcp_default_tool_failed", payload: { toolName: "search" } },
];
it.each(direct)("retains direct $type emitter fields", (payload) => {
	expect(parseDirectStreamEvent(payload)).toEqual(payload);
});
for (const parse of [parseOrchestratorStreamEvent, parseResearchStreamEvent]) {
	it.each(orchestration)(
		"retains orchestration $type emitter fields",
		(payload) => {
			expect(parse(payload)).toEqual(payload);
		},
	);
}
it.each([{ type: "text", content: "Example" }, { type: "done" }])(
	"reads research legacy $type",
	(payload) => {
		expect(parseResearchStreamEvent(payload)).toEqual(payload);
	},
);
