import { describe, expect, it } from "vitest";
import {
	boundedHistoryV2Decision,
	estimateIterationInputTokens,
	HISTORY_BYTE_CAP,
} from "../../advisor-history-retention";
import type { RiskAssessmentOptions } from "../../risk-assessment";
import type { IterativeMessage } from "../../types";
const pair = (
	id: number,
	chars = 32_000,
	name = "code_file_get",
): IterativeMessage[] => [
	{
		role: "assistant",
		content: "",
		timestamp: "2026-01-01",
		iteration: id >= 100 ? 1 : id,
		toolCalls: [{ id: `call-${id}`, name, args: {} }],
	},
	{
		role: "tool",
		content: "x".repeat(chars),
		toolCallId: `call-${id}`,
		timestamp: "2026-01-01",
		iteration: id >= 100 ? 1 : id,
	},
];
const input = (history: IterativeMessage[], extra = {}) => ({
	request: {
		conversationHistory: history,
		systemPrompt: "example",
		availableTools: {},
	},
	allowance: 1_000_000,
	spent: 0,
	finalizationReserve: 8_000,
	iteration: 20,
	riskOptionsByToolCallId: new Map<string, RiskAssessmentOptions>(
		history.flatMap((message) =>
			(message.toolCalls ?? []).map(
				(call) =>
					[
						call.id,
						{ rules: "fabric-gated-v2", fabricRouted: true },
					] as const,
			),
		),
	),
	...extra,
});
const history = (count = 8, chars = 32_000) =>
	Array.from({ length: count }, (_, index) => pair(index + 1, chars)).flat();

function resetBoundedHistoryV2<
	T extends Parameters<typeof boundedHistoryV2Decision>[0],
>(args: T) {
	const d = boundedHistoryV2Decision(args);
	if (d.pruned > 0) {
		args.request.conversationHistory.splice(
			0,
			args.request.conversationHistory.length,
			...d.history,
		);
	}
	return d;
}

