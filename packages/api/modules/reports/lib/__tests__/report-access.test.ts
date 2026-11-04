import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	isPlatformAdmin: vi.fn(),
	getOrganizationMembership: vi.fn(),
	access: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	isPlatformAdmin: mocks.isPlatformAdmin,
	getOrganizationMembership: mocks.getOrganizationMembership,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions: mocks.access,
}));

import {
	assertCanEditReportInstance,
	assertCanGenerateReportInstance,
	assertCanManageReportTemplate,
	assertCanPublishReportTemplate,
	canEditProjectReport,
	canEditReportInstance,
	canGenerateReportInstance,
} from "../report-access";

const ORG = "example-org";
const PROJECT = "example-project";
const caller = { id: "example-caller", role: "user" };

function projectMember(role: string) {
	return {
		permissions: resolveProjectPermissions(role),
		source: "project-member",
		organizationId: ORG,
		organizationDeleted: false,
	};
}

function orgRole(role: string) {
	return { role, organization: { id: ORG } };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.isPlatformAdmin.mockResolvedValue(false);
	mocks.getOrganizationMembership.mockResolvedValue(orgRole("member"));
	mocks.access.mockResolvedValue(null);
});

describe("canEditProjectReport", () => {
	it("lets a project Editor edit", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(true);
	});

	it("refuses a project Viewer who is a plain organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project Commenter", async () => {
		mocks.access.mockResolvedValue(projectMember("COMMENTER"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it.each(["admin", "owner"])(
		"lets an organization %s with a Viewer project row edit (inherited)",
		async (role) => {
			mocks.access.mockResolvedValue(projectMember("VIEWER"));
			mocks.getOrganizationMembership.mockResolvedValue(orgRole(role));
			await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
				true,
			);
			expect(mocks.getOrganizationMembership).toHaveBeenCalledWith(
				ORG,
				caller.id,
			);
		},
	);

	it("lets a platform admin edit without any project tie", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(true);
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it("refuses a caller with no tie to the project", async () => {
		mocks.access.mockResolvedValue({
			permissions: [],
			source: "none",
			organizationId: ORG,
			organizationDeleted: false,
		});
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a missing project", async () => {
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses an organization viewer without a project row", async () => {
		mocks.access.mockResolvedValue({
			permissions: resolveOrgPermissions("viewer"),
			source: "org",
			organizationId: ORG,
			organizationDeleted: false,
		});
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses an organization Viewer whose project row is Editor", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project guest who is not an organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project in a deleted organization", async () => {
		mocks.access.mockResolvedValue({
			...projectMember("EDITOR"),
			organizationDeleted: true,
		});
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});
});

describe("canEditReportInstance", () => {
	const othersInstance = {
		userId: "example-other-member",
		organizationId: ORG,
		projectId: null,
	};

	it("lets the owner edit their report", async () => {
		await expect(
			canEditReportInstance(
				{ ...othersInstance, userId: caller.id },
				caller,
			),
		).resolves.toBe(true);
	});

	it("refuses an owner whose organization role no longer writes reports", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, userId: caller.id },
				caller,
			),
		).resolves.toBe(false);
	});

	it("refuses an organization Viewer with an Editor row on a project report", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
	});

	it("refuses a same-organization member editing another member's report", async () => {
		await expect(
			canEditReportInstance(othersInstance, caller),
		).resolves.toBe(false);
		await expect(
			assertCanEditReportInstance(othersInstance, caller),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets an organization admin edit another member's report", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("admin"));
		await expect(
			canEditReportInstance(othersInstance, caller),
		).resolves.toBe(true);
	});

	it("lets a project Editor edit another member's project report", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(true);
	});

	it("refuses a project Viewer editing a project report", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(
			assertCanEditReportInstance(
				{ ...othersInstance, projectId: PROJECT },
				caller,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("assertCanManageReportTemplate", () => {
	it("refuses an organization member changing a SYSTEM template", async () => {
		await expect(
			assertCanManageReportTemplate(
				{ scope: "SYSTEM", userId: null, organizationId: null },
				caller,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("lets a platform admin change a SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await expect(
			assertCanManageReportTemplate(
				{ scope: "SYSTEM", userId: null, organizationId: null },
				caller,
			),
		).resolves.toBeUndefined();
	});

	it("limits ORGANIZATION templates to the organization's admins and owners", async () => {
		const template = {
			scope: "ORGANIZATION" as const,
			userId: "example-author",
			organizationId: ORG,
		};
		await expect(
			assertCanManageReportTemplate(template, caller),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("owner"));
		await expect(
			assertCanManageReportTemplate(template, caller),
		).resolves.toBeUndefined();
	});

	it("limits USER templates to their author", async () => {
		await expect(
			assertCanManageReportTemplate(
				{
					scope: "USER",
					userId: "example-author",
					organizationId: null,
				},
				caller,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			assertCanManageReportTemplate(
				{ scope: "USER", userId: caller.id, organizationId: null },
				caller,
			),
		).resolves.toBeUndefined();
	});
});

describe("assertCanPublishReportTemplate", () => {
	it("refuses a member creating a SYSTEM template", async () => {
		await expect(
			assertCanPublishReportTemplate({ scope: "SYSTEM" }, caller),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("refuses a member creating a public template", async () => {
		await expect(
			assertCanPublishReportTemplate(
				{ scope: "ORGANIZATION", isPublic: true },
				caller,
			),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("allows a member's private USER or ORGANIZATION template", async () => {
		await expect(
			assertCanPublishReportTemplate(
				{ scope: "ORGANIZATION", isPublic: false },
				caller,
			),
		).resolves.toBeUndefined();
		expect(mocks.isPlatformAdmin).not.toHaveBeenCalled();
	});

	it("lets a platform admin create a public SYSTEM template", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await expect(
			assertCanPublishReportTemplate(
				{ scope: "SYSTEM", isPublic: true },
				caller,
			),
		).resolves.toBeUndefined();
	});
});

describe("canGenerateReportInstance", () => {
	it("lets only the owner generate, because a report runs on their connections", () => {
		expect(canGenerateReportInstance({ userId: caller.id }, caller)).toBe(
			true,
		);
		expect(
			canGenerateReportInstance(
				{ userId: "example-other-member" },
				caller,
			),
		).toBe(false);
		expect(() =>
			assertCanGenerateReportInstance(
				{ userId: "example-other-member" },
				caller,
			),
		).toThrow("Only the report's owner can generate it");
	});
});
