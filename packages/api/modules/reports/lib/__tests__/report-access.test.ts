import {
	resolveOrgPermissions,
	resolveProjectPermissions,
} from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
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

import {
	assertCanEditReportInstance,
	assertCanManageReportTemplate,
	assertCanPublishReportTemplate,
	canCreateProjectReport,
	canDeleteReportInstance,
	canEditProjectReport,
	canEditReportInstance,
	canGenerateReportInstance,
	canManageReportLifecycle,
	canManageReportTemplate,
	canReachProjectReports,
	isOrganizationReportAdmin,
	reportGenerationChecker,
	reportGenerationRefusal,
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
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.isProjectSoftDeleted.mockResolvedValue(false);
});

describe("canReachProjectReports", () => {
	const memberWithNoRow = {
		permissions: resolveOrgPermissions("member"),
		source: "org",
		organizationId: ORG,
		organizationDeleted: false,
	};

	it("refuses a member with no row, though their organization role holds report permissions", async () => {
		mocks.access.mockResolvedValue(memberWithNoRow);
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("lets a member who reaches the project through a row", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			true,
		);
	});

	it("lets an organization admin with no row, by inheritance", async () => {
		mocks.access.mockResolvedValue(memberWithNoRow);
		mocks.hasProjectAccess.mockResolvedValue(false);
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("admin"));

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			true,
		);
	});

	it("refuses a project guest who is not an organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(null);

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("gives nobody standing on a project in the trash, an organization admin included", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("admin"));
		mocks.isProjectSoftDeleted.mockResolvedValue(true);

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});
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

	it("lets a platform admin who is a member edit with a Viewer project row", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(true);
	});

	it("refuses a platform admin who is not a member, even with an Editor row", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
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

	it("lets an organization Viewer whose project row is Editor edit", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(true);
	});

	it("refuses an organization Viewer whose project row is Viewer", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
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

describe("canCreateProjectReport", () => {
	it("lets a member with an Editor row add reports", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			true,
		);
	});

	it("refuses an organization Viewer whose project row is Editor", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project guest who is not an organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project Viewer who is a plain organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("lets an organization admin with a Viewer project row add reports", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("admin"));
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			true,
		);
	});

	it("lets a personal project's owner add reports", async () => {
		mocks.access.mockResolvedValue({
			permissions: resolveProjectPermissions("OWNER"),
			source: "owner",
			organizationId: null,
			organizationDeleted: false,
		});
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			true,
		);
	});

	it("lets a platform admin who is a member add reports, and only then", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			true,
		);

		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("refuses a project in a deleted organization", async () => {
		mocks.access.mockResolvedValue({
			...projectMember("EDITOR"),
			organizationDeleted: true,
		});
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
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

	it("lets an organization Viewer with an Editor row edit a project report", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(true);
	});

	it("refuses an organization Viewer who owns a project report but holds no Editor row", async () => {
		mocks.access.mockResolvedValue({
			permissions: resolveOrgPermissions("viewer"),
			source: "org",
			organizationId: ORG,
			organizationDeleted: false,
		});
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
	});

	it("refuses a project guest with an Editor row who is not an organization member", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(null);
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

	it("lets the project role decide over ownership: an owner with a Viewer row reads and no more", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
	});

	it("still lets the owner of a project report edit it while their project role allows", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(
			canEditReportInstance(
				{ ...othersInstance, userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(true);
	});

	it("lets a platform admin who is a member edit, and refuses one who is not", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(othersInstance, caller),
		).resolves.toBe(true);

		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(
			canEditReportInstance(othersInstance, caller),
		).resolves.toBe(false);
	});
});

describe("canDeleteReportInstance", () => {
	const projectReport = {
		userId: "example-other-member",
		organizationId: ORG,
		projectId: PROJECT,
	};

	it.each(["viewer", "member"])(
		"refuses an organization %s who may edit the report, because the delete procedure would",
		async (role) => {
			mocks.access.mockResolvedValue(projectMember("EDITOR"));
			mocks.getOrganizationMembership.mockResolvedValue(orgRole(role));
			await expect(
				canEditReportInstance(projectReport, caller),
			).resolves.toBe(true);
			await expect(
				canDeleteReportInstance(projectReport, caller),
			).resolves.toBe(false);
		},
	);

	it("lets an organization admin delete", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("admin"));
		await expect(
			canDeleteReportInstance(projectReport, caller),
		).resolves.toBe(true);
	});

	it("keeps it for a platform admin", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		await expect(
			canDeleteReportInstance(projectReport, caller),
		).resolves.toBe(true);
	});
});

