/**
 * Every role against every privileged report effect, through the real rules:
 * only the organization membership, the platform role and the resolved project
 * access are stood in for. No second identity exists on a shared environment to
 * prove these live. The real-database counterpart for the tenant checker is
 * `packages/database/__tests__/report-access-roles.integration.test.ts`.
 */

import {
	type Permission,
	Permissions,
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
	assertReportPermission,
	canCreateProjectReport,
	canDeleteReportInstance,
	canEditProjectReport,
	canEditReportInstance,
	canGenerateReportInstance,
	canManageReportLifecycle,
	canReachProjectReports,
	inheritsOrganizationReportEditor,
	mayUseReportPermission,
} from "../report-access";

const ORG = "example-org";
const PROJECT = "example-project";
const caller = { id: "example-caller", role: "user" };
const someoneElsesReport = {
	userId: "example-owner",
	organizationId: ORG,
	projectId: PROJECT,
};

type Identity = {
	label: string;
	orgRole: string | null;
	platformAdmin: boolean;
	projectRole: string | null;
};

type Effects = {
	reachReports: boolean;
	addReports: boolean;
	editReports: boolean;
	manageLifecycle: boolean;
	deleteReports: boolean;
	generateOwnReport: boolean;
	inherits: boolean;
	/** What the organization role grants a procedure, whatever the project says. */
	holds: {
		create: boolean;
		update: boolean;
		remove: boolean;
		execute: boolean;
	};
};

const HOLDS_NOTHING = {
	create: false,
	update: false,
	remove: false,
	execute: false,
};
const HOLDS_MEMBER = {
	create: true,
	update: true,
	remove: false,
	execute: true,
};
const NOTHING: Effects = {
	reachReports: false,
	addReports: false,
	editReports: false,
	manageLifecycle: false,
	deleteReports: false,
	generateOwnReport: false,
	inherits: false,
	holds: HOLDS_NOTHING,
};
const EVERYTHING: Effects = {
	reachReports: true,
	addReports: true,
	editReports: true,
	manageLifecycle: true,
	deleteReports: true,
	generateOwnReport: true,
	inherits: true,
	holds: { create: true, update: true, remove: true, execute: true },
};

const MATRIX: Array<Identity & { expected: Effects }> = [
	{
		label: "organization Viewer",
		orgRole: "viewer",
		platformAdmin: false,
		projectRole: null,
		expected: NOTHING,
	},
	{
		label: "organization Viewer with an Editor project row",
		orgRole: "viewer",
		platformAdmin: false,
		projectRole: "EDITOR",
		expected: { ...NOTHING, reachReports: true, editReports: true },
	},
	{
		label: "organization Member with no project row",
		orgRole: "member",
		platformAdmin: false,
		projectRole: null,
		expected: { ...NOTHING, holds: HOLDS_MEMBER },
	},
	{
		label: "organization Member with a Viewer project row",
		orgRole: "member",
		platformAdmin: false,
		projectRole: "VIEWER",
		expected: { ...NOTHING, reachReports: true, holds: HOLDS_MEMBER },
	},
	{
		label: "organization Member with an Editor project row",
		orgRole: "member",
		platformAdmin: false,
		projectRole: "EDITOR",
		expected: {
			reachReports: true,
			addReports: true,
			editReports: true,
			manageLifecycle: true,
			deleteReports: false,
			generateOwnReport: true,
			inherits: false,
			holds: HOLDS_MEMBER,
		},
	},
	{
		label: "organization Admin with no project row",
		orgRole: "admin",
		platformAdmin: false,
		projectRole: null,
		expected: EVERYTHING,
	},
	{
		label: "organization Owner with no project row",
		orgRole: "owner",
		platformAdmin: false,
		projectRole: null,
		expected: EVERYTHING,
	},
	{
		label: "project guest who is no organization member",
		orgRole: null,
		platformAdmin: false,
		projectRole: "EDITOR",
		expected: NOTHING,
	},
	{
		label: "system admin who is a member",
		orgRole: "viewer",
		platformAdmin: true,
		projectRole: null,
		expected: EVERYTHING,
	},
	{
		label: "system admin who is no member",
		orgRole: null,
		platformAdmin: true,
		projectRole: null,
		expected: NOTHING,
	},
	{
		label: "member of a foreign organization",
		orgRole: null,
		platformAdmin: false,
		projectRole: null,
		expected: NOTHING,
	},
];

