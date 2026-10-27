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
		startTime: new Date(Date.now()),
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
	it.each([true, false])(
		"uses validated discovery origin with patch enabled=%s",
		async (enabled) => {
			if (!enabled) {
				mocks.off.add("orchestrator-complete-usage-origin-v1");
			}
			await runTurn(mocks, {
				message: "Find tools for the launch.",
				steps: [
					{
						calls: [
							{
								name: "search_tools",
								args: {
									query: "launch",
									projectId: "forged-project",
									frameId: "forged-frame",
									usageOrigin: {
										projectId: "forged-project",
									},
								},
							},
						],
					},
					{ answer: "Found the tools." },
				],
				input: {
					conversationId: "conv-1",
					usageFrameId: "frame-1",
					projectId: "project-1",
				},
			});
			for (const activity of [
				"searchAvailableTools",
				"searchAvailableAgents",
				"searchAvailableIntegrations",
			]) {
				const requests = requestsTo(activity);
				expect(requests).toHaveLength(1);
				if (enabled) {
					expect(requests[0].usageOrigin).toEqual({
						conversationId: "conv-1",
						frameId: "frame-1",
						projectId: "project-1",
						featureKey: "chat-agent",
					});
				} else {
					expect(requests[0]).not.toHaveProperty("usageOrigin");
				}
			}
		},
	);

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
			input: {
				conversationId: "conv-1",
				usageFrameId: "frame-1",
				projectId: "project-1",
			},
		});

		const rounds = requestsTo("runAgentIteration");
		expect(rounds).toHaveLength(2);
		for (const round of rounds) {
			expect(round.conversationId).toBe("conv-1");
			expect(round.frameId).toBe("frame-1");
			expect(round.projectId).toBe("project-1");
			expect(round).not.toHaveProperty("workflowExecutionId");
		}
		const summaries = requestsTo("summarizeLargeToolResult");
		expect(summaries).toHaveLength(1);
		expect(summaries[0].conversationId).toBe("conv-1");
		expect(summaries[0].frameId).toBe("frame-1");
		expect(summaries[0].projectId).toBe("project-1");
	});

	it("forwards the conversation to the budget synthesis", async () => {
		await runTurn(mocks, {
			message: "Summarize the launch plan.",
			steps: [{ answer: "The launch is on the 12th." }],
			modeConfig: { maxIterations: 20, maxTotalTokens: 1 },
			input: {
				conversationId: "conv-1",
				usageFrameId: "frame-1",
				projectId: "project-1",
			},
		});

		const rounds = requestsTo("runAgentIteration");
		expect(rounds.length).toBeGreaterThan(0);
		expect(rounds.some((round) => round.callPurpose === "synthesis")).toBe(
			true,
		);
		// The synthesis round binds no tools.
		expect(
			rounds.some(
				(r) => Object.keys(r.availableTools as object).length === 0,
			),
		).toBe(true);
		for (const round of rounds) {
			expect(round.conversationId).toBe("conv-1");
			expect(round.frameId).toBe("frame-1");
			expect(round.projectId).toBe("project-1");
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
			input: { launchWorkspaceId: "unverified-frame" },
		});

		for (const request of [
			...requestsTo("runAgentIteration"),
			...requestsTo("summarizeLargeToolResult"),
		]) {
			expect(request).not.toHaveProperty("conversationId");
			expect(request).not.toHaveProperty("frameId");
			expect(request).not.toHaveProperty("workflowExecutionId");
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
			"frame-1",
			"project-1",
		);
		expect(
			requestsTo("compactConversationHistoryActivity")[0],
		).toMatchObject({
			conversationId: "conv-1",
			frameId: "frame-1",
			projectId: "project-1",
		});
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
		expect(
			requestsTo("compactConversationHistoryActivity")[0],
		).not.toHaveProperty("frameId");
	});
});

