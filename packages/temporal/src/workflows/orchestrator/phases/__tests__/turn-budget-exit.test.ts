/**
 * Every token-allowance refusal on a ledgered turn reaches the iterative
 * phase's one budget exit, and the stop it records reflects the ledger after
 * the finalization.
 *
 * The finalization synthesis is shared by three callers: the budget exit
 * itself, the iteration-limit stop and the per-round tool-failure breaker.
 * A refusal of the synthesis request used to be swallowed for all three, so
 * the breaker's turn ended COMPLETED and the iteration-limit turn kept its
 * step-budget handoff with the new-chat action, neither with a `budgetStop`.
 * Now only the budget exit answers a refusal locally; the other two
 * propagate it there, which records the structured stop and writes the
 * static summary without asking for another (equally refused) request.
 *
 * Same harness as `tool-failure-breaker.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked, and
 * the model scripted turn by turn.
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

import type { IterativeTurnOptions } from "../../turn-contract";
import {
	type Call,
	finalResponse,
	installDefaultStubs,
	preloaded,
	runTurn,
	type Seen,
	type Step,
} from "./advisor-scenario-harness";

const TOOL = "example_get_file";

const LEDGERED_TURN: IterativeTurnOptions = {
	cancellationAware: true,
	turnScope: {
		turnId: "turn-example-1",
		executionId: "exec-advisor-1",
		userId: "user-1",
		organizationId: "org-1",
		generation: 1,
		budgetContractVersion: 1,
	},
};

/** The reading a refusal carries. */
const AT_REFUSAL = {
	allowance: 500_000,
	finalizationReserve: 8_000,
	measured: 470_000,
	outstanding: 25_000,
	enforcement: "ENFORCED",
};

const SYNTHESIZED = `## Summary\nThe launch flag is enabled. ${"The flag is exported as true in src/flags.ts. ".repeat(8)}`;

beforeEach(() => {
	installDefaultStubs(mocks);
	mocks
		.stub("executeMcpTool")
		.mockImplementation(async (req: { args: Record<string, unknown> }) =>
			req.args.ref === "main"
				? {
						output: { error: "No commit found for the ref main" },
						success: false,
						durationMs: 1,
						cached: false,
					}
				: {
						output: "export const launchFlag = true;",
						success: true,
						durationMs: 1,
						cached: false,
					},
		);
});

function fileCall(path: string, ref = "abc123"): Call {
	return { name: TOOL, args: { path, ref } };
}

function turn(steps: Step[], modeConfig?: Record<string, unknown>) {
	return runTurn(mocks, {
		message: "Is the launch flag enabled?",
		preload: preloaded([TOOL], "cfg-repo", "Repository"),
		enabledMcpConfigIds: ["cfg-repo"],
		steps,
		modeConfig,
		turn: LEDGERED_TURN,
	});
}

/** The model calls made with no tools attached: the synthesis attempts. */
function synthesisCalls(seen: Seen[]): Seen[] {
	return seen.filter((s) => s.tools.length === 0);
}

function expectTokenStop(
	state: Awaited<ReturnType<typeof turn>>["state"],
	result: unknown,
	stopReason: "allowance_exhausted" | "finalization_unavailable",
) {
	expect(state.budgetStop).toMatchObject({
		kind: "token_allowance",
		stopReason,
	});
	expect(
		state.limitSignals.filter(
			(signal) =>
				signal.kind === "internal_budget" &&
				signal.budgetLimit === "tokens",
		),
	).toHaveLength(1);
	// No step-budget handoff and its new-chat action for a token stop.
	expect(state.pendingHandoff).toBeNull();
	expect(finalResponse(result)).not.toMatch(/new chat/i);
}

