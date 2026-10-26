import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const start = Date.UTC(2026, 0, 1);
	return {
		start,
		now: start,
		initializationMs: 0,
		off: new Set<string>(),
		waits: [] as number[],
		stub(name: string) {
			let fn = activities.get(name);
			if (!fn) {
				fn = vi.fn();
				activities.set(name, fn);
			}
			return fn;
		},
		resetAll() {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	deprecatePatch: vi.fn(),
	proxyActivities: () =>
		new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	workflowInfo: () => ({
		workflowId: "example-execution",
		runId: "example-run",
		startTime: new Date(mocks.start),
		unsafe: { isReplaying: false },
	}),
	CancellationScope: class {
		consideredCancelled = false;
		static current = () => ({ consideredCancelled: false });
		static nonCancellable = (fn: () => unknown) => fn();
		run = (fn: () => unknown) => fn();
	},
	condition: async (predicate: () => boolean, timeout: number) => {
		mocks.waits.push(timeout);
		if (predicate()) {
			return true;
		}
		mocks.now += timeout;
		return false;
	},
	defineQuery: (name: string) => name,
	defineSignal: (name: string) => name,
	setHandler: vi.fn(),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

vi.mock("../initialization", () => ({
	executeInitializationPhase: async () => {
		mocks.now += mocks.initializationMs;
		return {
			success: true,
			shouldContinue: true,
			data: {
				enrichedMessage: "Read example data",
				enrichedSystemPrompt: "You are the Advisor.",
			},
		};
	},
}));
vi.mock("../completion", async (original) => ({
	...(await original<Record<string, unknown>>()),
	executeCompletionPhase: vi.fn(),
}));

import { ApplicationFailure } from "@temporalio/common";
import { patched } from "@temporalio/workflow";
import { createInitialState } from "../../types";
import * as phases from "../index";
import { executeTimeLimitExit } from "../iterative-execution";
import { orchestratorExecutionWorkflow } from "../../index";
import { installDefaultStubs } from "./advisor-scenario-harness";

const minute = 60_000;
const summary = `## Summary\nThe example report is partially complete.\n\n## What I did\n- Read example data.\n\n## What's still needed\n- Save the final report. ${"Check the example sources before saving. ".repeat(10)}`;
const response = {
	type: "response",
	content: summary,
	usage: { inputTokens: 10, outputTokens: 5 },
};
const toolRound = {
	type: "tool_calls",
	toolCalls: [{ id: "example-call", name: "delete_records", args: {} }],
	usage: { inputTokens: 10, outputTokens: 5 },
};

beforeEach(() => {
	installDefaultStubs(mocks);
	vi.mocked(patched).mockClear();
	mocks.now = mocks.start;
	mocks.initializationMs = 0;
	mocks.waits = [];
	vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
	mocks.stub("analyzeIntentClarityActivity").mockResolvedValue({
		needsClarification: true,
		question: "Which report?",
	});
	mocks.stub("runAgentIteration").mockResolvedValue(response);
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "example-approval" });
	mocks
		.stub("finalizeConversationTurnActivity")
		.mockImplementation(async (args) => ({
			status: args.outcome,
			budgetStop: args.budgetStop,
		}));
});
afterEach(() => vi.restoreAllMocks());

function run(overrides: Record<string, unknown> = {}) {
	return orchestratorExecutionWorkflow({
		executionId: "example-execution",
		turnId: "example-turn",
		userId: "example-user",
		organizationId: "example-org",
		message: "Read example data",
		executionMode: "accurate",
		surface: "loom-orchestrator",
		history: [],
		...overrides,
	});
}
function expectSavedTimeStop(used = 2700) {
	expect(mocks.stub("finalizeConversationTurnActivity")).toHaveBeenCalledWith(
		expect.objectContaining({
			outcome: "LIMITED",
			responseText: summary,
			budgetStop: { version: 1, kind: "time_limit", used, limit: 2700 },
		}),
	);
	expect(mocks.now - mocks.start).toBeLessThan(90 * minute);
}

it("saves a time stop after a 30-minute accurate clarification and a capped approval", async () => {
	mocks
		.stub("runAgentIteration")
		.mockResolvedValueOnce(toolRound)
		.mockResolvedValue(response);
	const result = await run();
	expect(mocks.waits).toEqual([30 * minute, 15 * minute]);
	expectSavedTimeStop();
	expect(result.response).toBe(summary);
	expect(mocks.stub("updateApprovalTaskStatus")).toHaveBeenCalledWith(
		expect.objectContaining({ approved: false }),
	);
	expect(mocks.stub("executeMcpTool")).not.toHaveBeenCalled();
});

it("caps clarification by the start-event deadline and goes directly to synthesis", async () => {
	mocks.initializationMs = 40 * minute;
	await run();
	expect(mocks.waits).toEqual([5 * minute]);
	expectSavedTimeStop();
	expect(mocks.stub("runAgentIteration")).toHaveBeenCalledOnce();
	expect(
		mocks.stub("runAgentIteration").mock.calls[0][0].availableTools,
	).toEqual({});
});