describe("delegated usage input", () => {
	it.each([true, false])(
		"passes validated delegation and RAG origin with patch enabled=%s",
		async (enabled) => {
			if (!enabled) {
				mocks.off.add("orchestrator-complete-usage-origin-v1");
			}
			mocks
				.stub("executeAgentAsTool")
				.mockResolvedValue({ output: "done", durationMs: 1 });
			for (const activity of [
				"retrieveWorkspaceDocumentsActivity",
				"retrieveProjectContextsActivity",
			]) {
				mocks.stub(activity).mockResolvedValue({
					context: "Relevant launch plan",
					chunkCount: 1,
				});
			}
			await runTurn(mocks, {
				message: "Research the launch in the attached documents.",
				workspaceIds: ["workspace-example"],
				steps: [
					{
						calls: [
							{
								name: "delegate_to_agent-1",
								args: {
									message: "research",
									usageOrigin: {
										projectId: "forged-project",
									},
								},
							},
							{
								name: "workspace_rag_query",
								args: {
									query: "launch",
									frameId: "forged-frame",
								},
							},
							{
								name: "project_rag_query",
								args: {
									query: "launch",
									projectId: "forged-project",
								},
							},
						],
					},
					{ answer: "Here is the launch plan." },
				],
				input: {
					conversationId: "conv-1",
					usageFrameId: "frame-1",
					projectId: "project-1",
				},
			});
			const delegated = requestsTo("executeAgentAsTool");
			expect(delegated).toHaveLength(1);
			const workspaceCalls = mocks.stub(
				"retrieveWorkspaceDocumentsActivity",
			).mock.calls;
			const projectCalls = mocks.stub("retrieveProjectContextsActivity")
				.mock.calls;
			expect(workspaceCalls).toHaveLength(1);
			expect(projectCalls).toHaveLength(1);
			expect(workspaceCalls[0][3]).toEqual(["workspace-example"]);
			expect(projectCalls[0][1]).toBe("project-1");
			for (const request of [
				delegated[0],
				workspaceCalls[0][7],
				projectCalls[0][5],
			]) {
				expect(request.usageConversationId).toBe("conv-1");
				if (enabled) {
					expect(request.usageOrigin).toEqual({
						conversationId: "conv-1",
						frameId: "frame-1",
						projectId: "project-1",
						featureKey: "chat-agent",
					});
				} else {
					expect(request).not.toHaveProperty("usageOrigin");
				}
			}
		},
	);

	it.each(["conversation-example", undefined])(
		"forwards only the verified workflow conversation (%s)",
		async (conversationId) => {
			mocks
				.stub("executeAgentAsTool")
				.mockResolvedValue({ output: "done", durationMs: 1 });
			await runTurn(mocks, {
				message: "Ask the research agent.",
				steps: [
					{
						calls: [
							{
								name: "delegate_to_agent-1",
								args: { message: "research" },
							},
						],
					},
					{ answer: "done" },
				],
				input: { conversationId },
			});
			expect(requestsTo("executeAgentAsTool")).toHaveLength(1);
			expect(
				requestsTo("executeAgentAsTool")[0].usageConversationId,
			).toBe(conversationId);
		},
	);
});

it.each(["claude-haiku-4-5", undefined])(
	"delegates with the selected model (%s)",
	async (modelOverride) => {
		mocks
			.stub("executeAgentAsTool")
			.mockResolvedValue({ output: "done", durationMs: 1 });
		await runTurn(mocks, {
			message: "Delegate research",
			steps: [
				{
					calls: [
						{
							name: "delegate_to_agent-1",
							args: { message: "research" },
						},
					],
				},
				{ answer: "done" },
			],
			input: { modelOverride },
		});
		const [request] = requestsTo("executeAgentAsTool");
		expect(request).toBeDefined();
		if (modelOverride) {
			expect(request).toHaveProperty("modelOverride", modelOverride);
		} else {
			expect(request).not.toHaveProperty("modelOverride");
		}
	},
);

it.each([true, false])(
	"leaves the iterative workspace purpose to its operation with usage-origin patch=%s",
	async (enabled) => {
		if (!enabled) {
			mocks.off.add("orchestrator-complete-usage-origin-v1");
		}
		mocks
			.stub("retrieveWorkspaceDocumentsActivity")
			.mockResolvedValue({ context: "Example context", chunkCount: 1 });
		await runTurn(mocks, {
			message: "Search workspace",
			workspaceIds: ["example-workspace"],
			steps: [
				{
					calls: [
						{
							name: "workspace_rag_query",
							args: { query: "example" },
						},
					],
				},
				{ answer: "Found it" },
			],
		});
		expect(
			mocks.stub("retrieveWorkspaceDocumentsActivity").mock.calls[0][7] ??
				{},
		).not.toHaveProperty("callPurpose");
	},
);
