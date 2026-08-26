import { describe, expect, it } from "vitest";
import {
	computeMaxOutputTokenBudget,
	computeScaledOutputTokenBudget,
	FALLBACK_OUTPUT_TOKEN_CAP,
	MAXIMAL_OUTPUT_TOKEN_CEILING,
	MIN_OUTPUT_TOKEN_BUDGET,
} from "../output-token-budget";

describe("computeScaledOutputTokenBudget", () => {
	it("floors at 16,384 for a small input on a gated provider with no catalog cap", () => {
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS" },
				{ inputChars: 1_000, promptChars: 1_000 },
			),
		).toBe(MIN_OUTPUT_TOKEN_BUDGET);
		expect(MIN_OUTPUT_TOKEN_BUDGET).toBe(16_384);
	});

	it("scales as 2 * ceil(inputChars/3) + 2,048 above the floor", () => {
		// 60,000 chars -> 20,000 input tokens -> 40,000 + 2,048 = 42,048.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS" },
				{ inputChars: 60_000, promptChars: 1_000 },
			),
		).toBe(42_048);
	});

	it("clamps the scaled budget down to the catalog output cap", () => {
		// 300,000 chars -> desired 202,048, clamped to the 128,000 catalog cap.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS", maxOutputTokens: 128_000 },
				{ inputChars: 300_000, promptChars: 1_000 },
			),
		).toBe(128_000);
	});

	it("sends exactly the cap when the catalog cap is below the floor", () => {
		// A cap under the floor wins — never over-ask past what the model allows.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "VERCEL_GATEWAY", maxOutputTokens: 4_096 },
				{ inputChars: 60_000, promptChars: 1_000 },
			),
		).toBe(4_096);
	});

	it("returns undefined for a non-gated provider with no catalog cap", () => {
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "VERCEL_GATEWAY" },
				{ inputChars: 1_000, promptChars: 1_000 },
			),
		).toBeUndefined();
	});

	it("applies the gated fallback cap for ANTHROPIC_DIRECT", () => {
		// Desired here (small input) is the floor, below the fallback cap.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "ANTHROPIC_DIRECT" },
				{ inputChars: 1_000, promptChars: 1_000 },
			),
		).toBe(MIN_OUTPUT_TOKEN_BUDGET);
	});

	it("degenerates to the floor when inputChars is 0", () => {
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS" },
				{ inputChars: 0, promptChars: 1_000 },
			),
		).toBe(MIN_OUTPUT_TOKEN_BUDGET);
	});

	it("clamps the budget to the context window, leaving room for the prompt", () => {
		// contextWindow 10,000 - ceil(3,000/2)=1,500 - 1,024 margin = 7,476,
		// which is below the floored 16,384 desired budget. The clamp uses the
		// conservative /2 divisor (not /3).
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS", contextWindow: 10_000 },
				{ inputChars: 1_000, promptChars: 3_000 },
			),
		).toBe(7_476);
	});

	it("clamps below the old 1,024 margin when the prompt leaves little room", () => {
		// contextWindow 2,024 - ceil(1,000/2)=500 - 1,024 = 500. The clamp no
		// longer floors at the 1,024 margin — it manufactures no capacity.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS", contextWindow: 2_024 },
				{ inputChars: 1_000, promptChars: 1_000 },
			),
		).toBe(500);
	});

	it("clamps to 1 (not the margin) when the prompt leaves no room", () => {
		// contextWindow 1,000 - ceil(3,000/2)=1,500 - 1,024 = -1,524 -> floored
		// to 1. The request cannot succeed on input size; requesting 1 keeps the
		// failure honest instead of over-asking on top of it.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS", contextWindow: 1_000 },
				{ inputChars: 1_000, promptChars: 3_000 },
			),
		).toBe(1);
	});

	it("uses /2 for the context clamp while sizing uses /3", () => {
		// Sizing: inputChars 60,000 -> ceil/3=20,000 -> 42,048 desired (proven by
		// the scaling test above). Clamp: contextWindow 20,000 - ceil(30,000/2)=
		// 15,000 - 1,024 = 3,976. With the old /3 divisor the clamp would have
		// been 20,000 - 10,000 - 1,024 = 8,976, so this pins the /2 behavior.
		expect(
			computeScaledOutputTokenBudget(
				{ provider: "DATABRICKS", contextWindow: 20_000 },
				{ inputChars: 60_000, promptChars: 30_000 },
			),
		).toBe(3_976);
	});
});

describe("computeMaxOutputTokenBudget", () => {
	it("caps at the quota-safe ceiling, not the full catalog cap (TPM/OTPM admission reserves requested max_tokens)", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS", maxOutputTokens: 128_000 },
				{ promptChars: 1_000 },
			),
		).toBe(MAXIMAL_OUTPUT_TOKEN_CEILING);
		expect(MAXIMAL_OUTPUT_TOKEN_CEILING).toBe(32_768);
	});

	it("returns the catalog cap when it is below the ceiling", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS", maxOutputTokens: 8_192 },
				{ promptChars: 1_000 },
			),
		).toBe(8_192);
	});

	it("honors an explicit ceilingTokens override up to the catalog cap", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS", maxOutputTokens: 128_000 },
				{ promptChars: 1_000, ceilingTokens: 100_000 },
			),
		).toBe(100_000);
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS", maxOutputTokens: 64_000 },
				{ promptChars: 1_000, ceilingTokens: 100_000 },
			),
		).toBe(64_000);
	});

	it("applies the ceiling below the gated fallback for DATABRICKS with no catalog cap", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS" },
				{ promptChars: 1_000 },
			),
		).toBe(MAXIMAL_OUTPUT_TOKEN_CEILING);
		expect(FALLBACK_OUTPUT_TOKEN_CAP).toBe(64_000);
	});

	it("applies the ceiling for ANTHROPIC_DIRECT with no catalog cap", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "ANTHROPIC_DIRECT" },
				{ promptChars: 1_000 },
			),
		).toBe(MAXIMAL_OUTPUT_TOKEN_CEILING);
	});

	it("returns undefined for a non-gated provider with no catalog cap", () => {
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "VERCEL_GATEWAY" },
				{ promptChars: 1_000 },
			),
		).toBeUndefined();
	});

	it("clamps the maximal budget to the context window", () => {
		// contextWindow 20,000 - ceil(3,000/2)=1,500 - 1,024 = 17,476, below
		// both the 32,768 maximal ceiling and the 64,000 gated fallback cap.
		expect(
			computeMaxOutputTokenBudget(
				{ provider: "DATABRICKS", contextWindow: 20_000 },
				{ promptChars: 3_000 },
			),
		).toBe(17_476);
	});
});
