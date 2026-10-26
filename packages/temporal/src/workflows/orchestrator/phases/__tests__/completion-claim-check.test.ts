import { recordTurnBudgetStop } from "../../turn-budget";
import { buildWorkflowOutput } from "../completion";
/**
 * A reply that claims an action in a turn that called no tool.
 *
 * On 2026-10-16 an Advisor turn answered "Done — I previously set this up ...
 * Also ran once immediately" for a workflow deleted hours earlier, with zero
 * tool calls: nothing was created and nothing ran. Under
 * `orch-completion-claim-check-v1` a turn that ends with a reply and called no
 * tool asks `checkCompletionClaimActivity` once; when the reply claims an
 * action, the turn gets one corrective round with the same tools, and that
 * round's answer is the turn's answer.
 *
 * Same harness as `tool-failure-breaker.test.ts`: the real
 * `executeIterativePhase`, the workflow SDK and activity proxy mocked, every
 * `patched()` marker ON unless a test switches one off, and the model
 * scripted round by round.
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

import {
	ActivityFailure,
	ApplicationFailure,
	RetryState,
} from "@temporalio/common";
import {
	COMPLETION_CLAIM_CHECK_PATCH,
	shouldCheckCompletionClaim,
} from "../../completion-claim-check";
import type { IterativeTurnOptions } from "../../turn-contract";
import {
	finalResponse,
	installDefaultStubs,
	preloaded,
	runTurn,
	type Step,
} from "./advisor-scenario-harness";

const REQUEST =
	"Every Monday at 08:00 Europe/London, write a short HTML status page for this project and publish it as an artifact here. Run it once now too.";
const FALSE_CLAIM =
	"Done — I previously set this up for the project. What's in place: a weekly schedule every Monday at 08:00 Europe/London. Also ran once immediately.";
const HONEST_ANSWER =
	"I have not set this up in this turn: no workflow was created and nothing ran. I can create the weekly workflow now if you confirm the details.";
const CORRECTION =
	"Your previous reply told the user that something was done, but you called no tool in this turn.";
const TOOL = "example_list_workflows";

const TURN: IterativeTurnOptions = {
	cancellationAware: true,
	turnScope: {
		turnId: "turn-example-1",
		executionId: "exec-advisor-1",
		userId: "user-1",
		organizationId: "org-1",
	},
};

/** What the workflow sees when the check activity was refused. */
function refusedActivity(type: string, details: Record<string, unknown>) {
	return new ActivityFailure(
		"Activity task failed",
		"checkCompletionClaimActivity",
		"1",
		RetryState.NON_RETRYABLE_FAILURE,
		"worker-1",
		ApplicationFailure.create({
			type,
			message: "Turn may not make another model request",
			nonRetryable: true,
			details: [details],
		}),
	);
}

function claimFound() {
	mocks.stub("checkCompletionClaimActivity").mockResolvedValue({
		unbackedClaim: true,
		correction: CORRECTION,
		judgedBy: "decision",
		usage: { inputTokens: 120, outputTokens: 1 },
	});
}

function turn(steps: Step[]) {
	return runTurn(mocks, {
		message: REQUEST,
		preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
		enabledMcpConfigIds: ["cfg-workflows"],
		steps,
	});
}

beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "No workflows found for this project.",
		success: true,
		durationMs: 1,
		cached: false,
	});
});

