import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		startTime: new Date(0),
		unsafe: { isReplaying: false },
	})),
	startChild: vi.fn(),
	ParentClosePolicy: { ABANDON: "ABANDON" },
}));

import { installDefaultStubs, runTurn } from "./advisor-scenario-harness";

const PATCH = "orch-main-round-budget-v1";
const summary =
	"## Summary\nThe work is partially complete.\n\n## What I did\n- Read example data.\n\n## What's still needed\n- Save the updated report after checking the uncertain write outcome. The example data was read successfully, but the report has not been saved and needs a direct link for each item.";
const call = {
	name: "delegate_to_analyst",
	args: { message: 'Summarize commits: "removed all obsolete code"' },
};
beforeEach(() => {
	installDefaultStubs(mocks);
	vi.spyOn(Date, "now").mockReturnValue(0);
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Read example data",
		durationMs: 1,
		status: "completed",
	});
	mocks.stub("judgeDelegationRiskActivity").mockResolvedValue({
		clear: true,
		judgedBy: "decision",
		usage: { inputTokens: 20, outputTokens: 1 },
	});
});
function run(rounds: number, maxIterations: number) {
	return runTurn(mocks, {
		advisorBudgetEnabled: !mocks.off.has(PATCH),
		message: "Summarize commits",
		modeConfig: { maxIterations, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: rounds }, () => ({ calls: [call] })),
			{ answer: summary },
		],
	});
}
describe("main round budget", () => {
	it("allows 25 main rounds with risk-judge helpers interleaved", async () => {
		const { state, result, seen } = await run(25, 30);
		expect(seen).toHaveLength(26);
		expect(state.mainRounds).toBe(26);
		expect(state.iterationCosts).toHaveLength(51);
		expect(state.budgetStop).toBeUndefined();
		expect(result.data?.finalResponse).toBe(summary);
	});
	it("stops after 30 scheduled main rounds and synthesizes a durable round stop", async () => {
		const { state, result, seen } = await run(30, 30);
		expect(state.mainRounds).toBe(30);
		expect(state.budgetStop).toEqual({
			version: 1,
			kind: "round_limit",
			used: 30,
			limit: 30,
		});
		expect(seen).toHaveLength(31);
		expect(seen[25].turnNotice ?? "").not.toContain("BUDGET WARNING");
		expect(seen[26].turnNotice).toContain("BUDGET WARNING");
		expect(result.data?.finalResponse).toBe(summary);
		expect(state.pendingHandoff?.summary).toBe(summary);
		expect(seen.at(-1)?.systemPrompt).toContain(
			"write whose outcome is unknown",
		);
	});
	it("retains the old stop at 14 counted entries without the marker", async () => {
		mocks.off.add(PATCH);
		const { state, seen } = await run(7, 15);
		expect(seen).toHaveLength(8);
		expect(state.iterationCosts).toHaveLength(15);
		expect(state.budgetStop).toBeUndefined();
		expect(state.pendingHandoff?.reason).toBe(
			"Iteration limit reached: 14/15",
		);
	});
	it("records the local token guard with the effective token limit", async () => {
		const { state } = await runTurn(mocks, {
			advisorBudgetEnabled: !mocks.off.has(PATCH),
			message: "Read",
			modeConfig: { maxIterations: 30, maxTotalTokens: 8_020 },
			steps: [{ calls: [call] }, { answer: summary }],
		});
		expect(state.budgetStop).toEqual({
			version: 1,
			kind: "token_budget",
			used: 36,
			limit: 20,
			maxTokens: 8_020,
			reservedTokens: 8_000,
		});
	});
});

it("preserves the earlier synthesis prompt without its write-outcome marker", async () => {
	mocks.off.add("orch-synthesis-write-outcomes-v1");
	const { seen } = await run(30, 30);
	expect(seen.at(-1)?.systemPrompt).not.toContain(
		"write whose outcome is unknown",
	);
});

afterEach(() => vi.restoreAllMocks());
it.each([2699, 2700, 2800])(
	"checks elapsed seconds before the next main round at %s",
	async (seconds) => {
		vi.spyOn(Date, "now").mockReturnValue(0);
		const { state, result, seen } = await runTurn(mocks, {
			advisorBudgetEnabled: !mocks.off.has(PATCH),
			message: "Finish the example report",
			modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
			steps: [
				() => {
					vi.mocked(Date.now).mockReturnValue(seconds * 1000);
					return { calls: [call] };
				},
				{ answer: summary },
			],
		});
		expect(state.mainRounds).toBe(seconds < 2700 ? 2 : 1);
		expect(state.budgetStop).toEqual(
			seconds < 2700
				? undefined
				: {
						version: 1,
						kind: "time_limit",
						used: seconds,
						limit: 2700,
					},
		);
		expect(result.data?.finalResponse).toBe(summary);
		if (seconds >= 2700) {
			expect(state.limitSignals).toContainEqual(
				expect.objectContaining({
					budgetLimit: "time",
					budget: undefined,
				}),
			);
			expect(state.pendingHandoff).toEqual({
				reason: `Time limit reached: ${seconds}/2700 seconds`,
				summary,
			});
			expect(seen.at(-1)?.tools).toEqual([]);
		}
	},
);
it("keeps a pre-marker run on its earlier round and token guards after 45 minutes", async () => {
	mocks.off.add(PATCH);
	vi.spyOn(Date, "now").mockReturnValue(0);
	const { state } = await runTurn(mocks, {
		advisorBudgetEnabled: !mocks.off.has(PATCH),
		message: "Finish the example report",
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			() => {
				vi.mocked(Date.now).mockReturnValue(2800 * 1000);
				return { calls: [call] };
			},
			{ answer: summary },
		],
	});
	expect(state.budgetStop).toBeUndefined();
	expect(state.pendingHandoff).toBeNull();
});

it("counts time spent before the loop and emits a time signal before starting a round", async () => {
	vi.mocked(Date.now).mockReturnValue(2700 * 1000);
	const { state, seen, result } = await runTurn(mocks, {
		advisorBudgetEnabled: !mocks.off.has(PATCH),
		message: "Finish the example report",
		steps: [{ answer: summary }],
	});
	expect(state.mainRounds).toBe(0);
	expect(state.budgetStop).toEqual({
		version: 1,
		kind: "time_limit",
		used: 2700,
		limit: 2700,
	});
	expect(state.limitSignals).toContainEqual(
		expect.objectContaining({ budgetLimit: "time", budget: undefined }),
	);
	expect(seen).toHaveLength(1);
	expect(seen[0].tools).toEqual([]);
	expect(result.data?.finalResponse).toBe(summary);
});