describe("a refused synthesis reaches the budget exit", () => {
	it("from the tool-failure breaker: LIMITED with the structured stop and the static summary, asked once", async () => {
		const { result, state, seen } = await turn([
			{ calls: [fileCall("src/a.ts", "main")] },
			{ calls: [fileCall("src/b.ts", "main")] },
			{ calls: [fileCall("src/c.ts", "main")] },
			// The breaker's synthesis does not fit what is left.
			{ refuse: "FINALIZATION", ledger: AT_REFUSAL },
		]);

		expect(result.success).toBe(true);
		expectTokenStop(state, result, "finalization_unavailable");
		expect(finalResponse(result)).toContain("token allowance");
		// The refused finalization is not asked for again.
		const syntheses = synthesisCalls(seen);
		expect(syntheses).toHaveLength(1);
		expect(syntheses[0]?.budgetAttemptKind).toBe("FINALIZATION");
		expect(state.budgetStop).toMatchObject({
			measured: 470_000,
			outstanding: 25_000,
		});
	});

	it("from the iteration-limit stop: LIMITED with the structured stop, not the step-budget handoff", async () => {
		const { result, state, seen } = await turn(
			[
				{ calls: [fileCall("src/flags.ts")] },
				{ calls: [fileCall("src/other.ts")] },
				{ refuse: "FINALIZATION", ledger: AT_REFUSAL },
			],
			// BUDGET.synthesisIterationReserve is 1: two rounds, then the stop.
			{ maxIterations: 3 },
		);

		expect(result.success).toBe(true);
		expectTokenStop(state, result, "finalization_unavailable");
		expect(synthesisCalls(seen)).toHaveLength(1);
	});

	it("from a main round: the finalization writes the answer, and the stop carries the ledger as it stands after it", async () => {
		const { result, state, seen } = await turn([
			{ refuse: "EXPLORATION", ledger: AT_REFUSAL },
			{
				answer: SYNTHESIZED,
				// The finalization used more tokens, on a model that cannot be
				// capped.
				ledger: {
					...AT_REFUSAL,
					measured: 476_000,
					outstanding: 0,
					enforcement: "MEASURED_ONLY",
				},
			},
		]);

		expect(result.success).toBe(true);
		expect(finalResponse(result)).toBe(SYNTHESIZED);
		expect(seen[0]?.budgetAttemptKind).toBe("EXPLORATION");
		expect(seen[1]?.budgetAttemptKind).toBe("FINALIZATION");
		// The finalization carries the user's request, which the activity
		// keeps when it shrinks the request to fit the room left; a main
		// round does not.
		expect(seen[1]?.finalizationQuestion).toBe(
			"Is the launch flag enabled?",
		);
		expect(seen[0]).not.toHaveProperty("finalizationQuestion");
		expect(state.budgetStop).toEqual({
			kind: "token_allowance",
			allowance: 500_000,
			measured: 476_000,
			outstanding: 0,
			enforcement: "MEASURED_ONLY",
			stopReason: "allowance_exhausted",
		});
		const signal = state.limitSignals.find(
			(s) => s.kind === "internal_budget" && s.budgetLimit === "tokens",
		);
		expect(signal?.budget).toMatchObject({ used: 476_000, total: 500_000 });
		expect(state.pendingHandoff).toBeNull();
	});

	it("leaves a turn without the budget contract on its legacy iteration-limit stop", async () => {
		const { state } = await runTurn(mocks, {
			message: "Is the launch flag enabled?",
			preload: preloaded([TOOL], "cfg-repo", "Repository"),
			enabledMcpConfigIds: ["cfg-repo"],
			steps: [
				{ calls: [fileCall("src/flags.ts")] },
				{ calls: [fileCall("src/other.ts")] },
				{ answer: SYNTHESIZED },
			],
			modeConfig: { maxIterations: 3 },
		});
		expect(state.budgetStop).toBeUndefined();
		expect(state.pendingHandoff).not.toBeNull();
	});

	it("sends a turn without the budget contract no finalization fields", async () => {
		const { seen } = await runTurn(mocks, {
			message: "Is the launch flag enabled?",
			preload: preloaded([TOOL], "cfg-repo", "Repository"),
			enabledMcpConfigIds: ["cfg-repo"],
			steps: [
				{ calls: [fileCall("src/flags.ts")] },
				{ calls: [fileCall("src/other.ts")] },
				{ answer: SYNTHESIZED },
			],
			modeConfig: { maxIterations: 3 },
			turn: {
				cancellationAware: true,
				turnScope: {
					turnId: "turn-example-1",
					executionId: "exec-advisor-1",
					userId: "user-1",
					organizationId: "org-1",
				},
			},
		});
		const synthesis = synthesisCalls(seen)[0];
		expect(synthesis).toBeDefined();
		expect(synthesis).not.toHaveProperty("budgetAttemptKind");
		expect(synthesis).not.toHaveProperty("finalizationQuestion");
	});
});