describe("a reply that claims an action with no tool call behind it", () => {
	it("gets one corrective round, whose answer replaces the claim", async () => {
		claimFound();

		const { result, seen, state } = await turn([
			{ answer: FALSE_CLAIM },
			{ answer: HONEST_ANSWER },
		]);

		expect(finalResponse(result)).toBe(HONEST_ANSWER);
		expect(seen).toHaveLength(2);
		const check = mocks.stub("checkCompletionClaimActivity");
		expect(check).toHaveBeenCalledTimes(1);
		expect(check).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: "org-1",
				projectId: "project-1",
				userRequest: REQUEST,
				reply: FALSE_CLAIM,
			}),
		);
		// The corrective round sees its own claim, then the host's note.
		const [claimed, note] = seen[1].history.slice(-2);
		expect(claimed).toMatchObject({
			role: "assistant",
			content: FALSE_CLAIM,
		});
		expect(note.role).toBe("user");
		expect(note.content).toContain("[Host note:");
		expect(note.content).toContain(CORRECTION);
		// The check's own tokens count against the turn's budget.
		expect(state.iterationCosts).toContainEqual(
			expect.objectContaining({ inputTokens: 120, outputTokens: 1 }),
		);
	});

	it("lets the corrective round do the work with its tools", async () => {
		claimFound();

		const { result, seen } = await turn([
			{ answer: FALSE_CLAIM },
			{ calls: [{ name: TOOL, args: {} }] },
			{ answer: HONEST_ANSWER },
		]);

		expect(finalResponse(result)).toBe(HONEST_ANSWER);
		expect(seen[1].tools).toContain(TOOL);
		expect(mocks.stub("executeMcpTool")).toHaveBeenCalledTimes(1);
		expect(
			mocks.stub("checkCompletionClaimActivity"),
		).toHaveBeenCalledTimes(1);
	});

	it("is checked once per turn, so a second unbacked reply stands", async () => {
		claimFound();

		const { result } = await turn([
			{ answer: FALSE_CLAIM },
			{ answer: `${FALSE_CLAIM} (again)` },
		]);

		expect(finalResponse(result)).toBe(`${FALSE_CLAIM} (again)`);
		expect(
			mocks.stub("checkCompletionClaimActivity"),
		).toHaveBeenCalledTimes(1);
	});
});

describe("replies the check leaves alone", () => {
	it("keeps a reply that makes no claim, in one round", async () => {
		const { result, seen } = await turn([{ answer: HONEST_ANSWER }]);

		expect(finalResponse(result)).toBe(HONEST_ANSWER);
		expect(seen).toHaveLength(1);
		expect(
			mocks.stub("checkCompletionClaimActivity"),
		).toHaveBeenCalledTimes(1);
	});

	it("does not check a turn that called a tool", async () => {
		const { result } = await turn([
			{ calls: [{ name: TOOL, args: {} }] },
			{ answer: HONEST_ANSWER },
		]);

		expect(finalResponse(result)).toBe(HONEST_ANSWER);
		expect(
			mocks.stub("checkCompletionClaimActivity"),
		).not.toHaveBeenCalled();
	});

	it("keeps the reply when the check itself fails", async () => {
		mocks
			.stub("checkCompletionClaimActivity")
			.mockRejectedValue(new Error("judge unavailable"));

		const { result, seen } = await turn([{ answer: FALSE_CLAIM }]);

		expect(finalResponse(result)).toBe(FALSE_CLAIM);
		expect(seen).toHaveLength(1);
	});

	it("keeps the reply when the turn's allowance refuses the check", async () => {
		mocks
			.stub("checkCompletionClaimActivity")
			.mockRejectedValue(
				refusedActivity("TurnBudgetExhausted", { kind: "AUXILIARY" }),
			);

		const { result, seen } = await runTurn(mocks, {
			message: REQUEST,
			preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
			enabledMcpConfigIds: ["cfg-workflows"],
			steps: [{ answer: FALSE_CLAIM }],
			turn: TURN,
		});

		// The answer already exists; a finalization request would only
		// replace it.
		expect(finalResponse(result)).toBe(FALSE_CLAIM);
		expect(seen).toHaveLength(1);
	});

	it("ends the turn when it is stopped during the check", async () => {
		const stop = refusedActivity("TurnNotDispatchable", {
			reason: "cancelled",
		});
		mocks.stub("checkCompletionClaimActivity").mockRejectedValue(stop);

		await expect(
			runTurn(mocks, {
				message: REQUEST,
				preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
				enabledMcpConfigIds: ["cfg-workflows"],
				steps: [{ answer: FALSE_CLAIM }],
				turn: TURN,
			}),
		).rejects.toBe(stop);
	});

	it("replays a history recorded before the marker without the check", async () => {
		mocks.off.add(COMPLETION_CLAIM_CHECK_PATCH);
		claimFound();

		const { result, seen } = await turn([{ answer: FALSE_CLAIM }]);

		expect(finalResponse(result)).toBe(FALSE_CLAIM);
		expect(seen).toHaveLength(1);
		expect(
			mocks.stub("checkCompletionClaimActivity"),
		).not.toHaveBeenCalled();
	});
});