describe("bounded v2 reset", () => {
	it("leaves earlier messages byte-identical below the ceiling across 20 appended rounds", () => {
		const h: IterativeMessage[] = [];
		for (let round = 1; round <= 20; round++) {
			const before = JSON.stringify(h);
			const refs = [...h];
			const reset = resetBoundedHistoryV2(input(h, { iteration: round }));
			expect(reset.action).toBe("append");
			expect(reset.pruned).toBe(0);
			expect(JSON.stringify(h)).toBe(before);
			expect(h).toEqual(refs);
			h.push(...pair(round, 8_000));
		}
	});
	it("keeps the three most recent pairs and protected bodies while clearing older results", () => {
		const h = history();
		h.unshift(
			...pair(100, 8_000, "load_skill"),
			...pair(101, 8_000, "read_skill_file"),
			...pair(102, 8_000, "fabric_get_frame"),
			...pair(103, 8_000, "fabric_get_project_document"),
			...pair(104, 8_000, "fabric_get_project_source"),
		);
		const protectedBodies = h
			.filter((m) => m.role === "tool")
			.slice(0, 5)
			.map((m) => m.content);
		const calls = h.filter((m) => m.role === "assistant");
		const reset = resetBoundedHistoryV2(input(h));
		expect(
			h
				.filter((m) => m.role === "tool")
				.slice(5, 10)
				.map((m) =>
					m.content.startsWith("[Previous tool result pruned"),
				),
		).toEqual([true, true, true, true, true]);
		expect(reset.pruned).toBe(5);
		expect(reset.tokensFreed).toBeGreaterThanOrEqual(20_000);
		expect(reset.after.hardLimit).toBe(false);
		expect(
			h
				.filter((m) => m.role === "tool")
				.slice(0, 5)
				.map((m) => m.content),
		).toEqual(protectedBodies);
		expect(
			h
				.filter((m) => m.role === "tool")
				.slice(-3)
				.map((m) => m.content.length),
		).toEqual([32_000, 32_000, 32_000]);
		expect(h.filter((m) => m.role === "assistant")).toEqual(calls);
		expect(
			h.filter((m) => m.role === "tool").map((m) => m.toolCallId),
		).toEqual(calls.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []));
	});
	it("keeps the oldest reset result when compaction is also required for context", () => {
		const h = history(4, 12_000);
		const before = JSON.stringify(h);
		const reset = resetBoundedHistoryV2(
			input(h, { contextWindow: 10_000 }),
		);
		expect(reset.reason).toBe("context");
		expect(reset.pruned).toBe(1);
		expect(reset.action).toBe("compact");
		expect(JSON.stringify(h)).not.toBe(before);
		expect(h[1].content).toContain("[Previous tool result pruned");
	});
	it("does not reset on a consecutive soft-limit round even when a large result ages out", () => {
		const h = history(8, 50_000);
		const reset = resetBoundedHistoryV2(
			input(h, { iteration: 20, contextWindow: 200_000 }),
		);
		expect(reset.pruned).toBe(5);
		expect(reset.after.tokens).toBeGreaterThan(50_000);
		h.push(...pair(21, 120_000));
		const before = JSON.stringify(h);
		const next = resetBoundedHistoryV2(
			input(h, {
				iteration: 21,
				lastRewrite: 20,
				contextWindow: 200_000,
			}),
		);
		expect(next.reason).toBe("consecutive_rewrite");
		expect(next.pruned).toBe(0);
		expect(next.before.hardLimit).toBe(false);
		expect(JSON.stringify(h)).toBe(before);
	});
	it("allows a consecutive reset when the byte cap forces it", () => {
		const h = history(8, 80_000);
		const reset = resetBoundedHistoryV2(
			input(h, {
				iteration: 21,
				lastRewrite: 20,
				calibrationFactor: 0.25,
			}),
		);
		expect(reset.reason).toBe("bytes");
		expect(reset.action).toBe("reset");
		expect(reset.pruned).toBe(5);
		expect(reset.after.bytes).toBeLessThan(HISTORY_BYTE_CAP);
	});
	it("compacts when the proposed byte reset remains above the cap", () => {
		const h = history(4, 60_000);
		const req = input(h);
		const request = { ...req.request, extra: "x".repeat(500_000) };
		const before = JSON.stringify(h);
		const reset = resetBoundedHistoryV2({ ...req, request });
		expect(reset.reason).toBe("bytes");
		expect(reset.pruned).toBe(1);
		expect(reset.action).toBe("compact");
		expect(JSON.stringify(h)).not.toBe(before);
	});
	it("retains untagged history and unmatched results", () => {
		const h = history();
		h.unshift({
			role: "tool",
			content: "unpaired".repeat(1_000),
			toolCallId: "missing",
			timestamp: "2026-01-01",
		});
		h[2].iteration = undefined;
		const reset = resetBoundedHistoryV2(input(h));
		expect(reset.pruned).toBe(4);
		expect(h[0].content).toContain("unpaired");
		expect(h[2].content).toBe("x".repeat(32_000));
	});
});

it("preserves the existing recent-iteration exemption even for more than three pairs", () => {
	const h = history();
	for (const message of h.slice(-10)) {
		message.iteration = 19;
	}
	const reset = resetBoundedHistoryV2(input(h, { iteration: 20 }));
	expect(reset.pruned).toBe(3);
	expect(
		h
			.filter((m) => m.role === "tool")
			.slice(-5)
			.map((m) => m.content.length),
	).toEqual([32_000, 32_000, 32_000, 32_000, 32_000]);
});

it.each([
	"fabric_create_frame",
	"fabric_update_frame",
	"delete_record",
	"fabric_run_workflow",
])(
	"keeps older %s results while clearing positively classified reads",
	(name) => {
		const h = [...pair(100, 32_000, name), ...history()];
		const original = h[1].content;
		const reset = resetBoundedHistoryV2(input(h));
		expect(h[1].content).toBe(original);
		expect(reset.pruned).toBe(5);
		expect(reset.keptNonReadOnlyResults).toBe(1);
		expect(
			h
				.filter((m) => m.role === "tool")
				.slice(1, 6)
				.map((m) =>
					m.content.startsWith("[Previous tool result pruned"),
				),
		).toEqual([true, true, true, true, true]);
	},
);

