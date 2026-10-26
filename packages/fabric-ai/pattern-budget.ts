import type { DispatchBudgetRequest } from "@repo/utils/dispatch-guard";

// Surrogate allowance for the pattern, context and strategy loaded server-side.
const PATTERN_CONTEXT_INPUT_TOKENS = 4_000;
const PATTERN_OUTPUT_TOKENS = 8_192;

/** No provider usage or enforceable cap is returned by the pattern server. */
export function patternBudgetRequest(input: string): DispatchBudgetRequest {
	return {
		modality: "external",
		inputEstimate:
			Math.ceil(input.length / 4) + PATTERN_CONTEXT_INPUT_TOKENS,
		requestedOutputTokens: PATTERN_OUTPUT_TOKENS,
		minOutputTokens: PATTERN_OUTPUT_TOKENS,
		enforcesOutputCap: false,
	};
}
