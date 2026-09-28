/**
 * The Glossy Version Export gate resolves per organization, and derives that
 * organization from the Project row (KTD20).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIsFeatureEnabled = vi.fn();
const mockResolveProjectTenant = vi.fn();

vi.mock("@repo/database", () => ({
	isFeatureEnabled: (...args: unknown[]) => mockIsFeatureEnabled(...args),
	resolveProjectTenant: (...args: unknown[]) =>
		mockResolveProjectTenant(...args),
}));

const {
	assertGlossyEnabled,
	assertGlossyEnabledForOrganization,
	requireGlossyEnabled,
} = await import("../glossy-feature");

describe("assertGlossyEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves the flag with the organization from the project row", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_enabled",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(true);

		await expect(assertGlossyEnabled("proj_1")).resolves.toBeUndefined();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			"org_enabled",
		);
	});

	it("throws NOT_FOUND when the project's organization is not enabled", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_other",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(assertGlossyEnabled("proj_1")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
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

		await expect(assertGlossyEnabled("proj_1")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});

		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});

	it("refuses a project that no longer resolves", async () => {
		mockResolveProjectTenant.mockResolvedValue(null);

		await expect(assertGlossyEnabled("proj_gone")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
	});
});

// The Brand kit has no project, so it is gated on the organization its
// permission middleware verified — with the same fail-closed answers.
describe("assertGlossyEnabledForOrganization", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("resolves the flag for exactly the organization it is given", async () => {
		mockIsFeatureEnabled.mockResolvedValue(true);

		await expect(
			assertGlossyEnabledForOrganization("org_enabled"),
		).resolves.toBeUndefined();

		expect(mockIsFeatureEnabled).toHaveBeenCalledWith(
			"GLOSSY_EDITION",
			"org_enabled",
		);
		expect(mockResolveProjectTenant).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the organization is not enabled", async () => {
		mockIsFeatureEnabled.mockResolvedValue(false);

		await expect(
			assertGlossyEnabledForOrganization("org_other"),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it.each([null, undefined, ""])(
		"refuses a missing organization (%s) without reading the flag",
		async (organizationId) => {
			await expect(
				assertGlossyEnabledForOrganization(organizationId),
			).rejects.toMatchObject({ code: "NOT_FOUND" });
			expect(mockIsFeatureEnabled).not.toHaveBeenCalled();
		},
	);
});

// The middleware form runs BEFORE the permission middleware, so a gate that
// is off answers NOT_FOUND to every caller — a viewer's write included (AE10).
describe("requireGlossyEnabled", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	type Middleware = (
		options: { next: () => Promise<unknown> },
		input: unknown,
	) => Promise<unknown>;

	function run(input: unknown) {
		const next = vi.fn(async () => ({ output: "handled" }));
		const middleware = requireGlossyEnabled() as unknown as Middleware;
		return { result: middleware({ next }, input), next };
	}

	it("answers NOT_FOUND before the rest of the chain when the gate is off", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_disabled",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(false);

		const { result, next } = run({ projectId: "proj_1" });

		// Worded as the permission middleware answers a caller with no tie,
		// so the gate's answer does not reveal the project exists.
		await expect(result).rejects.toMatchObject({
			code: "NOT_FOUND",
			message: "Project not found",
		});
		expect(next).not.toHaveBeenCalled();
	});

	it("passes any other failure of the gate through unchanged", async () => {
		const outage = new Error("database unavailable");
		mockResolveProjectTenant.mockRejectedValue(outage);

		const { result, next } = run({ projectId: "proj_1" });

		await expect(result).rejects.toBe(outage);
		expect(next).not.toHaveBeenCalled();
	});

	it("continues the chain when the project's organization has the gate on", async () => {
		mockResolveProjectTenant.mockResolvedValue({
			organizationId: "org_enabled",
			userId: null,
		});
		mockIsFeatureEnabled.mockResolvedValue(true);

		const { result, next } = run({ projectId: "proj_1" });

		await expect(result).resolves.toEqual({ output: "handled" });
		expect(next).toHaveBeenCalledTimes(1);
	});

	it("leaves a missing projectId to the permission middleware that follows", async () => {
		const { result, next } = run({});

		await expect(result).resolves.toEqual({ output: "handled" });
		expect(mockResolveProjectTenant).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});
});
