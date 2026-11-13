import { loadTimeReport } from "@repo/database";
import type { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { recordTimeReportExport } from "../lib/report-audit";
import { buildTimeReportCsv, timeReportFilename } from "../lib/report-csv";
import {
	projectReportFiltersObject,
	REPORT_RANGE_ERROR,
	reportRangeWithinCap,
	requireTimeReport,
	serializeTimeReport,
} from "../lib/report-input";
import { requireLiveTimeTrackingProject } from "../lib/save-entry";

export const projectTimeReportInputSchema = projectReportFiltersObject.refine(
	reportRangeWithinCap,
	REPORT_RANGE_ERROR,
);

type ProjectTimeReportInput = z.infer<typeof projectTimeReportInputSchema>;

/**
 * Everyone's time on one project, including people who have since left it.
 * A soft-deleted project is not found. The handlers name each field they
 * pass: the organization always comes from the project row, never the input.
 * A work-item filter can only narrow the project's own entries, since the
 * project filter is applied with it.
 */
async function loadProjectReport(input: ProjectTimeReportInput) {
	const project = await requireLiveTimeTrackingProject(input.projectId);
	const report = requireTimeReport(
		await loadTimeReport({
			organizationId: project.organizationId,
			from: input.from,
			to: input.to,
			projectIds: [project.id],
			userIds: input.userIds,
			storyIds: input.storyIds,
			billable: input.billable,
			activity: input.activity,
			billingModel: input.billingModel,
		}),
	);
	return { project, report };
}

/**
 * A project's time report: every member's entries over a work-date range
 * (inclusive, at most 366 days), with the project subtotal and the grand total
 * computed from exactly those rows.
 */
export const projectTimeReportProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.TIME_REPORT_VIEW))
	.route({
		method: "GET",
		path: "/time-tracking/projects/{projectId}/report",
		tags: ["Time tracking"],
		summary: "Get a project's time report",
		description:
			"Every member's time entries on the project with a work date from `from` to `to` (inclusive, at most 366 days), filtered by person, work item, billable, activity and billing model, with per-project and grand totals in minutes.",
	})
	.input(projectTimeReportInputSchema)
	.handler(async ({ input }) => {
		const { report } = await loadProjectReport({
			projectId: input.projectId,
			from: input.from,
			to: input.to,
			userIds: input.userIds,
			storyIds: input.storyIds,
			billable: input.billable,
			activity: input.activity,
			billingModel: input.billingModel,
		});
		return serializeTimeReport(report);
	});

/**
 * The same report as {@link projectTimeReportProcedure}, as a CSV file. Each
 * export is recorded as `time.report_exported`.
 */
export const exportProjectTimeReportCsvProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.TIME_REPORT_VIEW))
	.route({
		method: "GET",
		path: "/time-tracking/projects/{projectId}/report/csv",
		tags: ["Time tracking"],
		summary: "Export a project's time report as CSV",
		description:
			"The project's time report with the same filters, one CSV line per entry and no total line, with a suggested file name.",
	})
	.input(projectTimeReportInputSchema)
	.handler(async ({ input, context }) => {
		const { project, report } = await loadProjectReport({
			projectId: input.projectId,
			from: input.from,
			to: input.to,
			userIds: input.userIds,
			storyIds: input.storyIds,
			billable: input.billable,
			activity: input.activity,
			billingModel: input.billingModel,
		});
		recordTimeReportExport(context, {
			organizationId: project.organizationId,
			projectId: project.id,
			from: input.from,
			to: input.to,
			filters: {
				userIds: input.userIds,
				storyIds: input.storyIds,
				billable: input.billable,
				activity: input.activity,
				billingModel: input.billingModel,
			},
			rowCount: report.rows.length,
		});
		return {
			filename: timeReportFilename({
				from: input.from,
				to: input.to,
				projectName: project.name,
			}),
			csv: buildTimeReportCsv(report),
		};
	});
