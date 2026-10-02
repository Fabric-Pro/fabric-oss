/**
 * The company context gate (Fizzy #2719) resolves per organization and fails
 * closed: off, or with no organization, it answers NOT_FOUND.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.fn();

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
}));

const { assertCompanyContextEnabled } = await import(
	"../company-context-feature"
);

describe("assertCompanyContextEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves the flag for exactly the organization it is given", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);

		await expect(
			assertCompanyContextEnabled("org_enabled"),
		).resolves.toBeUndefined();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"COMPANY_CONTEXT",
			"org_enabled",
		);
	});

	it("throws NOT_FOUND when the organization is not enabled", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(
			assertCompanyContextEnabled("org_other"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	// ADR-018: a missing organization never falls through to the
	// global/env/default chain, so the flag is not even read.
	it.each([null, undefined, ""])(
		"refuses a missing organization (%s) without reading the flag",
		async (organizationId) => {
			await expect(
				assertCompanyContextEnabled(organizationId),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		},
	);

	it("propagates a flag-store failure instead of treating it as enabled", async () => {
		mockIsFeatureEnabled.mockRejectedValue(new Error("db unavailable"));

		await expect(assertCompanyContextEnabled("org_1")).rejects.toThrow(
			"db unavailable",
		);
	});
});
