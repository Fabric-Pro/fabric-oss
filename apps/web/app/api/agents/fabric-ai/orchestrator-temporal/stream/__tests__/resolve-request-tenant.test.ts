import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) =>
				mocks.projectFindUnique(...args),
		},
	},
}));

import { resolveRequestTenant } from "../resolve-request-tenant";

const USER_ID = "user-1";
const ORGANIZATION_ID = "example-org";
const OTHER_ORGANIZATION_ID = "another-example-org";

/**
 * The organization a request names is checked for membership by the route,
 * but the project it names (or its conversation carries) is checked only for
 * access, and project access admits invited guests of another organization.
 * These pin the one comparison that keeps such a project out of a chat that
 * runs in a different organization.
 */
describe("resolveRequestTenant", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	it("drops a project of another organization when the request names an organization", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			organizationId: OTHER_ORGANIZATION_ID,
		});

		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: "project-of-another-org",
		});

		expect(resolved).toEqual({ projectId: undefined });
		expect(mocks.projectFindUnique).toHaveBeenCalledWith({
			where: { id: "project-of-another-org" },
			select: { organizationId: true },
		});
	});

	it("keeps a project of the organization the request names", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			organizationId: ORGANIZATION_ID,
		});

		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: "project-of-example-org",
		});

		expect(resolved).toEqual({ projectId: "project-of-example-org" });
	});

	// A personal project has no organization, so it is not the named
	// organization's either; the Direct route drops it the same way.
	it("drops a project without an organization when the request names one", async () => {
		mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: "personal-project",
		});

		expect(resolved).toEqual({ projectId: undefined });
	});

	it("leaves a request that names no organization as it is, without a lookup", async () => {
		for (const organizationId of [undefined, null, ""]) {
			const resolved = await resolveRequestTenant({
				userId: USER_ID,
				organizationId,
				projectId: "project-of-another-org",
			});

			expect(resolved).toEqual({ projectId: "project-of-another-org" });
		}
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});

	it("does not look anything up when there is no project", async () => {
		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: undefined,
		});

		expect(resolved).toEqual({ projectId: undefined });
		expect(mocks.projectFindUnique).not.toHaveBeenCalled();
	});

	it("drops a project it cannot find", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: "missing-project",
		});

		expect(resolved).toEqual({ projectId: undefined });
	});

	it("drops the project when the lookup fails", async () => {
		mocks.projectFindUnique.mockRejectedValue(new Error("connection lost"));

		const resolved = await resolveRequestTenant({
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			projectId: "project-of-example-org",
		});

		expect(resolved).toEqual({ projectId: undefined });
	});
});
