import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives the generate-document node end-to-end with a stubbed model and
 * asserts that reasoning capture produces the expected `reasoningByTurn`
 * slice on Command.update for BOTH success-return paths (tool success at
 * generate-document.ts:~372 + fallback at ~:401 — see Codex pass #1
 * concern #6 sub-checklist in the spec).
 *
 * Negative cases verify that the intermediate DAG nodes (analyze /
 * assess-risks / build-dependencies / plan-execution) do NOT emit
 * reasoning — they don't import or call the reasoning helpers, so we
 * assert the static fact that only generate-document.ts imports them.
 *
 * Mocks `getAgentModelSync` + `withRetry` via `../utils` so the test
 * doesn't need network/DB and can deterministically choose responses.
 */

const invokeMock = vi.fn();
const bindToolsMock = vi.fn();

vi.mock("../utils", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("../utils")
	>()) as Record<string, unknown>;
	return {
		...actual,
		getAgentModelSync: vi.fn(() => ({
			invoke: invokeMock,
			bindTools: bindToolsMock.mockImplementation(() => ({
				invoke: invokeMock,
			})),
		})),
		// withRetry: pass-through, no retry delay
		withRetry: vi.fn(async (fn: () => unknown) => fn()),
	};
});

vi.mock("@repo/agent-core", async (importOriginal) => {
	const actual = (await importOriginal<
		typeof import("@repo/agent-core")
	>()) as Record<string, unknown>;
	return {
		...actual,
		logAgentUsageFromRunnableConfig: vi.fn(async () => {}),
	};
});

vi.mock("@repo/agent-tools", () => ({
	WRITE_TASK_PLAN_TOOL: { name: "write_task_plan", description: "stub" },
}));

// Import AFTER vi.mock.
const { generateDocumentNode } = await import("../nodes/generate-document");

// generateFallbackDocument reads several optional fields off riskAnalysis +
// executionPlan; the shape here is the MINIMUM that prevents `undefined.map`
// throws when the test exercises the fallback path. Fields not asserted on
// are left empty / zero.
const baseState = {
	projectName: "Test",
	projectDescription: undefined,
	userStory: "build something",
	techStack: undefined,
	systemPrompt: undefined,
	tools: [],
	document: undefined,
	focusAnchor: undefined,
	decomposedTasks: [
		{
			id: "t1",
			title: "task1",
			type: "feature",
			description: "stub",
			estimate: 1,
			complexity: "LOW",
			riskScore: 0,
			parallelizable: false,
			acceptanceCriteria: [],
			technicalApproach: [],
			filesToModify: [],
			subtasks: [],
		},
	],
	riskAnalysis: {
		overallScore: 0,
		factors: [],
		mitigations: [],
		recommendations: [],
		overallAssessment: "low",
	},
	dependencyGraph: { nodes: [], edges: [], criticalPath: [] },
	executionPlan: { phases: [], recommendedTeamSize: 1 },
	currentStage: undefined,
	error: undefined,
	retryCount: 0,
	reasoningByTurn: {},
};

describe("task-planner generateDocumentNode — reasoning emission", () => {
	beforeEach(() => {
		invokeMock.mockReset();
		bindToolsMock.mockClear();
	});

	it("emits reasoningByTurn on tool-success path (write_task_plan)", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: [
					{
						type: "thinking",
						thinking: "Weighing risk vs sequencing…",
					},
					{ type: "text", text: "Here is the plan." },
				] as never,
				tool_calls: [
					{
						id: "call_1",
						name: "write_task_plan",
						args: {
							document: "# Plan\n",
							focusAnchor: "# Plan",
							decomposedTasks: [],
							riskAnalysis: { overallScore: 0 },
							dependencyGraph: {
								nodes: [],
								edges: [],
								criticalPath: [],
							},
							executionPlan: { phases: [] },
						},
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await generateDocumentNode({
			...baseState,
			messages: [new HumanMessage("plan it")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe("Weighing risk vs sequencing…");
	});

	it("emits reasoningByTurn on fallback path (no tool_calls in response)", async () => {
		// No tool calls → generate-document.ts falls back to generateFallbackDocument.
		// The reasoning still gets surfaced on this path (Codex #8 sub-checklist).
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "Plain reply, no structured plan output.",
				additional_kwargs: {
					__raw_response: {
						choices: [
							{
								index: 0,
								message: {
									content:
										"Plain reply, no structured plan output.",
									reasoning:
										"The model decided not to call write_task_plan because…",
								},
							},
						],
					},
				},
			}),
		);

		const command = await generateDocumentNode({
			...baseState,
			messages: [new HumanMessage("plan it")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		const reasoningByTurn = (
			update as { reasoningByTurn?: Record<number, { text: string }> }
		).reasoningByTurn;
		expect(reasoningByTurn?.[1].text).toBe(
			"The model decided not to call write_task_plan because…",
		);
	});

	it("does NOT emit reasoning when response has none (tool-success path)", async () => {
		invokeMock.mockResolvedValueOnce(
			new AIMessage({
				content: "",
				tool_calls: [
					{
						id: "call_1",
						name: "write_task_plan",
						args: { document: "# Plan", focusAnchor: "# Plan" },
						type: "tool_call" as const,
					},
				],
			}),
		);

		const command = await generateDocumentNode({
			...baseState,
			messages: [new HumanMessage("plan it")] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});

	it("does NOT invoke model on the post-confirmation acknowledgment branch", async () => {
		const aiWithConfirm = new AIMessage({
			content: "",
			tool_calls: [
				{
					id: "call_1",
					name: "confirm_changes",
					args: {},
					type: "tool_call" as const,
				},
			],
		});
		const toolResponse = {
			type: "tool",
			content: "accepted",
			tool_call_id: "call_1",
			name: "confirm_changes",
		};

		const command = await generateDocumentNode({
			...baseState,
			messages: [
				new HumanMessage("accept"),
				aiWithConfirm,
				toolResponse,
			] as never,
		});

		const update = (command as { update?: Record<string, unknown> }).update;
		expect(invokeMock).not.toHaveBeenCalled();
		expect(
			(update as Record<string, unknown>).reasoningByTurn,
		).toBeUndefined();
	});
});

// =============================================================================
// Negative static assertion — intermediate DAG nodes do NOT touch reasoning
// =============================================================================

import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("task-planner — intermediate DAG nodes do NOT import reasoning helpers (Q3 final-node-only)", () => {
	const intermediateNodes = [
		"analyze.ts",
		"assess-risks.ts",
		"build-dependencies.ts",
		"plan-execution.ts",
	];

	for (const file of intermediateNodes) {
		it(`${file} does not import or write reasoning state`, () => {
			const sourcePath = join(__dirname, "..", "nodes", file);
			const source = readFileSync(sourcePath, "utf-8");
			// Word-boundary regexes prevent false positives like
			// `buildReasoningUpdateForFoo` (Codex pass #1 PR 3 concern #4).
			expect(source).not.toMatch(/\bbuildReasoningUpdate\b/);
			expect(source).not.toMatch(/\bstripRawResponseEnvelope\b/);
			// No import from the shared module either.
			expect(source).not.toMatch(/@repo\/agent-core\/reasoning-trace/);
			// Stronger guard: any write to a `reasoningByTurn` state slice
			// would require the identifier to appear in the source. The
			// final-node-only rule (Q3) only holds if NO intermediate node
			// references this identifier in any form.
			expect(source).not.toMatch(/\breasoningByTurn\b/);
		});
	}
});
