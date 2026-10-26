import { describe, expect, it } from "vitest";
import {
	boundedHistoryDecision,
	estimateIterationInputTokens,
} from "../../advisor-history-retention";

const request = {
	conversationHistory: [
		{ role: "user" as const, content: "example", timestamp: "2026-01-01" },
	],
	systemPrompt: "Example system",
	availableTools: {},
};
const base = {
	request,
	allowance: 500_000,
	spent: 0,
	finalizationReserve: 8_000,
};
describe("bounded history decision", () => {
	it("retains the next request within its limits", () => {
		expect(boundedHistoryDecision(base).prune).toBe(false);
	});
	it("prunes above the full request token cap, including tools and notice", () => {
		expect(
			boundedHistoryDecision({
				...base,
				request: {
					...request,
					availableTools: {
						example: { description: "t".repeat(80_000) },
					},
					turnNotice: "notice",
				},
			}).reason,
		).toBe("tokens");
	});
	it("uses sixty percent of a known context window", () => {
		expect(
			boundedHistoryDecision({
				...base,
				contextWindow: 1_000,
				request: { ...request, systemPrompt: "s".repeat(2_000) },
			}).reason,
		).toBe("tokens");
	});
	it("prunes above 512 KiB including activity fields outside the prompt", () => {
		expect(
			boundedHistoryDecision({
				...base,
				request: { ...request, executionId: "界".repeat(180_000) },
			}).reason,
		).toBe("bytes");
	});
	it("prunes when input plus requested output and finalization cannot fit", () => {
		const input = estimateIterationInputTokens(request);
		expect(
			boundedHistoryDecision({
				...base,
				allowance: input + 16_384 + 8_000 - 1,
			}).reason,
		).toBe("allowance");
		expect(
			boundedHistoryDecision({
				...base,
				allowance: input + 16_384 + 8_000,
			}).prune,
		).toBe(false);
	});
	it("retains on the round following a reset to half the soft cap", () => {
		expect(
			boundedHistoryDecision({
				...base,
				request: { ...request, systemPrompt: "s".repeat(36_000) },
			}).prune,
		).toBe(false);
	});
	it("counts fresh tool results instead of aggregated retry usage", () => {
		expect(
			boundedHistoryDecision({
				...base,
				request: {
					...request,
					conversationHistory: [
						{
							role: "tool",
							content: "x".repeat(80_000),
							timestamp: "2026-01-01",
						},
					],
				},
			}).prune,
		).toBe(true);
	});
	it("includes recorded activity-only overhead", () => {
		expect(
			boundedHistoryDecision({ ...base, extraInputTokens: 32_000 }).prune,
		).toBe(true);
	});
});

it("sizes a CJK-heavy next request at about one token per character", () => {
	const cjk = {
		...request,
		conversationHistory: [
			{
				role: "user",
				content: "界".repeat(40_000),
				timestamp: "2026-01-01",
			},
		],
	};
	expect(estimateIterationInputTokens(cjk)).toBeGreaterThanOrEqual(40_000);
	expect(boundedHistoryDecision({ ...base, request: cjk }).reason).toBe(
		"tokens",
	);
});

// The v2 helper uses the proposed request without mutating its prefix on a rejected reset.
describe("bounded history v2", () => {
	it("retains 60k estimated tokens below its larger ceiling", async () => {
		const { boundedHistoryV2Decision } = await import(
			"../../advisor-history-retention"
		);
		expect(
			boundedHistoryV2Decision({
				...base,
				iteration: 1,
				request: { ...request, systemPrompt: "x".repeat(140_000) },
			}).action,
		).toBe("append");
	});

	it("calibrates overhead while retaining full admission size despite prior cache reads", async () => {
		const { boundedHistoryV2Decision } = await import(
			"../../advisor-history-retention"
		);
		const next = { ...request, systemPrompt: "x".repeat(200_000) };
		const size = estimateIterationInputTokens(next);
		const d = boundedHistoryV2Decision({
			...base,
			iteration: 1,
			request: next,
			calibrationFactor: 0.5,
			extraInputTokens: 100,
			allowance: 50_000,
		});
		expect(d.before.tokens).toBe(Math.ceil((size + 100) * 0.5));
		expect(d.before.reservation).toBe(size + 100 + 1024);
		expect(d.before.softLimits.allowance).toBe(false);
		expect(d.before.hardLimits.allowance_refused).toBe(true);
		expect(d.action).toBe("append");
		expect(d.reason).toBe("allowance_refused");
		expect(
			boundedHistoryV2Decision({
				...base,
				iteration: 1,
				request: next,
				calibrationFactor: 2,
			}).reason,
		).toBe("insufficient_savings");
	});
});
