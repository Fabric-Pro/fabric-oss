import { afterEach, beforeEach, expect, it, vi } from "vitest";

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

import { log } from "@temporalio/workflow";
import {
	installDefaultStubs,
	runTurn,
	preloaded,
} from "./advisor-scenario-harness";

const PATCH = "orch-bounded-history-v1";
const body = "Example tool observation ".repeat(70);
const summary = "Example answer. ".repeat(40);
const call = { name: "delegate_to_analyst", args: { message: "Read example" } };
beforeEach(() => {
	installDefaultStubs(mocks);
	mocks.off.add("orch-bounded-history-v2");
	vi.mocked(log.info).mockClear();
	vi.spyOn(Date, "now").mockReturnValue(0);
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: body,
		durationMs: 1,
		status: "completed",
	});
	mocks.stub("judgeDelegationRiskActivity").mockResolvedValue({
		clear: true,
		judgedBy: "decision",
		usage: { inputTokens: 20, outputTokens: 1 },
	});
});
afterEach(() => vi.restoreAllMocks());
async function run(
	input: Record<string, unknown> = {
		turnId: "turn-example",
		historyRetention: "bounded",
	},
) {
	return runTurn(mocks, {
		advisorBudgetEnabled: true,
		input,
		message: "Read example",
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: 5 }, () => ({ calls: [call] })),
			{ answer: summary },
		],
	});
}
it("keeps an early tool result intact while the next requests fit", async () => {
	const { seen } = await run();
	expect(
		seen[4].history.find((message) => message.role === "tool")?.content,
	).toContain(body);
});
it.each(["off", "non-chat", "pre-marker"])(
	"preserves age pruning for %s",
	async (mode) => {
		if (mode === "pre-marker") {
			mocks.off.add(PATCH);
		}
		const input =
			mode === "off"
				? { turnId: "turn-example" }
				: mode === "non-chat"
					? { historyRetention: "bounded" }
					: { turnId: "turn-example", historyRetention: "bounded" };
		const { seen } = await run(input);
		expect(
			seen[4].history.find((message) => message.role === "tool")?.content,
		).toContain("[Previous tool result pruned");
	},
);
it("accepts old activity results without request observations", async () => {
	const { result, seen } = await run();
	expect(result.success).toBe(true);
	expect(seen).toHaveLength(6);
	expect(
		vi
			.mocked(log.info)
			.mock.calls.filter(([name]) => name === "advisor.request_shape"),
	).toHaveLength(0);
});

it("resets eligible history toward half-cap and retains it on the following round", async () => {
	mocks.stub("executeAgentAsTool").mockResolvedValue({
		output: "Observation ".repeat(800),
		durationMs: 1,
		status: "completed",
	});
	const { seen } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: 12 }, () => ({ calls: [call] })),
			{ answer: summary },
		],
	});
	const logs = vi
		.mocked(log.info)
		.mock.calls.filter(
			([event, details]) =>
				event === "advisor.history_retention" &&
				(details as { pruned: number }).pruned > 0,
		)
		.map(
			([, details]) =>
				details as {
					iteration: number;
					beforeTokens: number;
					afterTokens: number;
				},
		);
	expect(logs.length).toBeGreaterThan(0);
	for (const reset of logs) {
		expect(reset.beforeTokens).toBeGreaterThan(32_000);
		expect(reset.afterTokens).toBeLessThan(reset.beforeTokens);
		expect(
			logs.some((next) => next.iteration === reset.iteration + 1),
		).toBe(false);
		if (reset.iteration < seen.length) {
			const before = seen[reset.iteration - 1].history;
			const after = seen[reset.iteration].history;
			for (let index = 0; index < before.length; index++) {
				expect(after[index]).toEqual(before[index]);
			}
		}
	}
});