it("clamps an expired clarification wait to zero", async () => {
	mocks.initializationMs = 46 * minute;
	await run();
	expect(mocks.waits).toEqual([0]);
	expectSavedTimeStop(2760);
});

it("retains pre-marker waits and starts a main round beyond 45 minutes", async () => {
	mocks.off.add("orch-main-round-budget-v1");
	mocks.initializationMs = 40 * minute;
	mocks
		.stub("runAgentIteration")
		.mockResolvedValueOnce(toolRound)
		.mockResolvedValue(response);
	const result = await run();
	expect(mocks.waits).toEqual([30 * minute, 30 * minute]);
	expect(result.budgetStop).toBeUndefined();
	expect(mocks.stub("finalizeConversationTurnActivity")).toHaveBeenCalledWith(
		expect.objectContaining({ outcome: "COMPLETED" }),
	);
	expect(
		mocks.stub("runAgentIteration").mock.calls[0][0].availableTools,
	).not.toEqual({});
});

it("keeps a balanced project-setup input on the legacy limits without a deadline", async () => {
	mocks.initializationMs = 46 * minute;
	const phase = vi.spyOn(phases, "executeIterativePhase");
	const result = await run({
		turnId: undefined,
		surface: undefined,
		executionMode: "balanced",
	});
	expect(phase.mock.calls[0][2]).toMatchObject({
		maxIterations: 15,
		maxTotalTokens: 500000,
	});
	expect(result.budgetStop).toBeUndefined();
	expect(
		mocks.stub("runAgentIteration").mock.calls[0][0].availableTools,
	).not.toEqual({});
});

it("uses the entry-point marker decision through the iterative phase", async () => {
	mocks.initializationMs = 46 * minute;
	await run();
	expect(
		vi
			.mocked(patched)
			.mock.calls.filter(([id]) => id === "orch-main-round-budget-v1"),
	).toHaveLength(1);
});

it.each([
	["model response", summary],
	["static fallback", "Short"],
])("keeps the interrupted call in the %s", async (_kind, content) => {
	mocks.stub("runAgentIteration").mockResolvedValue({ ...response, content });
	const input = {
		executionId: "example-execution",
		turnId: "example-turn",
		userId: "example-user",
		organizationId: "example-org",
		message: "Save example report",
		history: [],
		executionMode: "balanced" as const,
	};
	const state = createInitialState(input);
	state.inFlightToolCall = {
		id: "example-call",
		name: "example_write",
		args: { id: "example-report" },
		startedAt: mocks.start,
	};
	mocks.now += 45 * minute;
	const result = await executeTimeLimitExit(
		state,
		input,
		vi.fn(),
		() => false,
		undefined,
	);
	expect(result.data?.finalResponse).not.toContain("1 failed");
	expect(result.data?.finalResponse).toContain("example_write");
	expect(result.data?.finalResponse).toContain(
		"interrupted at the time limit — outcome unknown",
	);
	expect(result.data?.finalResponse).toContain(
		"Verify its outcome before retrying",
	);
});

it("answers a tool call the deadline left without a result before synthesis", async () => {
	mocks.stub("runAgentIteration").mockResolvedValue({
		...response,
		content: summary,
	});
	const input = {
		executionId: "example-execution",
		turnId: "example-turn",
		userId: "example-user",
		organizationId: "example-org",
		message: "Save example report",
		history: [],
		executionMode: "balanced" as const,
	};
	const state = createInitialState(input);
	const at = new Date(mocks.start).toISOString();
	state.iterativeConversationHistory = [
		{ role: "user", content: "Save example report", timestamp: at },
		{
			role: "assistant",
			content: "",
			toolCalls: [
				{ id: "example-read", name: "example_read", args: {} },
				{ id: "example-save", name: "example_write", args: {} },
			],
			timestamp: at,
		},
		{
			role: "tool",
			content: "read result",
			toolCallId: "example-read",
			timestamp: at,
		},
	];
	mocks.now += 45 * minute;
	await executeTimeLimitExit(state, input, vi.fn(), () => false, undefined);
	const sent = mocks.stub("runAgentIteration").mock.calls[0][0]
		.conversationHistory as Array<{ role: string; toolCallId?: string }>;
	const callIndex = sent.findIndex((message) => message.role === "assistant");
	expect(sent.slice(callIndex + 1, callIndex + 3)).toEqual([
		expect.objectContaining({ role: "tool", toolCallId: "example-read" }),
		expect.objectContaining({ role: "tool", toolCallId: "example-save" }),
	]);
});

it("uses the entry-point marker decision when recording the token allowance stop", async () => {
	mocks
		.stub("analyzeIntentClarityActivity")
		.mockResolvedValue({ needsClarification: false });
	mocks.stub("runAgentIteration").mockRejectedValueOnce(
		ApplicationFailure.create({
			type: "TurnBudgetExhausted",
			message: "Token allowance used",
			nonRetryable: true,
		}),
	);
	const result = await run();
	expect(result.budgetStop).toMatchObject({
		version: 1,
		kind: "token_allowance",
	});
	expect(
		vi
			.mocked(patched)
			.mock.calls.filter(([id]) => id === "orch-main-round-budget-v1"),
	).toHaveLength(1);
});
