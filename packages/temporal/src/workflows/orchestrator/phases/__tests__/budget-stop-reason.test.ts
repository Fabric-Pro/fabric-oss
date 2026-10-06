/**
 * A turn stopped by its iteration limit was logged as "Orchestrator token
 * budget exhausted" and reported a token-only `budgetUsedPct`, so it read as
 * a token problem in the logs and the UI (Fizzy #2944). The stop now names
 * the limit that tripped, and the per-iteration log reports the ratio the
 * wrap-up warning and the stop act on, alongside both underlying ratios.
 *
 * Same harness as `tool-failure-breaker.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked, and
 * the model scripted turn by turn. Every model call reports 15 tokens.
 */

import { log } from "@temporalio/workflow";
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

import {
	type Call,
	installDefaultStubs,
	preloaded,
	runTurn,
	type Step,
} from "./advisor-scenario-harness";

const TOOL = "example_get_file";
const SYNTHESIZED =
	"## Summary\nThe launch flag is defined in src/flags.ts and is enabled.";

// BUDGET.synthesisReserveTokens is 8,000, so 8,020 leaves 20 tokens to
// spend: the second 15-token round crosses it.
const TOKEN_LIMITED = { maxTotalTokens: 8_020, maxIterations: 30 };
// BUDGET.synthesisIterationReserve is 1, so 3 leaves two rounds.
const ITERATION_LIMITED = { maxIterations: 3 };

beforeEach(() => {
	vi.mocked(log.error).mockClear();
	vi.mocked(log.info).mockClear();
	installDefaultStubs(mocks);
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "export const launchFlag = true;",
		success: true,
		durationMs: 1,
		cached: false,
	});
});

function fileCall(path: string): Call {
	return { name: TOOL, args: { path, ref: "abc123" } };
}

const TWO_ROUNDS: Step[] = [
	{ calls: [fileCall("src/flags.ts")] },
	{ calls: [fileCall("src/other.ts")] },
	{ answer: SYNTHESIZED },
];

function turn(modeConfig: Record<string, unknown>) {
	return runTurn(mocks, {
		message: "Is the launch flag enabled?",
		preload: preloaded([TOOL], "cfg-repo", "Repository"),
		enabledMcpConfigIds: ["cfg-repo"],
		steps: TWO_ROUNDS,
		modeConfig,
	});
}

function errorMessages(): string[] {
	return vi.mocked(log.error).mock.calls.map((call) => String(call[0]));
}

function usageLogs(): Record<string, unknown>[] {
	return vi
		.mocked(log.info)
		.mock.calls.filter(
			(call) => call[0] === "[IterativeExecution] Iteration token usage",
		)
		.map((call) => call[1] as Record<string, unknown>);
}

describe("budget stop reason", () => {
	it("logs and signals an iteration-limit stop as an iteration limit", async () => {
		const { state } = await turn(ITERATION_LIMITED);

		expect(errorMessages()).toContain(
			"Orchestrator iteration limit reached",
		);
		expect(errorMessages()).not.toContain(
			"Orchestrator token budget exhausted",
		);
		const stopLog = vi
			.mocked(log.error)
			.mock.calls.find(
				(call) => call[0] === "Orchestrator iteration limit reached",
			)?.[1];
		expect(stopLog).toMatchObject({
			reason: "Iteration limit reached: 2/3",
			limit: "iterations",
			iterationsUsed: 2,
			maxIterations: 3,
		});
		expect(state.limitSignals).toEqual([
			expect.objectContaining({
				kind: "internal_budget",
				message: "Iteration limit reached: 2/3",
				budgetLimit: "iterations",
			}),
		]);
	});

	it("logs and signals a token stop as a token budget", async () => {
		const { state } = await turn(TOKEN_LIMITED);

		expect(errorMessages()).toContain(
			"Orchestrator token budget exhausted",
		);
		expect(errorMessages()).not.toContain(
			"Orchestrator iteration limit reached",
		);
		expect(state.limitSignals).toEqual([
			expect.objectContaining({
				kind: "internal_budget",
				message: "Token budget exceeded: 30/8020",
				budgetLimit: "tokens",
			}),
		]);
	});

	it("reports the larger ratio as budgetUsedPct, with both ratios beside it", async () => {
		await turn(ITERATION_LIMITED);

		// After round 1 of 2 usable rounds: 15 of 500,000 tokens is ~0%,
		// one of two iterations is 50%.
		expect(usageLogs()[0]).toMatchObject({
			iterationsUsed: 1,
			maxIterations: 3,
			tokenBudgetUsedPct: 0,
			iterationBudgetUsedPct: 50,
			budgetUsedPct: 50,
		});
	});

	it.each([true, false])(
		"switches the wrap-up warning on at the same point with turn-stable prompts %s",
		async (turnStablePrompts) => {
			if (!turnStablePrompts) {
				mocks.off.add("orch-turn-stable-system-prompt-v1");
			}
			// maxIterations 8 leaves seven usable rounds; the 0.85 warning
			// threshold is crossed once six have run (6/7), on the seventh call.
			const rounds: Step[] = Array.from({ length: 6 }, (_, i) => ({
				calls: [fileCall(`src/file-${i}.ts`)],
			}));
			const { seen } = await runTurn(mocks, {
				message: "Is the launch flag enabled?",
				preload: preloaded([TOOL], "cfg-repo", "Repository"),
				enabledMcpConfigIds: ["cfg-repo"],
				steps: [...rounds, { answer: SYNTHESIZED }],
				modeConfig: { maxIterations: 8 },
			});

			expect(seen).toHaveLength(7);
			const warned = seen.map((s) =>
				(turnStablePrompts
					? (s.turnNotice ?? "")
					: s.systemPrompt
				).includes("BUDGET WARNING"),
			);
			expect(warned.slice(0, 6)).toEqual([
				false,
				false,
				false,
				false,
				false,
				false,
			]);
			expect(warned[6]).toBe(true);
			if (turnStablePrompts) {
				expect(new Set(seen.map((s) => s.systemPrompt)).size).toBe(1);
				expect(seen[0].systemPrompt).not.toContain("BUDGET WARNING");
			} else {
				expect(seen.map((s) => s.turnNotice)).toEqual(
					Array(7).fill(undefined),
				);
			}
		},
	);
});
