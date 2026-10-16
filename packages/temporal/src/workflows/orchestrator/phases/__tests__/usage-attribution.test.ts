/**
 * The Advisor loop forwards the chat's conversation to the model-calling
 * activities it schedules in-process, so their usage-log rows record it: the
 * rounds, the budget synthesis, the tool-result summarizer and compaction.
 * A run with no conversation (story automations, Weave) forwards nothing,
 * and the execution ID never stands in for it.
 *
 * Same harness as `turn-cancellation.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	const stub = (name: string) => {
		let fn = activities.get(name);
		if (!fn) {
			fn = vi.fn();
			activities.set(name, fn);
		}
		return fn;
	};
	return {
		stub,
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
		off: new Set<string>(),
	};
});

vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
	workflowInfo: vi.fn(() => ({
		runId: "test-run-id",
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { createInitialState, type IterativeMessage } from "../../types";
import { maybeCompactConversationHistory } from "../iterative-execution";
import { installDefaultStubs, runTurn } from "./advisor-scenario-harness";

const LARGE_OUTPUT = "z".repeat(40_000);

function requestsTo(activity: string): Array<Record<string, unknown>> {
	return mocks
		.stub(activity)
		.mock.calls.map((c) => c[0] as Record<string, unknown>);
}

beforeEach(() => {
	installDefaultStubs(mocks);
});

describe("Advisor usage attribution", () => {
	it("forwards the conversation to every round and the tool-result summarizer", async () => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: LARGE_OUTPUT,
			success: true,
			durationMs: 1,
			cached: false,
		});
		mocks.stub("summarizeLargeToolResult").mockResolvedValue("summary");

		await runTurn(mocks, {
			message: "List every record.",
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "Here are the records." },
			],
			input: { conversationId: "conv-1" },
		});

		const rounds = requestsTo("runAgentIteration");
		expect(rounds).toHaveLength(2);
		for (const round of rounds) {
			expect(round.conversationId).toBe("conv-1");
		}
		const summaries = requestsTo("summarizeLargeToolResult");
		expect(summaries).toHaveLength(1);
		expect(summaries[0].conversationId).toBe("conv-1");
	});

	it("forwards the conversation to the budget synthesis", async () => {
		await runTurn(mocks, {
			message: "Summarize the launch plan.",
			steps: [{ answer: "The launch is on the 12th." }],
			modeConfig: { maxIterations: 20, maxTotalTokens: 1 },
			input: { conversationId: "conv-1" },
		});

		const rounds = requestsTo("runAgentIteration");
		expect(rounds.length).toBeGreaterThan(0);
		// The synthesis round binds no tools.
		expect(
			rounds.some(
				(r) => Object.keys(r.availableTools as object).length === 0,
			),
		).toBe(true);
		for (const round of rounds) {
			expect(round.conversationId).toBe("conv-1");
		}
	});

	it("forwards nothing for a run with no conversation, never the execution ID", async () => {
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: LARGE_OUTPUT,
			success: true,
			durationMs: 1,
			cached: false,
		});
		mocks.stub("summarizeLargeToolResult").mockResolvedValue("summary");

		await runTurn(mocks, {
			message: "List every record.",
			steps: [
				{ calls: [{ name: "example_list_records", args: {} }] },
				{ answer: "Here are the records." },
			],
		});

		for (const request of [
			...requestsTo("runAgentIteration"),
			...requestsTo("summarizeLargeToolResult"),
		]) {
			expect(request).not.toHaveProperty("conversationId");
		}
	});
});

describe("compaction usage attribution", () => {
	function compactionFixture() {
		const state = createInitialState({
			executionId: "exec-advisor-1",
			message: "Plan the launch",
			userId: "user-1",
			organizationId: "org-1",
			history: [],
		} as never);
		const history: IterativeMessage[] = Array.from(
			{ length: 16 },
			(_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `turn ${i}`,
				timestamp: "2026-10-01T00:00:00.000Z",
			}),
		);
		return { state, history };
	}

	beforeEach(() => {
		mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
			summaryText: "",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
	});

	it("forwards the conversation to the compaction activity", async () => {
		const { state, history } = compactionFixture();
		await maybeCompactConversationHistory(
			state,
			history,
			10,
			90_000,
			100_000,
			"user-1",
			"org-1",
			undefined,
			"conv-1",
		);
		expect(
			requestsTo("compactConversationHistoryActivity")[0],
		).toMatchObject({ conversationId: "conv-1" });
	});

	it("forwards nothing without a conversation", async () => {
		const { state, history } = compactionFixture();
		await maybeCompactConversationHistory(
			state,
			history,
			10,
			90_000,
			100_000,
			"user-1",
			"org-1",
		);
		expect(
			requestsTo("compactConversationHistoryActivity")[0],
		).not.toHaveProperty("conversationId");
	});
});