it("keeps an unknown tool whose risk assessment can be low", () => {
	const h = [...pair(100, 32_000, "example_lookup"), ...history()];
	const reset = resetBoundedHistoryV2(input(h));
	expect(h[1].content).toBe("x".repeat(32_000));
	expect(reset.pruned).toBe(5);
	expect(reset.keptNonReadOnlyResults).toBe(1);
});

it("excludes kept writes from the 20k savings floor", () => {
	const h = [...pair(100, 160_000, "update_record"), ...history(4, 12_000)];
	const before = JSON.stringify(h);
	const reset = resetBoundedHistoryV2(input(h, { contextWindow: 120_000 }));
	expect(reset.before.tokens).toBeGreaterThan(reset.before.softCap);
	expect(reset.pruned).toBe(0);
	expect(reset.tokensFreed).toBe(0);
	expect(reset.keptNonReadOnlyResults).toBe(1);
	expect(JSON.stringify(h)).toBe(before);
});

it("compacts when kept writes prevent clearing the byte cap", () => {
	const h = [...pair(100, 160_000, "create_record"), ...history(4, 60_000)];
	const base = input(h);
	const before = JSON.stringify(h);
	const reset = resetBoundedHistoryV2({
		...base,
		request: { ...base.request, extra: "x".repeat(200_000) },
	});
	expect(reset.reason).toBe("bytes");
	expect(reset.pruned).toBe(1);
	expect(reset.action).toBe("compact");
	expect(reset.keptNonReadOnlyResults).toBe(1);
	expect(JSON.stringify(h)).not.toBe(before);
});

it.each(["legacy", "read-only-exempt-v1", "fabric-gated-v2"] as const)(
	"assesses recorded arguments with %s rules",
	(rules) => {
		const h = history();
		if (!h[0].toolCalls) {
			throw new Error("fixture needs a call");
		}
		h[0].toolCalls[0].args = { path: "delete all/example.ts" };
		const base = input(h);
		base.riskOptionsByToolCallId.set("call-1", {
			rules,
			fabricRouted: true,
		});
		const reset = resetBoundedHistoryV2(base);
		expect(reset.pruned).toBe(rules === "legacy" ? 4 : 5);
		expect(reset.keptNonReadOnlyResults).toBe(rules === "legacy" ? 1 : 0);
		expect(h[1].content.startsWith("[Previous tool result pruned")).toBe(
			rules !== "legacy",
		);
	},
);

it.each(["external-route", "missing-rules", "ambiguous-id"])(
	"keeps results with %s classification",
	(mode) => {
		const h = history();
		const base = input(h);
		if (mode === "external-route") {
			base.riskOptionsByToolCallId.set("call-1", {
				rules: "fabric-gated-v2",
				fabricRouted: false,
			});
		}
		if (mode === "missing-rules") {
			base.riskOptionsByToolCallId.delete("call-1");
		}
		if (mode === "ambiguous-id") {
			h[2].toolCalls = [
				{
					id: "call-1",
					name: "code_file_get",
					args: { path: "different" },
				},
			];
		}
		const reset = resetBoundedHistoryV2(base);
		expect(h[1].content).toBe("x".repeat(32_000));
		expect(reset.keptNonReadOnlyResults).toBeGreaterThanOrEqual(1);
	},
);

it.each(["MCP__fetch_record", "GitHub__get_pull_request"])(
	"clears the recorded positive read declaration from %s",
	(name) => {
		const h = [...pair(100, 60_000, name), ...history(3, 20_000)];
		h[1].toolResultReadOnly = true;
		const base = input(h, { contextWindow: 50_000 });
		base.riskOptionsByToolCallId.delete("call-100");
		const reset = resetBoundedHistoryV2(base);
		expect(reset.pruned).toBe(1);
		expect(h[1].content.startsWith("[Previous tool result pruned")).toBe(
			true,
		);
	},
);