it.each(["bytes", "allowance"])(
	"runs the protected pruning path for the %s limit",
	async (reason) => {
		const input = {
			turnId: "turn-example",
			historyRetention: "bounded",
			...(reason === "bytes"
				? { userId: "界".repeat(180_000) }
				: { turnTokenAllowance: 20_000 }),
		};
		const { seen } = await run(input);
		const resets = vi
			.mocked(log.info)
			.mock.calls.filter(
				([event, details]) =>
					event === "advisor.history_retention" &&
					(details as { pruned: number }).pruned > 0,
			);
		expect(resets.length).toBeGreaterThan(0);
		expect(resets[0][1]).toMatchObject({ reason });
		expect(
			seen[4].history.find((message) => message.role === "tool")?.content,
		).toContain("[Previous tool result pruned");
	},
);

it.each([false, true])(
	"keeps the ledger refusal exit with bounded retention %s",
	async (enabled) => {
		const ledger = {
			allowance: 500_000,
			finalizationReserve: 8_000,
			measured: 470_000,
			outstanding: 25_000,
			enforcement: "ENFORCED",
		};
		const { state, result, seen } = await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: {
				turnId: "turn-example",
				...(enabled ? { historyRetention: "bounded" } : {}),
			},
			message: "Read example",
			turn: {
				cancellationAware: true,
				turnScope: {
					turnId: "turn-example",
					executionId: "exec-advisor-1",
					userId: "user-1",
					organizationId: "org-1",
					generation: 1,
					budgetContractVersion: 1,
				},
			},
			steps: [
				{ refuse: "EXPLORATION", ledger },
				{ answer: summary, ledger },
			],
		});
		expect(state.budgetStop).toMatchObject({
			kind: "token_allowance",
			stopReason: "allowance_exhausted",
		});
		expect(result.success).toBe(true);
		expect(seen).toHaveLength(2);
		expect(seen[1].budgetAttemptKind).toBe("FINALIZATION");
	},
);
it.each(["rounds", "tokens", "deadline"])(
	"preserves the %s stop with bounded retention",
	async (limit) => {
		const { state, seen } = await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: { turnId: "turn-example", historyRetention: "bounded" },
			message: "Read example",
			modeConfig: {
				maxIterations: limit === "rounds" ? 1 : 30,
				maxTotalTokens: limit === "tokens" ? 8_001 : 1_000_000,
			},
			steps: [
				() => {
					if (limit === "deadline") {
						vi.mocked(Date.now).mockReturnValue(2_700_000);
					}
					return { calls: [call] };
				},
				{ answer: summary },
			],
		});
		expect(state.budgetStop?.kind).toBe(
			limit === "rounds"
				? "round_limit"
				: limit === "tokens"
					? "token_budget"
					: "time_limit",
		);
		expect(seen.at(-1)?.tools).toEqual([]);
	},
);

it("v2 keeps history append-only below its ceiling even when raw cumulative usage would compact", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
		summaryText: "Example compacted findings",
		usage: { inputTokens: 10, outputTokens: 2 },
	});
	const { createRequestFingerprint } = await import(
		"@repo/ai/lib/request-observation"
	);
	const requests = [
		{
			iteration: 1,
			activityAttempt: 1,
			request: 1,
			estimatedInputTokens: 200_000,
			inputTokens: 100_000,
			cacheReadTokens: 99_000,
			outputTokens: 1,
			fingerprint: createRequestFingerprint({
				modelId: "example",
				route: "example",
				prompt: [],
			}),
		},
	];
	const { seen, state } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: 12 }, (_, index) => ({
				calls: [call],
				usage: { inputTokens: 100_000, outputTokens: 1 },
				requests,
				ledger: {
					allowance: 1_000_000,
					finalizationReserve: 8_000,
					measured: 60_000 * (index + 1),
					outstanding: 0,
					enforcement: "ENFORCED",
				},
			})),
			{ answer: summary },
		],
	});
	expect(state.advisorCalibrationFactor).toBe(1); // The final old-shape observation has no reported count.
	expect(seen).toHaveLength(13);
	for (let index = 1; index < seen.length; index++) {
		expect(
			seen[index].history.slice(0, seen[index - 1].history.length),
		).toEqual(seen[index - 1].history);
	}
	expect(
		mocks.stub("compactConversationHistoryActivity"),
	).not.toHaveBeenCalled();
	expect(seen[1].turnNotice).toBeUndefined();
	expect(
		vi
			.mocked(log.info)
			.mock.calls.find(
				([event]) =>
					event === "[IterativeExecution] Iteration token usage",
			)?.[1],
	).toMatchObject({ cumulativeTokens: 60_000, tokenBudgetUsedPct: 6 });
});