describe("shouldCheckCompletionClaim", () => {
	const eligible = {
		enabled: true,
		alreadyChecked: false,
		toolRoundSeen: false,
		boundToolCount: 3,
	};

	it("checks a no-tool reply from a turn that had tools", () => {
		expect(shouldCheckCompletionClaim(eligible)).toBe(true);
	});

	it("skips a turn with no tools bound: it could not have acted", () => {
		expect(
			shouldCheckCompletionClaim({ ...eligible, boundToolCount: 0 }),
		).toBe(false);
	});

	it("skips once checked, after a tool round, or without the marker", () => {
		expect(
			shouldCheckCompletionClaim({ ...eligible, alreadyChecked: true }),
		).toBe(false);
		expect(
			shouldCheckCompletionClaim({ ...eligible, toolRoundSeen: true }),
		).toBe(false);
		expect(
			shouldCheckCompletionClaim({ ...eligible, enabled: false }),
		).toBe(false);
	});
});

it("includes a passing final claim check after the last ledger reading in the weighted card", async () => {
	mocks.stub("checkCompletionClaimActivity").mockResolvedValue({
		unbackedClaim: false,
		judgedBy: "decision",
		usage: { inputTokens: 120, outputTokens: 1 },
	});
	const { state } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example" },
		message: REQUEST,
		preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
		steps: [
			{
				answer: HONEST_ANSWER,
				ledger: {
					allowance: 300_000,
					measured: 1_000,
					outstanding: 200,
					finalizationReserve: 30_000,
					enforcement: "ENFORCED",
				},
			},
		],
	});
	expect(state.iterationCosts.at(-1)).toMatchObject({
		inputTokens: 120,
		outputTokens: 1,
	});
	expect(buildWorkflowOutput(state, "completed").tokenBudget).toMatchObject({
		used: 1_321,
		total: 300_000,
	});
});

it("absorbs the claim check into a later main-round reading without adding it twice", async () => {
	claimFound();
	const reading = (measured: number) => ({
		allowance: 300_000,
		measured,
		outstanding: 0,
		finalizationReserve: 30_000,
		enforcement: "ENFORCED",
	});
	const { state } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example" },
		message: REQUEST,
		preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
		steps: [
			{ answer: FALSE_CLAIM, ledger: reading(1_000) },
			{ answer: HONEST_ANSWER, ledger: reading(1_300) },
		],
	});
	expect(
		state.iterationCosts.some(
			(cost) => cost.inputTokens === 120 && cost.outputTokens === 1,
		),
	).toBe(true);
	expect(buildWorkflowOutput(state, "completed").tokenBudget?.used).toBe(
		1_300,
	);
});

it("absorbs previously unreported costs into a refusal reading", async () => {
	mocks.stub("checkCompletionClaimActivity").mockResolvedValue({
		unbackedClaim: false,
		judgedBy: "decision",
		usage: { inputTokens: 120, outputTokens: 1 },
	});
	const { state } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example" },
		message: REQUEST,
		preload: preloaded([TOOL], "cfg-workflows", "Workflows"),
		steps: [
			{
				answer: HONEST_ANSWER,
				ledger: {
					allowance: 300_000,
					measured: 1_000,
					outstanding: 0,
					finalizationReserve: 30_000,
					enforcement: "ENFORCED",
				},
			},
		],
	});
	recordTurnBudgetStop(
		state,
		{
			allowance: 300_000,
			measured: 1_400,
			outstanding: 0,
			finalizationReserve: 30_000,
			enforcement: "ENFORCED",
		},
		"allowance_exhausted",
	);
	expect(buildWorkflowOutput(state, "completed").tokenBudget?.used).toBe(
		1_400,
	);
});
