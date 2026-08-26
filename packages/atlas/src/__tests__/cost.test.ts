/**
 * Smart-analysis cost + telemetry math (T3).
 *
 * Locks: micro-USD = tokens × costPer1M (USD/1e6-tokens × tokens), rounded and
 * never negative; usage normalisation maps AI-SDK `{inputTokens,outputTokens}`
 * → prompt/completion and derives totals; reasoning extraction is best-effort
 * across the `reasoningText` / string / array shapes.
 */
import { describe, expect, it } from "vitest";
import {
	addTokenTotals,
	computeCostMicroUsd,
	concatReasoning,
	EMPTY_TOKEN_TOTALS,
	extractReasoningText,
	tokenTotalsFromUsage,
} from "../cost";

describe("computeCostMicroUsd", () => {
	it("converts tokens × per-1M rates to micro-USD (1M tokens @ $0.50/1M = 500000µ$)", () => {
		expect(
			computeCostMicroUsd({
				promptTokens: 1_000_000,
				completionTokens: 0,
				inputCostPer1M: 0.5,
				outputCostPer1M: 1.5,
			}),
		).toBe(500_000);
	});

	it("sums input + output legs", () => {
		// 200k input @ $0.30/1M = 60000µ$; 100k output @ $0.60/1M = 60000µ$.
		expect(
			computeCostMicroUsd({
				promptTokens: 200_000,
				completionTokens: 100_000,
				inputCostPer1M: 0.3,
				outputCostPer1M: 0.6,
			}),
		).toBe(120_000);
	});

	it("rounds to the nearest micro-USD", () => {
		// 333 input @ $1/1M = 333µ$ exactly; 1 output @ $1.4/1M = 1.4 → rounds to 1.
		expect(
			computeCostMicroUsd({
				promptTokens: 333,
				completionTokens: 1,
				inputCostPer1M: 1,
				outputCostPer1M: 1.4,
			}),
		).toBe(334);
	});

	it("treats missing rates as 0 (never throws, never negative)", () => {
		expect(
			computeCostMicroUsd({
				promptTokens: 1000,
				completionTokens: 1000,
				inputCostPer1M: null,
				outputCostPer1M: undefined,
			}),
		).toBe(0);
	});
});

describe("tokenTotalsFromUsage", () => {
	it("maps inputTokens→prompt, outputTokens→completion and keeps reported total", () => {
		expect(
			tokenTotalsFromUsage({
				inputTokens: 10,
				outputTokens: 4,
				totalTokens: 14,
			}),
		).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
	});

	it("derives total when the provider omits it", () => {
		expect(
			tokenTotalsFromUsage({ inputTokens: 10, outputTokens: 4 }),
		).toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14 });
	});

	it("returns zeros for undefined usage", () => {
		expect(tokenTotalsFromUsage(undefined)).toEqual(EMPTY_TOKEN_TOTALS);
	});
});

describe("addTokenTotals", () => {
	it("accumulates two token totals field-by-field", () => {
		expect(
			addTokenTotals(
				{ promptTokens: 5, completionTokens: 2, totalTokens: 7 },
				{ promptTokens: 3, completionTokens: 1, totalTokens: 4 },
			),
		).toEqual({ promptTokens: 8, completionTokens: 3, totalTokens: 11 });
	});
});

describe("extractReasoningText / concatReasoning", () => {
	it("reads reasoningText (string)", () => {
		expect(extractReasoningText({ reasoningText: "because" })).toBe(
			"because",
		);
	});

	it("reads reasoning as a string", () => {
		expect(extractReasoningText({ reasoning: "why" })).toBe("why");
	});

	it("joins reasoning part arrays", () => {
		expect(
			extractReasoningText({ reasoning: [{ text: "a" }, { text: "b" }] }),
		).toBe("ab");
	});

	it("returns null when absent", () => {
		expect(extractReasoningText({})).toBeNull();
		expect(extractReasoningText(null)).toBeNull();
	});

	it("concatenates dropping empties", () => {
		expect(concatReasoning("a", null)).toBe("a");
		expect(concatReasoning(null, "b")).toBe("b");
		expect(concatReasoning("a", "b")).toBe("a\n\nb");
		expect(concatReasoning(null, null)).toBeNull();
	});
});