it.each([true, false])(
	"uses charged ledger totals for warnings under weighted marker %s",
	async (weighted) => {
		if (!weighted) {
			mocks.off.add("orch-cache-weighted-allowance-v1");
		}
		const { seen } = await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: { turnId: "turn-example" },
			message: "Read example",
			modeConfig: { maxIterations: 30, maxTotalTokens: 100_000 },
			steps: [
				{
					calls: [call],
					usage: { inputTokens: 150_000, outputTokens: 1 },
					ledger: {
						allowance: 100_000,
						finalizationReserve: 8_000,
						measured: 10_000,
						outstanding: 0,
						enforcement: "ENFORCED",
					},
				},
				{ answer: summary },
			],
		});
		expect(seen).toHaveLength(2);
		expect(seen[1].turnNotice?.includes("BUDGET WARNING") ?? false).toBe(
			!weighted,
		);
		const usage = vi
			.mocked(log.info)
			.mock.calls.find(
				([event]) =>
					event === "[IterativeExecution] Iteration token usage",
			)?.[1];
		expect(usage).toMatchObject({
			cumulativeTokens: weighted ? 10_000 : 150_001,
			tokenBudgetUsedPct: weighted ? 11 : 163,
		});
	},
);

it("v2 calls the existing compaction fallback when a protected request remains above the byte cap", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
		summaryText: "Example compacted findings",
		usage: { inputTokens: 10, outputTokens: 2 },
	});
	await run({
		turnId: "turn-example",
		historyRetention: "bounded",
		userId: "界".repeat(180_000),
	});
	const fallbacks = vi
		.mocked(log.info)
		.mock.calls.filter(
			([event, details]) =>
				event === "advisor.history_retention" &&
				(details as { fellBackToCompaction?: boolean })
					.fellBackToCompaction,
		);
	expect(fallbacks.length).toBeGreaterThan(0);
	expect(
		fallbacks.some(
			([, details]) =>
				(details as { keptNonReadOnlyResults: number })
					.keptNonReadOnlyResults > 0,
		),
	).toBe(true);
	expect(fallbacks[0][1]).toMatchObject({
		reason: "bytes",
		pruned: 0,
		tokensFreed: 0,
		fellBackToCompaction: true,
	});
	expect(mocks.stub("compactConversationHistoryActivity")).toHaveBeenCalled();
});

it.each(["fabric", "declared", "old-result"])(
	"v2 reset uses recorded read evidence from %s execution",
	async (mode) => {
		mocks.off.delete("orch-bounded-history-v2");
		const resultBody = "Example recorded result ".repeat(450);
		const readName =
			mode === "fabric" ? "code_file_get" : "GitHub__get_pull_request";
		mocks.stub("executeMcpTool").mockImplementation(async (request) => ({
			output: resultBody,
			success: true,
			durationMs: 1,
			cached: false,
			...(mode === "declared" && request.toolName === readName
				? { readOnly: true }
				: {}),
		}));
		mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
			summaryText: "Example compacted findings",
			usage: { inputTokens: 10, outputTokens: 2 },
		});
		const { seen } = await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: { turnId: "turn-example", historyRetention: "bounded" },
			message: "Read example",
			preload: [
				...preloaded(
					[readName],
					mode === "fabric"
						? "fabric-ai-server"
						: "github-connected:github:github-repos",
					"Example",
				),
				...preloaded(
					["example_update_record"],
					"example-config",
					"Example",
				),
			],
			modeConfig: { maxIterations: 40, maxTotalTokens: 1_000_000 },
			steps: [
				{
					calls: [
						{
							name: "example_update_record",
							args: { id: "example-record" },
						},
					],
				},
				...Array.from({ length: 25 }, () => ({
					calls: [{ name: readName, args: { path: "example.ts" } }],
				})),
				{ answer: summary },
			],
		});
		const resets = vi
			.mocked(log.info)
			.mock.calls.filter(
				([event, details]) =>
					event === "advisor.history_retention" &&
					(details as { pruned: number }).pruned > 0,
			);
		if (mode === "old-result") {
			expect(resets).toHaveLength(0);
			expect(
				seen
					.flatMap((round) => round.history)
					.some((message) => message.toolResultReadOnly === true),
			).toBe(false);
		} else {
			expect(resets.length).toBeGreaterThan(0);
			expect(resets[0][1]).toMatchObject({ keptNonReadOnlyResults: 1 });
			expect(
				(resets[0][1] as { tokensFreed: number }).tokensFreed,
			).toBeGreaterThanOrEqual(20_000);
			expect(
				seen
					.at(-1)
					?.history.find(
						(m) => m.role === "tool" && m.toolCallId === "call-1-0",
					)?.content,
			).toContain(resultBody);
			expect(
				seen
					.at(-1)
					?.history.some((m) =>
						m.content.startsWith("[Previous tool result pruned"),
					),
			).toBe(true);
		}
		const recordedRead = seen
			.flatMap((round) => round.history)
			.find((m) => m.role === "tool" && m.toolCallId === "call-2-0");
		expect(recordedRead?.toolResultReadOnly).toBe(
			mode === "declared" ? true : undefined,
		);
	},
);