function arrange({ orgRole, platformAdmin, projectRole }: Identity) {
	mocks.isPlatformAdmin.mockResolvedValue(platformAdmin);
	mocks.hasProjectAccess.mockResolvedValue(projectRole !== null);
	mocks.isProjectSoftDeleted.mockResolvedValue(false);
	mocks.getOrganizationMembership.mockResolvedValue(
		orgRole ? { role: orgRole, organization: { id: ORG } } : null,
	);
	if (projectRole) {
		mocks.access.mockResolvedValue({
			permissions: resolveProjectPermissions(projectRole),
			source: "project-member",
			organizationId: ORG,
			organizationDeleted: false,
		});
	} else if (orgRole) {
		mocks.access.mockResolvedValue({
			permissions: resolveOrgPermissions(orgRole),
			source: "org",
			organizationId: ORG,
			organizationDeleted: false,
		});
	} else {
		mocks.access.mockResolvedValue(null);
	}
}

async function holds(permission: Permission) {
	return assertReportPermission(ORG, caller, permission).then(
		() => true,
		() => false,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("report role matrix", () => {
	describe.each(MATRIX)("$label", ({ expected, ...identity }) => {
		beforeEach(() => arrange(identity));

		it("opens the project's reports only when the role reaches the project", async () => {
			await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
				expected.reachReports,
			);
		});

		it("adds a report to the project only when the role allows it", async () => {
			await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
				expected.addReports,
			);
		});

		it("edits the project's reports and its defaults only when the role allows it", async () => {
			await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
				expected.editReports,
			);
			await expect(
				canEditReportInstance(someoneElsesReport, caller),
			).resolves.toBe(expected.editReports);
		});

		it("switches on, schedules, archives and restores only when the role allows it", async () => {
			await expect(
				canManageReportLifecycle(someoneElsesReport, caller),
			).resolves.toBe(expected.manageLifecycle);
		});

		it("deletes only when the role allows it", async () => {
			await expect(
				canDeleteReportInstance(someoneElsesReport, caller),
			).resolves.toBe(expected.deleteReports);
		});

		it("holds the organization permissions a procedure asks of it", async () => {
			await expect(holds(Permissions.REPORT_CREATE)).resolves.toBe(
				expected.holds.create,
			);
			await expect(holds(Permissions.REPORT_UPDATE)).resolves.toBe(
				expected.holds.update,
			);
			await expect(holds(Permissions.REPORT_DELETE)).resolves.toBe(
				expected.holds.remove,
			);
			await expect(
				mayUseReportPermission(ORG, caller, Permissions.REPORT_EXECUTE),
			).resolves.toBe(expected.holds.execute);
		});

		it("inherits Project Editor on every live project only when the role does", async () => {
			await expect(
				inheritsOrganizationReportEditor(ORG, caller),
			).resolves.toBe(expected.inherits);
		});

		it("never generates a report someone else owns, because a run uses the owner's connections", async () => {
			await expect(
				canGenerateReportInstance(someoneElsesReport, caller),
			).resolves.toBe(false);
		});

		it("generates its own report only when the role allows it", async () => {
			await expect(
				canGenerateReportInstance(
					{ ...someoneElsesReport, userId: caller.id },
					caller,
				),
			).resolves.toBe(expected.generateOwnReport);
		});
	});

	it("gives nobody standing on a project in the trash", async () => {
		arrange({
			label: "organization Admin",
			orgRole: "admin",
			platformAdmin: false,
			projectRole: null,
		});
		mocks.isProjectSoftDeleted.mockResolvedValue(true);

		await expect(canReachProjectReports(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canCreateProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
		await expect(canEditProjectReport(PROJECT, caller)).resolves.toBe(
			false,
		);
	});

	it("lets the project role decide over ownership for a report with a project", async () => {
		arrange({
			label: "owner with a Viewer row",
			orgRole: "member",
			platformAdmin: false,
			projectRole: "VIEWER",
		});
		const ownReport = { ...someoneElsesReport, userId: caller.id };

		await expect(canEditReportInstance(ownReport, caller)).resolves.toBe(
			false,
		);
		await expect(canManageReportLifecycle(ownReport, caller)).resolves.toBe(
			false,
		);
		await expect(
			canGenerateReportInstance(ownReport, caller),
		).resolves.toBe(false);
	});

	it("leaves a report with no project to its owner", async () => {
		arrange({
			label: "owner, no project",
			orgRole: "member",
			platformAdmin: false,
			projectRole: null,
		});
		const unbound = { ...someoneElsesReport, projectId: null };

		await expect(
			canEditReportInstance({ ...unbound, userId: caller.id }, caller),
		).resolves.toBe(true);
		await expect(canEditReportInstance(unbound, caller)).resolves.toBe(
			false,
		);
		await expect(
			canGenerateReportInstance(
				{ ...unbound, userId: caller.id },
				caller,
			),
		).resolves.toBe(true);
	});
});
