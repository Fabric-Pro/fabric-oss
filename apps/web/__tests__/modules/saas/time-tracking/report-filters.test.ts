/**
 * The report screen's filters and the request they become: the organization
 * report opens on time and materials, a cleared filter is left out of the
 * request entirely (the API refuses an empty id list), and the Filter button
 * counts what is set.
 */

import {
	activeFilterCount,
	buildReportRequest,
	defaultReportFilters,
	NO_REPORT_FILTERS,
	type ReportScope,
	reportRangeProblem,
} from "@saas/time-tracking/lib/report-filters";
import { describe, expect, it } from "vitest";

const november = { from: "2026-11-01", to: "2026-11-30" };
const organization: ReportScope = {
	kind: "organization",
	organizationId: "org-1",
};
const project: ReportScope = {
	kind: "project",
	projectId: "project-a",
	organizationId: "org-1",
};

describe("defaultReportFilters", () => {
	it("opens the organization report on time-and-materials projects", () => {
		expect(defaultReportFilters("organization")).toEqual({
			...NO_REPORT_FILTERS,
			billingModel: "TIME_AND_MATERIALS",
		});
	});

	it("opens a project report with no filter", () => {
		expect(defaultReportFilters("project")).toEqual(NO_REPORT_FILTERS);
	});
});

describe("activeFilterCount", () => {
	it("counts the project-type default as an active filter", () => {
		expect(activeFilterCount(defaultReportFilters("organization"))).toBe(1);
		expect(activeFilterCount(NO_REPORT_FILTERS)).toBe(0);
	});

	it("counts each filter that is set once", () => {
		expect(
			activeFilterCount({
				projectId: "project-a",
				userId: "user-1",
				billable: "non-billable",
				activity: "TESTING",
				billingModel: "FIXED_BID",
				story: null,
				range: null,
			}),
		).toBe(5);
	});

	it("counts a work item and a custom range as filters", () => {
		expect(
			activeFilterCount({
				...NO_REPORT_FILTERS,
				story: {
					id: "story-1",
					identifier: "F-001",
					title: "Checkout",
				},
				range: { from: "2026-10-15", to: "2026-11-14" },
			}),
		).toBe(2);
	});
});

describe("reportRangeProblem", () => {
	it.each([
		["a single day", { from: "2026-11-01", to: "2026-11-01" }, null],
		[
			"a range across months",
			{ from: "2026-10-15", to: "2026-11-14" },
			null,
		],
		["a full leap year", { from: "2028-01-01", to: "2028-12-31" }, null],
		[
			"an end before the start",
			{ from: "2026-11-02", to: "2026-11-01" },
			"invalid",
		],
		["a missing date", { from: "", to: "2026-11-01" }, "invalid"],
		[
			"more than the cap",
			{ from: "2026-01-01", to: "2027-01-02" },
			"tooLong",
		],
	])("%s → %s", (_label, range, expected) => {
		expect(reportRangeProblem(range)).toBe(expected);
	});
});

describe("buildReportRequest", () => {
	it("sends the T&M default for the organization scope", () => {
		expect(
			buildReportRequest(
				organization,
				november,
				defaultReportFilters("organization"),
			),
		).toEqual({
			kind: "organization",
			input: {
				organizationId: "org-1",
				from: "2026-11-01",
				to: "2026-11-30",
				billingModel: "TIME_AND_MATERIALS",
			},
		});
	});

	it("leaves every unset filter out, so no empty list reaches the API", () => {
		const request = buildReportRequest(
			organization,
			november,
			NO_REPORT_FILTERS,
		);

		expect(request.input).toEqual({
			organizationId: "org-1",
			from: "2026-11-01",
			to: "2026-11-30",
		});
		expect(request.input).not.toHaveProperty("projectIds");
		expect(request.input).not.toHaveProperty("userIds");
		expect(request.input).not.toHaveProperty("billable");
	});

	it("turns each set filter into its API field", () => {
		expect(
			buildReportRequest(organization, november, {
				projectId: "project-a",
				userId: "user-1",
				billable: "non-billable",
				activity: "CODE_REVIEW",
				billingModel: "FIXED_BID",
				story: null,
				range: null,
			}).input,
		).toEqual({
			organizationId: "org-1",
			from: "2026-11-01",
			to: "2026-11-30",
			projectIds: ["project-a"],
			userIds: ["user-1"],
			billable: false,
			activity: "CODE_REVIEW",
			billingModel: "FIXED_BID",
		});
		expect(
			buildReportRequest(organization, november, {
				...NO_REPORT_FILTERS,
				billable: "billable",
			}).input,
		).toMatchObject({ billable: true });
	});

	it("never sends a project filter in the project scope", () => {
		expect(
			buildReportRequest(project, november, {
				...NO_REPORT_FILTERS,
				projectId: "project-b",
				userId: "user-1",
			}),
		).toEqual({
			kind: "project",
			input: {
				projectId: "project-a",
				from: "2026-11-01",
				to: "2026-11-30",
				userIds: ["user-1"],
			},
		});
	});

	it("sends the work item and the custom range of a project report", () => {
		expect(
			buildReportRequest(project, november, {
				...NO_REPORT_FILTERS,
				story: {
					id: "story-1",
					identifier: "F-001",
					title: "Checkout",
				},
				range: { from: "2026-10-15", to: "2026-11-14" },
			}),
		).toEqual({
			kind: "project",
			input: {
				projectId: "project-a",
				from: "2026-10-15",
				to: "2026-11-14",
				storyIds: ["story-1"],
			},
		});
	});

	it("reads the month when no custom range is set", () => {
		expect(
			buildReportRequest(project, november, NO_REPORT_FILTERS).input,
		).toEqual({
			projectId: "project-a",
			from: "2026-11-01",
			to: "2026-11-30",
		});
	});
});