it("v2 appends after a soft reset without invoking compaction", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "x".repeat(12_000),
		success: true,
		durationMs: 1,
		cached: false,
		readOnly: true,
	});
	mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
		summaryText: "Example compacted findings",
		usage: { inputTokens: 10, outputTokens: 2 },
	});
	const { seen } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		preload: preloaded(["code_file_get"], "fabric-ai-server", "Example"),
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: 12 }, () => ({
				calls: Array.from({ length: 8 }, (_, i) => ({
					name: "code_file_get",
					args: { path: `example-${i}.ts` },
				})),
			})),
			{ answer: summary },
		],
	});
	const decisions = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.history_retention")
		.map(
			([, details]) =>
				details as {
					iteration: number;
					action: string;
					reason: string;
					beforeTokens: number;
					reservation: number;
					room: number;
				},
		);
	const skipped = decisions.find((d) => d.reason === "consecutive_rewrite");
	expect(
		mocks.stub("compactConversationHistoryActivity"),
	).not.toHaveBeenCalled();
	expect(skipped).toMatchObject({ action: "append" });
	if (!skipped) {
		throw new Error("fixture needs a skipped soft reset");
	}
	expect(
		seen[skipped.iteration - 1].history.slice(
			0,
			seen[skipped.iteration - 2].history.length,
		),
	).toEqual(seen[skipped.iteration - 2].history);
	expect(skipped.reservation).toBeGreaterThan(0);
	expect(skipped.room).toBeGreaterThan(skipped.reservation + 16_384);
});

it("v2 records a compaction as the preceding rewrite before a soft round", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks
		.stub("executeSkillToolActivity")
		.mockResolvedValue("x".repeat(63_000));
	mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
		summaryText: "Example compacted findings",
		usage: { inputTokens: 10, outputTokens: 2 },
	});
	const { createRequestFingerprint } = await import(
		"@repo/ai/lib/request-observation"
	);
	const requests = [
		{
			iteration: 1,
			activityAttempt: 1,
			request: 1,
			estimatedInputTokens: 100,
			inputTokens: 200,
			outputTokens: 1,
			fingerprint: createRequestFingerprint({
				modelId: "example",
				route: "example",
				prompt: [],
			}),
		},
	];
	await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		preload: preloaded(["read_skill_file"], "example-config", "Example"),
		modeConfig: { maxIterations: 30, maxTotalTokens: 2_000_000 },
		steps: [
			...Array.from({ length: 12 }, (_, i) => ({
				calls: [
					{
						name: "read_skill_file",
						args: { path: `example-${i}.md` },
					},
				],
				requests,
			})),
			{ answer: summary },
		],
	});
	const decisions = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.history_retention")
		.map(
			([, details]) =>
				details as {
					iteration: number;
					action: string;
					reason: string;
					compacted: boolean;
				},
		);
	const compacted = decisions.find((d) => d.compacted);
	expect(compacted).toBeDefined();
	const following = decisions.find(
		(d) => d.iteration === (compacted?.iteration ?? 0) + 1,
	);
	expect(following).toMatchObject({
		action: "append",
		reason: "consecutive_rewrite",
	});
});

