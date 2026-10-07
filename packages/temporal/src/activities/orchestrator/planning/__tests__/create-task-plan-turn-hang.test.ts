/**
 * Advisor Stop on a Planner chat, end to end through the production path for
 * one real Planner activity: `createTaskPlan` run by the worker's
 * turn-dispatch interceptor, with its planning model wrapped by the same
 * `@repo/ai` dispatch-guard middleware the model factory applies.
 *
 * The planning request hangs until its abort signal fires. While it hangs,
 * the activity's turn heartbeat ticker must keep beating (Temporal delivers a
 * cancel only in a heartbeat response), and cancelling the activity must
 * abort the request in flight and fail the activity with the cancellation,
 * with no retried request and no fallback plan. Removing the ticker leaves
 * the activity silent while it waits; skipping the interceptor leaves the
 * request with no abort signal, so it hangs past the cancel.
 */

import { wrapModelWithDispatchGuard } from "@repo/ai/lib/dispatch-guard-middleware";
import { CancelledFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	checkDispatchable: vi.fn(),
	model: undefined as unknown,
	requests: 0,
	abortedAt: undefined as number | undefined,
}));

// Explicit mock (no importOriginal): the real @repo/database would keep
// pg.Pool handles alive past vitest exit.
vi.mock("@repo/database", () => ({
	checkConversationTurnDispatchable: h.checkDispatchable,
	db: {
		agent: { findMany: vi.fn(async () => []) },
	},
}));

// `generateText` is the AI SDK's own (what @repo/ai re-exports).
vi.mock("@repo/ai", () => ({ generateText }));

vi.mock("../../utils", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getAiModel: vi.fn(async () => h.model),
}));

vi.mock("../../../prompts", () => ({
	getTaskPlanningSystemPrompt: vi.fn(() => "Plan the task."),
}));

import { TurnDispatchActivityInboundInterceptor } from "../../../../lib/turn-dispatch-interceptor";
import type { CreateTaskPlanInput } from "../../types";
import { createTaskPlan } from "../create-task-plan";

const TURN_SCOPE = {
	turnId: "turn-example-1",
	executionId: "orch-example-1",
	userId: "user-example-1",
	organizationId: "org-example-1",
};

const INPUT: CreateTaskPlanInput = {
	message: "Summarize the launch plan",
	routingDecision: {
		primaryAgent: "researcher",
		secondaryAgents: [],
		suggestedStrategy: "agent",
		riskLevel: "low",
		riskFactors: [],
		confidence: 0.8,
		reasoning: "A research task",
		useMcpDirect: false,
		matchedMcpTools: [],
	},
	userId: TURN_SCOPE.userId,
	organizationId: TURN_SCOPE.organizationId,
	executionMode: "save_reuse",
	turnScope: TURN_SCOPE,
};

/**
 * A provider whose request only ends when its abort signal fires, wrapped
 * the way the `@repo/ai` model factory wraps every model it returns.
 */
function installHangingFactoryModel() {
	h.requests = 0;
	h.abortedAt = undefined;
	h.model = wrapModelWithDispatchGuard(
		new MockLanguageModelV4({
			doGenerate: async (options) => {
				h.requests++;
				await new Promise<void>((_resolve, reject) => {
					options.abortSignal?.addEventListener("abort", () => {
						h.abortedAt = Date.now();
						reject(options.abortSignal?.reason);
					});
				});
				throw new Error("unreachable");
			},
		}),
	);
}

/** Runs the activity the way the worker does: through the interceptor. */
function runThroughInterceptor(env: MockActivityEnvironment) {
	const interceptor = new TurnDispatchActivityInboundInterceptor();
	return env.run(() =>
		interceptor.execute({ args: [INPUT], headers: {} } as never, (input) =>
			createTaskPlan(input.args[0] as CreateTaskPlanInput),
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	h.checkDispatchable.mockResolvedValue({ ok: true });
	installHangingFactoryModel();
});

describe("createTaskPlan in a Planner turn, with the planning request hanging", () => {
	it("keeps heartbeating while it waits; a cancel aborts the request and fails the activity, with no retry or fallback plan", async () => {
		const env = new MockActivityEnvironment();
		const beats: number[] = [];
		env.on("heartbeat", () => {
			beats.push(Date.now());
		});

		const outcome = runThroughInterceptor(env).then(
			(plan) => ({ ok: true as const, plan }),
			(error: unknown) => ({ ok: false as const, error }),
		);

		// The request is in flight...
		await vi.waitFor(
			() => {
				expect(h.requests).toBe(1);
			},
			{ timeout: 5_000, interval: 20 },
		);
		// ...and the ticker beats more than once while it hangs (every 5 s).
		await vi.waitFor(
			() => {
				expect(beats.length).toBeGreaterThan(1);
			},
			{ timeout: 8_000, interval: 100 },
		);
		expect(h.abortedAt).toBeUndefined();

		const cancelledAt = Date.now();
		env.cancel();
		const result = await outcome;

		// The cancel aborted the request in flight...
		expect(h.abortedAt).toBeDefined();
		expect((h.abortedAt as number) - cancelledAt).toBeLessThan(1_000);
		// ...and the activity failed with the cancellation, not a plan.
		expect(result.ok).toBe(false);
		expect((result as { error: unknown }).error).toBeInstanceOf(
			CancelledFailure,
		);
		// No retried request and no fallback plan after the stop.
		expect(h.requests).toBe(1);
		// The ticker stopped with the activity.
		const beatsAtEnd = beats.length;
		await new Promise((resolve) => setTimeout(resolve, 5_500));
		expect(beats.length).toBe(beatsAtEnd);
	}, 30_000);
});
