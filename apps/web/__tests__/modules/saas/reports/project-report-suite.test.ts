import {
	canCreateReportTemplate,
	canManageReportTemplate,
	pickDefaultProjectReportsTab,
	type ReportSuiteCapabilities,
} from "@saas/reports/lib/project-report-suite";
import { describe, expect, it } from "vitest";

const MEMBER: ReportSuiteCapabilities = {
	isPlatformAdmin: false,
	isOrganizationAdmin: false,
	canEditProjectReports: true,
};
const ORG_ADMIN: ReportSuiteCapabilities = {
	...MEMBER,
	isOrganizationAdmin: true,
};
const PLATFORM_ADMIN: ReportSuiteCapabilities = {
	...MEMBER,
	isPlatformAdmin: true,
};

describe("pickDefaultProjectReportsTab", () => {
	it("waits while the project's report count is loading", () => {
		expect(pickDefaultProjectReportsTab(undefined)).toBeNull();
	});

	it("opens on the project's reports once it has one", () => {
		expect(pickDefaultProjectReportsTab(1)).toBe("instances");
		expect(pickDefaultProjectReportsTab(12)).toBe("instances");
	});

	it("opens on templates for a project without reports", () => {
		expect(pickDefaultProjectReportsTab(0)).toBe("templates");
	});
});

describe("canManageReportTemplate", () => {
	const system = { scope: "SYSTEM" as const, userId: null };
	const organization = { scope: "ORGANIZATION" as const, userId: "u-1" };
	const personal = { scope: "USER" as const, userId: "u-1" };

	it("gives System templates to platform admins only", () => {
		expect(canManageReportTemplate(system, PLATFORM_ADMIN, "u-9")).toBe(
			true,
		);
		expect(canManageReportTemplate(system, ORG_ADMIN, "u-9")).toBe(false);
		expect(canManageReportTemplate(system, MEMBER, "u-9")).toBe(false);
	});

	it("gives Organization templates to organization admins", () => {
		expect(canManageReportTemplate(organization, ORG_ADMIN, "u-9")).toBe(
			true,
		);
		// The author alone is not enough for an organization template.
		expect(canManageReportTemplate(organization, MEMBER, "u-1")).toBe(
			false,
		);
		expect(
			canManageReportTemplate(organization, PLATFORM_ADMIN, "u-9"),
		).toBe(false);
	});

	it("gives a personal template to its author", () => {
		expect(canManageReportTemplate(personal, MEMBER, "u-1")).toBe(true);
		expect(canManageReportTemplate(personal, ORG_ADMIN, "u-2")).toBe(false);
		expect(canManageReportTemplate(personal, MEMBER, undefined)).toBe(
			false,
		);
	});
});

describe("canCreateReportTemplate", () => {
	it("offers New template to admins who may edit the project's reports", () => {
		expect(canCreateReportTemplate(PLATFORM_ADMIN)).toBe(true);
		expect(canCreateReportTemplate(ORG_ADMIN)).toBe(true);
		expect(
			canCreateReportTemplate({
				...ORG_ADMIN,
				canEditProjectReports: null,
			}),
		).toBe(true);
	});

	it("withholds it from members and from viewers of the project", () => {
		expect(canCreateReportTemplate(MEMBER)).toBe(false);
		expect(
			canCreateReportTemplate({
				...ORG_ADMIN,
				canEditProjectReports: false,
			}),
		).toBe(false);
	});
});
