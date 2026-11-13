/**
 * The audit row a time report CSV export leaves. The file hands out every
 * member's logged time, so each export is recorded, like `audit.exported`.
 * Reading the report on screen is not.
 *
 * The row carries what was asked for and how many entries the file had,
 * never an entry's contents.
 */

import {
	type AuditRequestContext,
	recordAuditFromRequest,
} from "../../../lib/audit";

export interface TimeReportExportFilters {
	projectIds?: readonly string[];
	userIds?: readonly string[];
	storyIds?: readonly string[];
	billable?: boolean;
	activity?: string;
	billingModel?: string;
}

export function recordTimeReportExport(
	context: AuditRequestContext,
	params: {
		organizationId: string;
		/** Set for a project report, absent for the organization's. */
		projectId?: string;
		from: string;
		to: string;
		filters: TimeReportExportFilters;
		rowCount: number;
	},
): void {
	recordAuditFromRequest(context, {
		action: "time.report_exported",
		category: "audit",
		organizationId: params.organizationId,
		projectId: params.projectId ?? null,
		outcome: "success",
		severity: "info",
		metadata: {
			scope: params.projectId === undefined ? "organization" : "project",
			...(params.projectId === undefined
				? {}
				: { projectId: params.projectId }),
			from: params.from,
			to: params.to,
			filters: params.filters,
			rowCount: params.rowCount,
		},
	});
}
