import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const activities = new Map<string, ReturnType<typeof vi.fn>>();
	return {
		off: new Set<string>(),
		stub: (name: string) => {
			let fn = activities.get(name);
			if (!fn) {
				fn = vi.fn();
				activities.set(name, fn);
			}
			return fn;
		},
		resetAll: () => {
			for (const fn of activities.values()) {
				fn.mockReset();
			}
		},
	};
});
vi.mock("@temporalio/workflow", () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	patched: vi.fn((id: string) => !mocks.off.has(id)),
	proxyActivities: vi.fn(
		() =>
			new Proxy({}, { get: (_target, name) => mocks.stub(String(name)) }),
	),
}));

import { ApplicationFailure } from "@temporalio/common";
import { patched } from "@temporalio/workflow";
import { createInitialState } from "../../types";
import { executeIterativePhase } from "../iterative-execution";
import { installDefaultStubs } from "./advisor-scenario-harness";

beforeEach(() => {
	installDefaultStubs(mocks);
	vi.mocked(patched).mockClear();
	mocks.stub("preloadMcpToolsForConfigsActivity").mockResolvedValue([]);
});

describe("a usage refusal during final synthesis", () => {
	it.each(["iteration", "budget", "tool"] as const)(
		"surfaces synthesis refusal at %s while preserving both legacy markers",
		async (caller) => {
			for (const [skipEnabled, noticeEnabled] of [
				[true, true],
				[true, false],
				[false, true],
				[false, false],
			]) {
				installDefaultStubs(mocks);
				vi.mocked(patched).mockClear();
				mocks
					.stub("preloadMcpToolsForConfigsActivity")
					.mockResolvedValue([]);
				if (!noticeEnabled) {
					mocks.off.add("orch-synthesis-usage-limit-notice-v1");
				}
				if (!skipEnabled) {
					mocks.off.add("orch-synthesis-usage-limit-skip-v1");
				}
				mocks.stub("runAgentIteration").mockResolvedValue({
					type: "stream_error",
					message: "AI usage limit exceeded",
					partialResponse: "",
					usage: { inputTokens: 0, outputTokens: 0 },
					ledger: {
						allowance: 500000,
						measured: 475000,
						reserved: 0,
						attempted: 0,
					},
					usageLimit: {
						message: "AI usage limit exceeded",
						limitId: "example-limit",
						dimension: "TOKENS",
						window: "DAILY",
						used: "10",
						max: "10",
						manageLimitsUrl: "",
					},
				});
				if (caller === "budget") {
					mocks.stub("runAgentIteration").mockRejectedValueOnce(
						ApplicationFailure.create({
							type: "TurnBudgetExhausted",
							message: "Turn has used its token allowance",
							nonRetryable: true,
							details: [
								{
									kind: "EXPLORATION",
									room: 0,
									needed: 9000,
									snapshot: {
										allowance: 500000,
										measured: 470000,
										reserved: 0,
										attempted: 0,
									},
								},
							],
						}),
					);
				}
				if (caller === "tool") {
					mocks
						.stub("preloadMcpToolsForConfigsActivity")
						.mockResolvedValue([
							{
								toolName: "example_get_file",
								description: "Read a file",
								inputSchema: { type: "object", properties: {} },
								serverName: "Example",
								configId: "example-config",
							},
						]);
					mocks.stub("executeMcpTool").mockResolvedValue({
						output: { error: "File unavailable" },
						success: false,
						durationMs: 1,
						cached: false,
					});
					for (let i = 0; i < 3; i++) {
						mocks.stub("runAgentIteration").mockResolvedValueOnce({
							type: "tool_calls",
							toolCalls: [
								{
									id: `example-call-${i}`,
									name: "example_get_file",
									args: {},
								},
							],
							usage: { inputTokens: 10, outputTokens: 5 },
						});
					}
				}
				const input = {
					executionId: "example-execution",
					userId: "example-user",
					organizationId: "example-org",
					message: "Summarize the findings",
					history: [],
					enabledMcpConfigIds: ["example-config"],
					executionMode: "balanced" as const,
				};
				const state = createInitialState(input);
				state.enrichedMessage = input.message;
				const result = await executeIterativePhase(
					state,
					input,
					{ maxIterations: caller === "iteration" ? 1 : 20 } as never,
					{} as never,
					vi.fn(),
					vi.fn(),
					() => false,
					caller === "budget"
						? {
								cancellationAware: true,
								turnScope: {
									turnId: "example-turn",
									executionId: input.executionId,
									userId: input.userId,
									organizationId: input.organizationId,
									generation: 1,
									budgetContractVersion: 1,
								},
							}
						: undefined,
				);
				if (skipEnabled) {
					expect(patched).toHaveBeenCalledWith(
						"orch-synthesis-usage-limit-notice-v1",
					);
				} else {
					expect(patched).not.toHaveBeenCalledWith(
						"orch-synthesis-usage-limit-notice-v1",
					);
				}

				expect(mocks.stub("runAgentIteration")).toHaveBeenCalledTimes(
					(skipEnabled ? 1 : 2) +
						(caller === "tool" ? 3 : caller === "budget" ? 1 : 0),
				);
				expect(
					mocks.stub("runAgentIteration").mock.calls[
						caller === "tool" ? 3 : caller === "budget" ? 1 : 0
					]?.[0],
				).toMatchObject({
					availableTools: {},
					enableSkillTools: false,
				});
				expect(patched).toHaveBeenCalledWith(
					"orch-synthesis-usage-limit-skip-v1",
				);
				if (skipEnabled && noticeEnabled) {
					expect(result).toMatchObject({
						success: false,
						shouldContinue: false,
						usageLimit: { limitId: "example-limit" },
					});
					if (caller === "budget") {
						expect(state.budgetStop?.measured).toBe(475000);
					}
					continue;
				}
				expect(result.success).toBe(true);
				expect(result.data?.finalResponse).toBeTruthy();
				expect(result.data?.finalResponse).not.toContain(
					"AI usage limit exceeded",
				);
			}
		},
	);
});