it.each([undefined, false])(
	"keeps an external result with read declaration %s",
	(readOnly) => {
		const h = [
			...pair(100, 60_000, "GitHub__create_issue"),
			...history(3, 20_000),
		];
		if (readOnly !== undefined) {
			Object.assign(h[1], { toolResultReadOnly: readOnly });
		}
		const before = JSON.stringify(h);
		const reset = resetBoundedHistoryV2(
			input(h, { contextWindow: 50_000 }),
		);
		expect(reset.pruned).toBe(0);
		expect(reset.keptNonReadOnlyResults).toBe(1);
		expect(JSON.stringify(h)).toBe(before);
	},
);

// Decision-table regression cases assert the action before the loop can rewrite history.
it("rescues a refused reservation on the round after a rewrite", () => {
	const h = history(8, 30_000);
	const args = input(h, {
		allowance: 300_000,
		spent: 210_000,
		finalizationReserve: 30_000,
		calibrationFactor: 0.6,
		previousInputTokens: 100_000,
		previousCacheReadTokens: 99_000,
		lastRewrite: 19,
	});
	const d = boundedHistoryV2Decision(args);
	expect(d.action).toBe("reset");
	expect(d.reason).toBe("allowance_refused");
	expect(d.before.tokens).toBeLessThan(d.before.softCap);
	expect(d.before.reservation).toBeGreaterThan(d.before.room);
	expect(d.after.reservation).toBeLessThanOrEqual(d.after.room);
	expect(d.pruned).toBe(5);
});
it("scales the whole input estimate and overhead together", () => {
	const args = input(history(3, 8_000), {
		extraInputTokens: 12_345,
		calibrationFactor: 0.6,
	});
	const d = boundedHistoryV2Decision(args);
	expect(d.before.tokens).toBe(
		Math.ceil((estimateIterationInputTokens(args.request) + 12_345) * 0.6),
	);
});
it("accepts a byte-only reset with less than 20k tokens and 25 percent bytes freed", () => {
	const args = input(history(4, 12_000), { calibrationFactor: 0.25 });
	const d = boundedHistoryV2Decision({
		...args,
		request: { ...args.request, extra: "x".repeat(480_000) },
	});
	expect(d.action).toBe("reset");
	expect(d.reason).toBe("bytes");
	expect(d.after.bytes).toBeLessThanOrEqual(HISTORY_BYTE_CAP);
	expect(d.tokensFreed).toBeLessThan(20_000);
	expect(d.bytesFreed).toBeLessThan(d.before.bytes * 0.25);
});
it("appends a consecutive soft round", () => {
	const args = input(history(8, 32_000), { lastRewrite: 19 });
	const original = JSON.stringify(args.request);
	const d = boundedHistoryV2Decision(args);
	expect(d.action).toBe("append");
	expect(d.reason).toBe("consecutive_rewrite");
	expect(d.before.hardLimit).toBe(false);
	expect(JSON.stringify(args.request)).toBe(original);
});
it("selects compaction only when a hard trigger survives the reset proposal", () => {
	const args = input(history(4, 12_000), { contextWindow: 10_000 });
	const original = JSON.stringify(args.request);
	const d = boundedHistoryV2Decision(args);
	expect(d.action).toBe("compact");
	expect(d.reason).toBe("context");
	expect(d.after.hardLimit).toBe(true);
	expect(JSON.stringify(args.request)).toBe(original);
});
it.each(["tokens", "allowance"])(
	"appends with soft %s pressure when eligible savings are below the floor",
	(trigger) => {
		const args = input(
			history(4, 12_000),
			trigger === "tokens"
				? { contextWindow: 30_000 }
				: { allowance: 30_000 },
		);
		const d = boundedHistoryV2Decision(args);
		expect(d.action).toBe("append");
		expect(d.reason).toBe("insufficient_savings");
		expect(d.before.hardLimit).toBe(false);
	},
);
it("uses the ledger minimum reservation at the admission boundary", async () => {
	const { planConversationTurnReservation } = await import(
		"@repo/database/prisma/queries/lib/conversation-turn-room"
	);
	const { TURN_BUDGET_ESTIMATE } = await import(
		"@repo/ai/lib/turn-budget-estimate"
	);
	const args = input(history(3, 8_000), {
		extraInputTokens: 1234,
		calibrationFactor: 0.25,
	});
	const d = boundedHistoryV2Decision(args);
	const estimate = estimateIterationInputTokens(args.request) + 1234;
	const reservation = estimate + TURN_BUDGET_ESTIMATE.minOutputTokens;
	expect(d.before.reservation).toBe(reservation);
	for (const offset of [-1, 0]) {
		const plan = planConversationTurnReservation({
			totals: {
				allowance: reservation + offset,
				measured: 0,
				outstanding: 0,
				finalizationReserve: 0,
			},
			kind: "EXPLORATION",
			inputEstimate: estimate,
			requestedOutputTokens:
				TURN_BUDGET_ESTIMATE.defaultRequestedOutputTokens,
			minOutputTokens: TURN_BUDGET_ESTIMATE.minOutputTokens,
			enforced: true,
		});
		expect(plan.outcome).toBe(offset < 0 ? "exhausted" : "fits");
		expect(
			plan.outcome === "fits" ? plan.reservedTokens : plan.needed,
		).toBe(d.before.reservation);
	}
});