it.each(["empty", "failed"])(
	"v2 keeps a partial reset when compaction is %s",
	async (mode) => {
		mocks.off.delete("orch-bounded-history-v2");
		mocks.stub("executeMcpTool").mockResolvedValue({
			output: "x".repeat(12_000),
			success: true,
			durationMs: 1,
			cached: false,
		});
		if (mode === "failed") {
			mocks
				.stub("compactConversationHistoryActivity")
				.mockRejectedValue(new Error("Example summary failure"));
		} else {
			mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
				summaryText: "",
				usage: { inputTokens: 0, outputTokens: 0 },
			});
		}
		const { seen, state } = await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: {
				turnId: "turn-example",
				historyRetention: "bounded",
				userId: "界".repeat(180_000),
			},
			message: "Read example",
			preload: preloaded(
				["code_file_get"],
				"fabric-ai-server",
				"Example",
			),
			modeConfig: { maxIterations: 30, maxTotalTokens: 2_000_000 },
			steps: [
				...Array.from({ length: 10 }, () => ({
					calls: [
						{ name: "code_file_get", args: { path: "example.ts" } },
					],
				})),
				{ answer: summary },
			],
		});
		const decisions = vi
			.mocked(log.info)
			.mock.calls.filter(
				([event]) => event === "advisor.history_retention",
			)
			.map(
				([, details]) =>
					details as {
						iteration: number;
						action: string;
						pruned: number;
						compacted: boolean;
						tokensFreed: number;
						hardTrigger: boolean;
						softTrigger: boolean;
					},
			);
		const partials = decisions.filter(
			(d) => d.action === "compact" && d.pruned > 0,
		);
		expect(partials.length).toBeGreaterThan(0);
		for (const d of partials) {
			expect(d.compacted).toBe(false);
			expect(d.tokensFreed).toBeGreaterThan(0);
			expect(d.hardTrigger).toBe(true);
			expect(
				seen[d.iteration - 1].history.some((m) =>
					m.content.startsWith("[Previous tool result pruned"),
				),
			).toBe(true);
		}
		expect(state.advisorLastHistoryRewriteIteration).toBe(
			partials.at(-1)?.iteration,
		);
		const attempts = new Set(
			mocks
				.stub("compactConversationHistoryActivity")
				.mock.calls.map(([request]) => request.iteration),
		);
		expect(partials.some((d) => attempts.has(d.iteration))).toBe(true);
		expect(partials.some((d) => !attempts.has(d.iteration))).toBe(true);
	},
);

it("v2 logs a rescued refused reservation without invoking the compactor", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "x".repeat(12_000),
		success: true,
		durationMs: 1,
		cached: false,
		readOnly: true,
	});
	const { seen } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		preload: preloaded(
			["GitHub__get_pull_request"],
			"github-connected:github:github-repos",
			"Example",
		),
		modeConfig: { maxIterations: 30, maxTotalTokens: 1_000_000 },
		steps: [
			...Array.from({ length: 7 }, (_, i) => ({
				calls: [{ name: "GitHub__get_pull_request", args: { id: i } }],
				ledger: {
					allowance: 400_000,
					measured: i >= 5 ? 322_000 : 0,
					outstanding: 0,
					finalizationReserve: 48_000,
					enforcement: "ENFORCED",
				},
			})),
			{ answer: summary },
		],
	});
	const rescue = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.history_retention")
		.map(
			([, details]) =>
				details as {
					iteration: number;
					reason: string;
					action: string;
					hardTrigger: boolean;
					reservation: number;
					afterReservation: number;
					room: number;
					tokensFreed: number;
				},
		)
		.find((d) => d.reason === "allowance_refused");
	if (!rescue) {
		throw new Error("No allowance_refused retention decision");
	}
	expect(rescue).toMatchObject({
		action: "reset",
		hardTrigger: true,
		room: 30_000,
	});
	expect(rescue.reservation).toBeGreaterThan(30_000);
	expect(rescue.afterReservation).toBeLessThanOrEqual(30_000);
	expect(rescue.tokensFreed).toBeLessThan(20_000);
	expect(
		seen[rescue.iteration - 1].history.some((m) =>
			m.content.startsWith("[Previous tool result pruned"),
		),
	).toBe(true);
	expect(
		mocks.stub("compactConversationHistoryActivity"),
	).not.toHaveBeenCalled();
});

