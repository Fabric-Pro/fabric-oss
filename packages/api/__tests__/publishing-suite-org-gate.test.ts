/**
 * The Publishing Suite gate resolves per organization, and derives that
 * organization from the Project row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.fn();
const mockResolveProjectTenant = vi.fn();

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	resolveProjectTenant: (...args: unknown[]) =>
		mockResolveProjectTenant(...args),
}));

const { assertPublishingSuiteFeatureEnabled } = await import(
	"../modules/projects/lib/publishing-suite-feature"
);

describe("assertPublishingSuiteFeatureEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves the flag with the organization from the project row", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_enabled",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(true);

		await expect(
			assertPublishingSuiteFeatureEnabled("proj_1"),
		).resolves.toBeUndefined();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"PUBLISHING_SUITE",
			"org_enabled",
		);
	});

	it("throws NOT_FOUND when the project's organization is not enabled", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_other",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(
			assertPublishingSuiteFeatureEnabled("proj_1"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	// Personal project: no organization. Per ADR-018 ("An organization is the
	// only tenant context") this is refused outright — it must NOT fall
	// through to the global/env/default chain, so isFeatureEnabled is never
	// even called.
	it("refuses a personal project with no organization id", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: null,
			userId: "user_1",
		});

		await expect(
			assertPublishingSuiteFeatureEnabled("proj_1"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("refuses a project that no longer resolves", async () => {
		mockResolveProjectTenant.mockResolvedValue(null);

		await expect(
			assertPublishingSuiteFeatureEnabled("proj_gone"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});
});