it("accepts a context reset below the soft savings floor on a consecutive round", () => {
	const d = boundedHistoryV2Decision(
		input(history(4, 12_000), { contextWindow: 20_000, lastRewrite: 19 }),
	);
	expect(d.action).toBe("reset");
	expect(d.reason).toBe("context");
	expect(d.tokensFreed).toBeLessThan(20_000);
	expect(d.after.tokens).toBeLessThanOrEqual(20_000);
});
it.each([undefined, 19])(
	"keeps an unrescuable refused request unchanged after rewrite %s",
	(lastRewrite) => {
		const args = input(history(8, 30_000), {
			allowance: 38_000,
			lastRewrite,
		});
		const before = JSON.stringify(args.request);
		const d = boundedHistoryV2Decision(args);
		expect(d.action).toBe("append");
		expect(d.reason).toBe("allowance_refused");
		expect(d.pruned).toBe(0);
		expect(d.history).toBe(args.request.conversationHistory);
		expect(d.after.reservation).toBeGreaterThan(d.after.room);
		expect(JSON.stringify(args.request)).toBe(before);
	},
);
it("appends at the exact soft boundary and below it", () => {
	const args = input(history(3, 8_000));
	const size = estimateIterationInputTokens(args.request);
	const d = boundedHistoryV2Decision({
		...args,
		extraInputTokens: 100_000 - size,
	});
	expect(d.action).toBe("append");
	expect(d.reason).toBe("within_limits");
	expect(d.before.tokens).toBe(100_000);
});

it("bounds rewrites during shrinking allowance and growing read history", () => {
	const h = history(10, 24_000);
	// The ten starting reads precede this simulation's requests.
	for (const message of h) {
		message.iteration = 0;
	}
	let lastRewrite: number | undefined;
	const resets: number[] = [];
	let refusedResets = 0;
	for (let round = 1; round <= 30; round++) {
		const before = [...h];
		const d = resetBoundedHistoryV2(
			input(h, {
				iteration: round,
				lastRewrite,
				allowance: 400_000,
				spent: round * 12_000,
				finalizationReserve: 30_000,
				calibrationFactor: 0.6,
			}),
		);
		expect(d.before.hardLimits.bytes).toBe(false);
		expect(d.before.hardLimits.context).toBe(false);
		expect(d.action).not.toBe("compact");
		if (d.pruned > 0) {
			if (d.reason === "allowance_refused") {
				refusedResets++;
				expect(d.before.reservation).toBeGreaterThan(d.before.room);
				expect(d.after.reservation).toBeLessThanOrEqual(d.after.room);
			} else {
				expect(lastRewrite).not.toBe(round - 1);
				expect(d.tokensFreed).toBeGreaterThanOrEqual(20_000);
			}
			// The reset's eligibility guards leave only the three recent pairs.
			expect(
				h.filter(
					(m) => m.role === "tool" && m.content.length === 24_000,
				),
			).toHaveLength(3);
			lastRewrite = round;
			resets.push(round);
		} else {
			expect(h).toEqual(before);
		}
		h.push(
			...pair(30 + round, 24_000).map((m) => ({
				...m,
				iteration: round,
			})),
		);
	}
	expect(resets.length).toBeGreaterThanOrEqual(2);
	expect(refusedResets).toBeGreaterThan(0);
});

