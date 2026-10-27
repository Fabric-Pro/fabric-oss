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
	installDefaultStubs,
	runTurn,
	toolMessage,
} from "./advisor-scenario-harness";

const harmless = {
	name: "delegate_to_analyst",
	args: { message: 'Summarize commits: "removed all obsolete code"' },
};
async function run(call = harmless) {
	return runTurn(mocks, {
		message: "Summarize today's commits",
		steps: [{ calls: [call] }, { answer: "Summary" }],
	});
}
beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Summary",
		durationMs: 1,
		status: "completed",
	});
	mocks
		.stub("createOrchestratorApprovalRequest")
		.mockResolvedValue({ approvalId: "example-approval" });
	mocks.stub("judgeDelegationRiskActivity").mockResolvedValue({
		clear: true,
		judgedBy: "decision",
		usage: { inputTokens: 20, outputTokens: 1 },
	});
});
describe("delegation risk in the loop", () => {
	it("runs a harmless keyword task with no approval on a clear verdict", async () => {
		const { state } = await run();
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).not.toHaveBeenCalled();
		expect(mocks.stub("executeAgentAsTool")).toHaveBeenCalledOnce();
		expect(state.toolCalls[0].status).toBe("success");
		expect(state.iterationCosts).toContainEqual(
			expect.objectContaining({ inputTokens: 20, outputTokens: 1 }),
		);
	});
	it.each(["unclear", "throws"])(
		"keeps approval when judge %s",
		async (verdict) => {
			if (verdict === "throws") {
				mocks
					.stub("judgeDelegationRiskActivity")
					.mockRejectedValue(new Error("Judge timeout"));
			} else {
				mocks
					.stub("judgeDelegationRiskActivity")
					.mockResolvedValue({ clear: false, judgedBy: "none" });
			}
			await run();
			expect(
				mocks.stub("createOrchestratorApprovalRequest"),
			).toHaveBeenCalledWith(
				expect.objectContaining({
					riskLevel: "critical",
					riskScore: 95,
					stepDescription:
						"Tool: delegate_to_analyst - This action will delete or remove items in bulk using delegate_to_analyst. Please review before proceeding.",
				}),
			);
			expect(mocks.stub("executeAgentAsTool")).not.toHaveBeenCalled();
		},
	);
	it("rethrows a judge turn stop and passes the turn scope", async () => {
		const stop = new ActivityFailure(
			"Stopped",
			"judgeDelegationRiskActivity",
			"1",
			RetryState.NON_RETRYABLE_FAILURE,
			"example-worker",
			ApplicationFailure.create({
				type: "TurnNotDispatchable",
				message: "Stopped",
				nonRetryable: true,
				details: [{ reason: "cancelled" }],
			}),
		);
		mocks.stub("judgeDelegationRiskActivity").mockRejectedValue(stop);
		const turnScope = {
			turnId: "example-turn",
			executionId: "exec-advisor-1",
			userId: "user-1",
			organizationId: "org-1",
		};
		await expect(
			runTurn(mocks, {
				message: "Summarize commits",
				turn: { cancellationAware: true, turnScope },
				steps: [{ calls: [harmless] }],
			}),
		).rejects.toBe(stop);
		expect(mocks.stub("judgeDelegationRiskActivity")).toHaveBeenCalledWith(
			expect.objectContaining({ turnScope }),
		);
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).not.toHaveBeenCalled();
		expect(mocks.stub("executeAgentAsTool")).not.toHaveBeenCalled();
	});
	it("propagates a judge budget refusal without requesting approval", async () => {
		const refusal = new ActivityFailure(
			"Budget exhausted",
			"judgeDelegationRiskActivity",
			"1",
			RetryState.NON_RETRYABLE_FAILURE,
			"example-worker",
			ApplicationFailure.create({
				type: "TurnBudgetExhausted",
				message: "Allowance exhausted",
				nonRetryable: true,
			}),
		);
		mocks.stub("judgeDelegationRiskActivity").mockRejectedValue(refusal);
		await expect(
			runTurn(mocks, {
				message: "Summarize commits",
				turn: {
					cancellationAware: true,
					turnScope: {
						turnId: "example-turn",
						executionId: "exec-advisor-1",
						userId: "user-1",
						organizationId: "org-1",
					},
				},
				steps: [{ calls: [harmless] }, { answer: "Summary" }],
			}),
		).rejects.toBe(refusal);
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).not.toHaveBeenCalled();
		expect(mocks.stub("executeAgentAsTool")).not.toHaveBeenCalled();
	});
	it("preserves success for a failed delegation without the status patch marker", async () => {
		mocks.off.add("orch-delegation-status-v1");
		mocks.stub("executeAgentAsTool").mockResolvedValue({
			output: "Delegation response",
			durationMs: 1,
			status: "failed",
		});
		const { state, seen } = await run({
			name: harmless.name,
			args: { message: "Summarize commits" },
		});
		expect(state.toolCalls[0].status).toBe("success");
		expect(toolMessage(seen, 1, "call-1-0")).toBe("Delegation response");
	});
	it("keeps approval for a non-delegation tool with message keywords", async () => {
		await run({
			name: "send_message",
			args: { message: "remove all obsolete records" },
		});
		expect(
			mocks.stub("judgeDelegationRiskActivity"),
		).not.toHaveBeenCalled();
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).toHaveBeenCalledOnce();
	});
	it("omits zero-usage judge cost entries", async () => {
		mocks.stub("judgeDelegationRiskActivity").mockResolvedValue({
			clear: false,
			judgedBy: "none",
			usage: { inputTokens: 0, outputTokens: 0 },
		});
		const { state } = await run();
		expect(state.iterationCosts).not.toContainEqual(
			expect.objectContaining({ inputTokens: 0, outputTokens: 0 }),
		);
	});

	it("does not judge an already low-risk delegation", async () => {
		await run({
			name: harmless.name,
			args: { message: "Summarize commits" },
		});
		expect(
			mocks.stub("judgeDelegationRiskActivity"),
		).not.toHaveBeenCalled();
		expect(mocks.stub("executeAgentAsTool")).toHaveBeenCalledOnce();
	});
	it("does not judge a keyword in the tool name", async () => {
		await run({ ...harmless, name: "delegate_to_remove_agent" });
		expect(
			mocks.stub("judgeDelegationRiskActivity"),
		).not.toHaveBeenCalled();
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).toHaveBeenCalledOnce();
	});
	it.each([true, false])(
		"preserves approval without the patch marker (legacy=%s)",
		async (legacy) => {
			if (legacy) {
				mocks.off.add("orch-risk-read-only-exempt-v1");
			}
			mocks.off.add("orch-risk-delegation-judge-v1");
			await run();
			expect(
				mocks.stub("judgeDelegationRiskActivity"),
			).not.toHaveBeenCalled();
			expect(
				mocks.stub("createOrchestratorApprovalRequest"),
			).toHaveBeenCalledOnce();
		},
	);
	it("does not clear a modification keyword in the agent name", async () => {
		await run({
			name: "delegate_to_update_agent",
			args: { message: "Summarize all commits" },
		});
		expect(
			mocks.stub("judgeDelegationRiskActivity"),
		).not.toHaveBeenCalled();
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).toHaveBeenCalledOnce();
	});
	it("does not clear keywords outside the message", async () => {
		await run({
			name: harmless.name,
			args: { message: "Summarize commits", extra: "remove all" },
		} as typeof harmless);
		expect(
			mocks.stub("judgeDelegationRiskActivity"),
		).not.toHaveBeenCalled();
		expect(
			mocks.stub("createOrchestratorApprovalRequest"),
		).toHaveBeenCalledOnce();
	});
	it.each(["failed", "input-required", "completed", undefined])(
		"records delegation status %s",
		async (status) => {
			mocks.stub("executeAgentAsTool").mockResolvedValue({
				output: "Delegation response",
				durationMs: 1,
				...(status ? { status } : {}),
			});
			const { state, seen } = await run({
				name: harmless.name,
				args: { message: "Summarize commits" },
			});
			const failed = status === "failed" || status === "input-required";
			expect(state.toolCalls[0].status).toBe(
				failed ? "error" : "success",
			);
			const content = toolMessage(seen, 1, "call-1-0");
			if (failed) {
				expect(content).toContain("error");
				if (status === "input-required") {
					expect(content).toContain(
						"delegated agent cancelled the task before finishing",
					);
				}
			} else {
				expect(content).toBe("Delegation response");
			}
		},
	);
});
