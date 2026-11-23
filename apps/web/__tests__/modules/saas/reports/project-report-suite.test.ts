import {
	canCreateReportTemplate,
	canManageReportTemplate,
	isReportRunning,
	isReportTemplateListed,
	listedReportTemplates,
	listShowsStartedRun,
	pickDefaultProjectReportsTab,
	projectReportsHref,
	type ReportSuiteCapabilities,
	RUNNING_REPORTS_POLL_MS,
	runningReportsPollInterval,
	withProjectContext,
} from "@saas/reports/lib/project-report-suite";
import { describe, expect, it } from "vitest";

describe("running reports", () => {
	it("counts a started or running latest run as running", () => {
		expect(isReportRunning({ latestExecutionStatus: "PENDING" })).toBe(
			true,
		);
		expect(isReportRunning({ latestExecutionStatus: "RUNNING" })).toBe(
			true,
		);
		expect(isReportRunning({ latestExecutionStatus: "COMPLETED" })).toBe(
			false,
		);
		expect(isReportRunning({ latestExecutionStatus: null })).toBe(false);
	});

	it("polls the report list while any listed report runs", () => {
		expect(
			runningReportsPollInterval([
				{ latestExecutionStatus: "COMPLETED" },
				{ latestExecutionStatus: "RUNNING" },
			]),
		).toBe(RUNNING_REPORTS_POLL_MS);
	});

	it("waits for the refetched list to show the run a press started", () => {
		const pressed = {
			instanceId: "report-1",
			executionCount: 3,
			lastRunAt: "2026-01-05T10:00:00.000Z",
		};
		const before = {
			latestExecutionStatus: "COMPLETED",
			executionCount: 3,
			lastRunAt: "2026-01-05T10:00:00.000Z",
		};

		expect(listShowsStartedRun(before, pressed)).toBe(false);
		expect(
			listShowsStartedRun(
				{ ...before, latestExecutionStatus: "PENDING" },
				pressed,
			),
		).toBe(true);
		expect(
			listShowsStartedRun({ ...before, executionCount: 4 }, pressed),
		).toBe(true);
		expect(
			listShowsStartedRun(
				{ ...before, lastRunAt: "2026-01-05T11:00:00.000Z" },
				pressed,
			),
		).toBe(true);
	});

	it("stops polling once the refetched list shows every run finished", () => {
		expect(
			runningReportsPollInterval([
				{ latestExecutionStatus: "COMPLETED" },
				{ latestExecutionStatus: "FAILED" },
				{ latestExecutionStatus: null },
			]),
		).toBe(false);
		expect(runningReportsPollInterval([])).toBe(false);
		expect(runningReportsPollInterval(undefined)).toBe(false);
	});
});

describe("project context links", () => {
	it("leads back to the project's Reports tab", () => {
		expect(projectReportsHref("/app/example-org", "project-1")).toBe(
			"/app/example-org/projects/project-1?tab=reports",
		);
	});

	it("carries the project onto a template page opened from it", () => {
		expect(
			withProjectContext(
				"/app/example-org/report-templates/t-1",
				"project-1",
			),
		).toBe("/app/example-org/report-templates/t-1?projectId=project-1");
		expect(
			withProjectContext("/app/example-org/report-templates/t-1", null),
		).toBe("/app/example-org/report-templates/t-1");
	});
});

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
	it("waits while the viewer's report count is loading", () => {
		expect(pickDefaultProjectReportsTab(undefined)).toBeNull();
	});

	it("opens on the reports once the viewer has one here, a draft included", () => {
		expect(pickDefaultProjectReportsTab(1)).toBe("instances");
		expect(pickDefaultProjectReportsTab(12)).toBe("instances");
	});

	it("opens on templates for a viewer without reports here", () => {
		expect(pickDefaultProjectReportsTab(0)).toBe("templates");
	});

	it("opens on templates when the count never loaded", () => {
		expect(pickDefaultProjectReportsTab(undefined, true)).toBe("templates");
	});

	it("keeps the last count when its refresh failed", () => {
		expect(pickDefaultProjectReportsTab(3, true)).toBe("instances");
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

describe("isReportTemplateListed", () => {
	const archivedAt = "2026-11-04T12:00:00.000Z";

	it("lists every active template", () => {
		expect(
			isReportTemplateListed(
				{ scope: "SYSTEM", userId: null, archivedAt: null },
				MEMBER,
				"u-1",
			),
		).toBe(true);
	});

	it("lists an archived personal template to its author so they can restore it", () => {
		expect(
			isReportTemplateListed(
				{ scope: "USER", userId: "u-1", archivedAt },
				MEMBER,
				"u-1",
			),
		).toBe(true);
	});

	it("hides archived templates from members who cannot restore them", () => {
		expect(
			isReportTemplateListed(
				{ scope: "ORGANIZATION", userId: "u-2", archivedAt },
				MEMBER,
				"u-1",
			),
		).toBe(false);
		expect(
			isReportTemplateListed(
				{ scope: "SYSTEM", userId: null, archivedAt },
				ORG_ADMIN,
				"u-1",
			),
		).toBe(false);
	});
});

describe("listedReportTemplates", () => {
	const archivedAt = "2026-11-04T12:00:00.000Z";
	const active = { scope: "SYSTEM" as const, userId: null, archivedAt: null };
	const ownArchived = { scope: "USER" as const, userId: "u-1", archivedAt };
	const orgArchived = {
		scope: "ORGANIZATION" as const,
		userId: "u-2",
		archivedAt,
	};

	it("hides archived templates until asked, and offers them to whoever may restore one", () => {
		expect(
			listedReportTemplates([active, ownArchived], MEMBER, "u-1", false),
		).toEqual({ templates: [active], hasRestorable: true });
		expect(
			listedReportTemplates([active, ownArchived], MEMBER, "u-1", true),
		).toEqual({ templates: [active, ownArchived], hasRestorable: true });
	});

	it("offers no archived switch to someone who may restore none", () => {
		expect(
			listedReportTemplates([active, orgArchived], MEMBER, "u-1", true),
		).toEqual({ templates: [active], hasRestorable: false });
	});
});
