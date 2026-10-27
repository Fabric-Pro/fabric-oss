import { describe, expect, it } from "vitest";
import {
	EXECUTION_MODE_CONFIGS,
	executionModeConfig,
} from "../src/workflows/orchestrator/types/execution-mode.types";

describe("balanced budget replay values", () => {
	it("uses 30 main rounds and 1M tokens for new balanced runs", () =>
		expect(executionModeConfig("balanced", true)).toMatchObject({
			maxIterations: 30,
			maxTotalTokens: 1000000,
		}));
	it("keeps pre-marker balanced runs at 15 entries and 500k", () =>
		expect(executionModeConfig("balanced", false)).toMatchObject({
			maxIterations: 15,
			maxTotalTokens: 500000,
		}));
	it.each(["fast", "accurate", "save_reuse", "iterative", "weave"] as const)(
		"keeps %s limits",
		(mode) => {
			expect(executionModeConfig(mode, true)).toEqual(
				EXECUTION_MODE_CONFIGS[mode],
			);
			expect(executionModeConfig(mode, false)).toEqual(
				EXECUTION_MODE_CONFIGS[mode],
			);
		},
	);
});

it("keeps the admission-frozen 500k token limit for warnings on a newly started pre-change turn", () => {
	expect(executionModeConfig("balanced", true, 500000)).toMatchObject({
		maxIterations: 30,
		maxTotalTokens: 500000,
	});
});
