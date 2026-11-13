import { ORPCError } from "@orpc/server";
import { loadTimeReport } from "@repo/database";
import type { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { recordTimeReportExport } from "../lib/report-audit";
import { buildTimeReportCsv, timeReportFilename } from "../lib/report-csv";
import {
	organizationReportFiltersObject,
	REPORT_RANGE_ERROR,
	reportRangeWithinCap,
	requireTimeReport,
	serializeTimeReport,
} from "../lib/report-input";

export const organizationTimeReportInputSchema =
	organizationReportFiltersObject.refine(
		reportRangeWithinCap,
		REPORT_RANGE_ERROR,
	);

type OrganizationTimeReportInput = z.infer<
	typeof organizationTimeReportInputSchema
>;

async function loadOrganizationReport(
	input: OrganizationTimeReportInput,
	session: { activeOrganizationId?: string | null },
) {
	const organizationId = resolveOrganizationId(input.organizationId, session);
	if (!organizationId) {
		throw new ORPCError("BAD_REQUEST", {
			message: "organizationId is required",
		});
	}
	const report = requireTimeReport(
		await loadTimeReport({
			organizationId,
			from: input.from,
			to: input.to,
			projectIds: input.projectIds,
			userIds: input.userIds,
			billable: input.billable,
			activity: input.activity,
			billingModel: input.billingModel,
		}),
	);
	return { organizationId, report };
}

/**
 * The organization's time report: every member's entries on every live
 * project of the organization over a work-date range (inclusive, at most 366
 * days), with per-project subtotals and the grand total computed from exactly
 * those rows. Entries of people who have since left a project or the
 * organization stay in.
 *
 * Deliberately wider than discovery. Logging time follows the project
 * discovery rule (an organization role alone does not make a project
 * visible; see `../lib/project-access.ts`), but TIME_REPORT_VIEW at the
 * organization level is held only by its admins and owners, and they see the
 * organization's time on every project here, including projects they are not
 * a member of. That is what a month-end billing report is for.
 */
export const organizationTimeReportProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TIME_REPORT_VIEW, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/organizations/{organizationId}/report",
		tags: ["Time tracking"],
		summary: "Get the organization's time report",
		description:
			"Every member's time entries on the organization's projects with a work date from `from` to `to` (inclusive, at most 366 days), filtered by project, person, billable, activity and current project billing model, with per-project and grand totals in minutes. With no billingModel every project is included.",
	})
	.input(organizationTimeReportInputSchema)
	.handler(async ({ input, context }) => {
		const { report } = await loadOrganizationReport(input, context.session);
		return serializeTimeReport(report);
	});

/**
 * The same report as {@link organizationTimeReportProcedure}, as a CSV file.
 * Each export is recorded as `time.report_exported`.
 */
export const exportOrganizationTimeReportCsvProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.TIME_REPORT_VIEW, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "GET",
		path: "/time-tracking/organizations/{organizationId}/report/csv",
		tags: ["Time tracking"],
		summary: "Export the organization's time report as CSV",
		description:
			"The organization's time report with the same filters, one CSV line per entry and no total line, with a suggested file name.",
	})
	.input(organizationTimeReportInputSchema)
	.handler(async ({ input, context }) => {
		const { organizationId, report } = await loadOrganizationReport(
			input,
			context.session,
		);
		recordTimeReportExport(context, {
			organizationId,
			from: input.from,
			to: input.to,
			filters: {
				projectIds: input.projectIds,
				userIds: input.userIds,
				billable: input.billable,
				activity: input.activity,
				billingModel: input.billingModel,
			},
			rowCount: report.rows.length,
		});
		return {
			filename: timeReportFilename({ from: input.from, to: input.to }),
			csv: buildTimeReportCsv(report),
		};
	});