it("v2 skips allowance triggers for a bounded turn without a ledger", async () => {
	mocks.off.delete("orch-bounded-history-v2");
	mocks.stub("executeMcpTool").mockResolvedValue({
		output: "x".repeat(12_000),
		success: true,
		durationMs: 1,
		cached: false,
		readOnly: true,
	});
	const { state } = await runTurn(mocks, {
		advisorBudgetEnabled: true,
		input: { turnId: "turn-example", historyRetention: "bounded" },
		message: "Read example",
		preload: preloaded(
			["GitHub__get_pull_request"],
			"github-connected:github:github-repos",
			"Example",
		),
		modeConfig: { maxIterations: 30, maxTotalTokens: 92_000 },
		steps: [
			...Array.from({ length: 17 }, (_, i) => ({
				calls: [{ name: "GitHub__get_pull_request", args: { id: i } }],
			})),
			{ answer: summary },
		],
	});
	expect(state.turnLedger).toBeUndefined();
	const decisions = vi
		.mocked(log.info)
		.mock.calls.filter(([event]) => event === "advisor.history_retention")
		.map(
			([, d]) =>
				d as {
					action: string;
					beforeTokens: number;
					softCap: number;
					hardTrigger: boolean;
				},
		);
	expect(decisions).toHaveLength(18);
	for (const d of decisions) {
		expect(d.beforeTokens).toBeLessThan(d.softCap);
		expect(d.hardTrigger).toBe(false);
		expect(d.action).toBe("append");
	}
});

it.each(["Example compacted findings", ""])(
	"v2 logs room after compaction's charge with summary %j",
	async (summaryText) => {
		mocks.off.delete("orch-bounded-history-v2");
		mocks
			.stub("executeSkillToolActivity")
			.mockResolvedValue("x".repeat(63_000));
		mocks.stub("compactConversationHistoryActivity").mockResolvedValue({
			summaryText,
			usage: { inputTokens: 10, outputTokens: 2 },
		});
		const ledger = {
			allowance: 2_000_000,
			measured: 1_000,
			outstanding: 0,
			finalizationReserve: 8_000,
			enforcement: "ENFORCED",
		};
		await runTurn(mocks, {
			advisorBudgetEnabled: true,
			input: { turnId: "turn-example", historyRetention: "bounded" },
			message: "Read example",
			preload: preloaded(
				["read_skill_file"],
				"example-config",
				"Example",
			),
			modeConfig: { maxIterations: 30, maxTotalTokens: 2_000_000 },
			steps: [
				...Array.from({ length: 11 }, (_, i) => ({
					calls: [
						{
							name: "read_skill_file",
							args: { path: `example-${i}.md` },
						},
					],
					ledger,
				})),
				{ answer: summary, ledger },
			],
		});
		const attempted = new Set(
			mocks
				.stub("compactConversationHistoryActivity")
				.mock.calls.map(([request]) => request.iteration),
		);
		expect(attempted.size).toBeGreaterThan(0);
		const decisions = vi
			.mocked(log.info)
			.mock.calls.filter(
				([event]) => event === "advisor.history_retention",
			)
			.map(
				([, d]) =>
					d as { iteration: number; room: number; afterRoom: number },
			);
		for (const decision of decisions.filter((d) =>
			attempted.has(d.iteration),
		)) {
			expect(decision.afterRoom).toBe(decision.room - 12);
		}
	},
);
