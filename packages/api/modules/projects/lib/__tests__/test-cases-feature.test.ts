import { afterEach, describe, expect, it, vi } from "vitest";
import { assertTestCasesFeatureEnabled } from "../test-cases-feature";

// The suite runs with FABRIC_FEATURE_TEST_CASES="true" (vitest.config env); each
// case stubs the value it needs and restores after.
afterEach(() => vi.unstubAllEnvs());

describe("assertTestCasesFeatureEnabled", () => {
	it('passes (no throw) when FABRIC_FEATURE_TEST_CASES is exactly "true"', () => {
		vi.stubEnv("FABRIC_FEATURE_TEST_CASES", "true");
		expect(() => assertTestCasesFeatureEnabled()).not.toThrow();
	});

	it('throws NOT_FOUND for any non-"true" value (feature is off by default)', () => {
		for (const value of ["", "false", "1", "TRUE", "yes", "True"]) {
			vi.stubEnv("FABRIC_FEATURE_TEST_CASES", value);
			expect(() => assertTestCasesFeatureEnabled()).toThrowError(
				/not enabled/i,
			);
		}
	});
});