describe("canManageReportLifecycle", () => {
	const projectReport = {
		userId: "example-other-member",
		organizationId: ORG,
		projectId: PROJECT,
	};

	it("refuses an organization Viewer who may edit through an Editor row", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canEditReportInstance(projectReport, caller),
		).resolves.toBe(true);
		await expect(
			canManageReportLifecycle(projectReport, caller),
		).resolves.toBe(false);
	});

	it("lets an organization member who may edit manage it", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(
			canManageReportLifecycle(projectReport, caller),
		).resolves.toBe(true);
	});

	it("refuses an organization member who may not edit the report", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(
			canManageReportLifecycle(projectReport, caller),
		).resolves.toBe(false);
	});

	it("lets a platform admin who is a member manage it, whatever their organization role", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canManageReportLifecycle(projectReport, caller),
		).resolves.toBe(true);
	});

	it("refuses a platform admin who is not a member", async () => {
		mocks.isPlatformAdmin.mockResolvedValue(true);
		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(
			canManageReportLifecycle(projectReport, caller),
		).resolves.toBe(false);
	});

	it("lets the owner of a report outside any organization manage it", async () => {
		await expect(
			canManageReportLifecycle(
				{ userId: caller.id, organizationId: null, projectId: null },
				caller,
			),
		).resolves.toBe(true);
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

describe("canManageReportTemplate", () => {
	it("answers without throwing, for the report page's save-to-template choice", async () => {
		await expect(
			canManageReportTemplate(
				{ scope: "SYSTEM", userId: null, organizationId: null },
				caller,
			),
		).resolves.toBe(false);
		await expect(
			canManageReportTemplate(
				{ scope: "USER", userId: caller.id, organizationId: ORG },
				caller,
			),
		).resolves.toBe(true);
	});
});

describe("isOrganizationReportAdmin", () => {
	it.each([
		["admin", true],
		["owner", true],
		["member", false],
	])("answers %s → %s", async (role, expected) => {
		mocks.getOrganizationMembership.mockResolvedValue(orgRole(role));
		await expect(isOrganizationReportAdmin(ORG, caller.id)).resolves.toBe(
			expected,
		);
	});

	it("refuses someone who is not a member", async () => {
		mocks.getOrganizationMembership.mockResolvedValue(null);
		await expect(isOrganizationReportAdmin(ORG, caller.id)).resolves.toBe(
			false,
		);
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
	it("lets only the owner generate, because a report runs on their connections", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		await expect(
			canGenerateReportInstance(
				{ userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(true);
		await expect(
			canGenerateReportInstance(
				{ userId: "example-other-member", projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
		expect(
			reportGenerationRefusal({ userId: "example-other-member" }, caller),
		).toContain("Only the report's owner can generate it");
	});

	it("lets the project role decide over ownership: an owner with a Viewer row reads and no more", async () => {
		mocks.access.mockResolvedValue(projectMember("VIEWER"));
		await expect(
			canGenerateReportInstance(
				{ userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
		expect(
			reportGenerationRefusal({ userId: caller.id }, caller),
		).toContain("but not generate it");
	});

	it("refuses an owner who is an organization Viewer with an Editor row, who edits and no more", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		mocks.getOrganizationMembership.mockResolvedValue(orgRole("viewer"));
		await expect(
			canGenerateReportInstance(
				{ userId: caller.id, projectId: PROJECT },
				caller,
			),
		).resolves.toBe(false);
	});

	it("leaves a report with no project to its owner", async () => {
		await expect(
			canGenerateReportInstance(
				{ userId: caller.id, projectId: null },
				caller,
			),
		).resolves.toBe(true);
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it("asks about each project once across a list", async () => {
		mocks.access.mockResolvedValue(projectMember("EDITOR"));
		const mayGenerate = reportGenerationChecker(caller);

		await mayGenerate({ userId: caller.id, projectId: PROJECT });
		await mayGenerate({ userId: caller.id, projectId: PROJECT });

		expect(mocks.access).toHaveBeenCalledTimes(1);
	});
});
