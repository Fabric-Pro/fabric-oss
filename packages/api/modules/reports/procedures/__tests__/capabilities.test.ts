import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	handler: undefined as
		| undefined
		| ((args: {
				input: { projectId?: string };
				context: unknown;
		  }) => Promise<Record<string, unknown>>),
	isPlatformAdmin: vi.fn(),
	getOrganizationMembership: vi.fn(),
	access: vi.fn(),
	hasProjectAccess: vi.fn(),
	isProjectSoftDeleted: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isPlatformAdmin: mocks.isPlatformAdmin,
	getOrganizationMembership: mocks.getOrganizationMembership,
	hasProjectAccess: mocks.hasProjectAccess,
	isProjectSoftDeleted: mocks.isProjectSoftDeleted,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		input: () => chain,
		handler: (fn: typeof mocks.handler) => {
			mocks.handler = fn;
			return {};
		},
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: { REPORT_READ: "report:read" },
		requirePermission: () => () => chain,
		resolveOrganizationId: () => "example-org",
	};
});

import "../capabilities";

function capabilities(input: { projectId?: string }) {
	if (!mocks.handler) {
		throw new Error("The procedure did not register a handler");
	}
	return mocks.handler({
		input,
		context: {
			user: { id: "example-caller", role: "user" },
			session: {},
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isPlatformAdmin.mockResolvedValue(false);
	mocks.getOrganizationMembership.mockResolvedValue({ role: "viewer" });
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.isProjectSoftDeleted.mockResolvedValue(false);
});

describe("reports.capabilities", () => {
	it("offers a Member with no project row neither, though their organization role holds the permissions", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });
		mocks.hasProjectAccess.mockResolvedValue(false);
		mocks.access.mockResolvedValue({
			permissions: resolveOrgPermissions("member"),
			source: "org",
			organizationId: "example-org",
			organizationDeleted: false,
		});

		await expect(
			capabilities({ projectId: "example-project" }),
		).resolves.toMatchObject({
			canEditProjectReports: false,
			canSetProjectDefaults: false,
		});
	});

	it("offers a Member with an Editor project row both", async () => {
		mocks.getOrganizationMembership.mockResolvedValue({ role: "member" });
		mocks.access.mockResolvedValue({
			permissions: resolveProjectPermissions("EDITOR"),
			source: "project-member",
			organizationId: "example-org",
			organizationDeleted: false,
		});

		await expect(
			capabilities({ projectId: "example-project" }),
		).resolves.toMatchObject({
			canEditProjectReports: true,
			canSetProjectDefaults: true,
		});
	});

	it("tells a Viewer with an Editor project row apart: defaults yes, adding reports no", async () => {
		mocks.access.mockResolvedValue({
			permissions: resolveProjectPermissions("EDITOR"),
			source: "project-member",
			organizationId: "example-org",
			organizationDeleted: false,
		});

		await expect(
			capabilities({ projectId: "example-project" }),
		).resolves.toMatchObject({
			canEditProjectReports: false,
			canSetProjectDefaults: true,
		});
	});

	it("gives a plain Viewer neither", async () => {
		mocks.access.mockResolvedValue({
			permissions: resolveOrgPermissions("viewer"),
			source: "org",
			organizationId: "example-org",
			organizationDeleted: false,
		});

		await expect(
			capabilities({ projectId: "example-project" }),
		).resolves.toMatchObject({
			canEditProjectReports: false,
			canSetProjectDefaults: false,
		});
	});

	it("answers null when no project was named", async () => {
		await expect(capabilities({})).resolves.toMatchObject({
			canEditProjectReports: null,
			canSetProjectDefaults: null,
		});
	});
});