it("clears the eligible byte backlog then appends while new results fit", () => {
	const h = history(8, 80_000);
	let lastRewrite: number | undefined = 19;
	const actions: string[] = [];
	for (let round = 20; round <= 28; round++) {
		const d = resetBoundedHistoryV2(
			input(h, {
				iteration: round,
				lastRewrite,
				calibrationFactor: 0.25,
			}),
		);
		actions.push(d.action);
		if (d.pruned > 0) {
			expect(d.reason).toBe("bytes");
			expect(d.pruned).toBe(round === 20 ? 5 : 4);
			expect(
				h.filter(
					(m) => m.role === "tool" && m.content.length === 80_000,
				),
			).toHaveLength(3);
			lastRewrite = round;
		} else {
			expect(d.reason).toBe("within_limits");
		}
		h.push(...pair(round, 80_000));
	}
	expect(actions).toEqual([
		"reset",
		"append",
		"append",
		"append",
		"reset",
		"append",
		"append",
		"append",
		"reset",
	]);
});

it.each([undefined, 23])(
	"rescues round 24 below the savings floor after rewrite %s",
	(lastRewrite) => {
		const h = Array.from({ length: 6 }, (_, index) =>
			pair(index + 1, 24_000, "example"),
		).flat();
		for (const m of h) {
			if (m.role === "tool") {
				m.toolResultReadOnly = true;
			}
		}
		const base = input(h);
		// Fixed prompt overhead reproduces the reviewer's full ledger reservation.
		const d = resetBoundedHistoryV2({
			...base,
			iteration: 24,
			lastRewrite,
			allowance: 400_000,
			spent: 288_000,
			finalizationReserve: 48_000,
			calibrationFactor: 0.6,
			extraInputTokens:
				66_420 - 1_024 - estimateIterationInputTokens(base.request),
		});
		expect(d.before.room).toBe(64_000);
		expect(d.before.reservation).toBe(66_420);
		expect(d.action).toBe("reset");
		expect(d.reason).toBe("allowance_refused");
		expect(d.tokensFreed).toBe(17_704);
		expect(d.after.reservation).toBeLessThanOrEqual(64_000);
		expect(d.pruned).toBe(3);
		expect(
			h.filter((m) => m.role === "tool" && m.content.length === 24_000),
		).toHaveLength(3);
	},
);

it.each([undefined, 19])(
	"leaves an approaching reservation at the fit boundary soft after rewrite %s",
	(lastRewrite) => {
		const base = input(history(4, 12_000));
		const reservation = estimateIterationInputTokens(base.request) + 1_024;
		const d = boundedHistoryV2Decision({
			...base,
			allowance: reservation,
			finalizationReserve: 0,
			lastRewrite,
		});
		expect(d.before.reservation).toBe(d.before.room);
		expect(d.before.hardLimit).toBe(false);
		expect(d.action).toBe("append");
		expect(d.reason).toBe(
			lastRewrite === undefined
				? "insufficient_savings"
				: "consecutive_rewrite",
		);
	},
);

it.each([undefined, 10_000])(
	"keeps size limits active without a ledger, context %s",
	(contextWindow) => {
		const d = boundedHistoryV2Decision(
			input(history(8, 32_000), {
				allowance: 1,
				hasTurnLedger: false,
				contextWindow,
			}),
		);
		expect(d.before.hardLimits.allowance_refused).toBe(false);
		expect(d.before.softLimits.allowance).toBe(false);
		expect(d.action).toBe(
			contextWindow === undefined ? "reset" : "compact",
		);
		expect(d.reason).toBe(
			contextWindow === undefined ? "tokens" : "context",
		);
	},
);
