/**
 * The time report screen's filters and the request they turn into.
 *
 * The organization report opens on time-and-materials projects, the month-end
 * billing view. That default is screen state, not an API rule: it shows as an
 * active filter the user can clear, and the API without it covers every
 * project.
 *
 * A project report can also narrow to one work item and read a custom range
 * of work dates instead of the month the screen steps through.
 */

import {
	inclusiveDaySpan,
	isIsoDate,
	MAX_TIME_REPORT_SPAN_DAYS,
	type ProjectBillingModel,
	type TimeActivity,
} from "@repo/utils/time-tracking";
import type { orpcClient } from "@shared/lib/orpc-client";
import type { StoryRef } from "./entry-draft";
import type { ReportMonth } from "./report-month";

type OrganizationReportInput = Parameters<
	typeof orpcClient.timeTracking.organizationReport
>[0];

type ProjectReportInput = Parameters<
	typeof orpcClient.timeTracking.projectReport
>[0];

export type ReportScope =
	| { kind: "organization"; organizationId: string }
	| { kind: "project"; projectId: string; organizationId: string };

/** A custom range of work dates, both inclusive. */
export type ReportRange = ReportMonth;

/** One report read, typed by the procedure that serves it. */
export type ReportRequest =
	| { kind: "organization"; input: OrganizationReportInput }
	| { kind: "project"; input: ProjectReportInput };

export type BillableFilter = "all" | "billable" | "non-billable";

export interface ReportFilters {
	/** Organization scope only; a project report is one project already. */
	projectId: string | null;
	userId: string | null;
	billable: BillableFilter;
	activity: TimeActivity | null;
	billingModel: ProjectBillingModel | null;
	/** Project scope only: the work item the entries are linked to. */
	story: StoryRef | null;
	/** Project scope only: read these work dates instead of the month. */
	range: ReportRange | null;
}

export const NO_REPORT_FILTERS: ReportFilters = {
	projectId: null,
	userId: null,
	billable: "all",
	activity: null,
	billingModel: null,
	story: null,
	range: null,
};

export type ReportRangeProblem = "invalid" | "tooLong";

/**
 * Why a custom range cannot be read, or null when it can: both dates set, the
 * end on or after the start, and no longer than the API's cap.
 */
export function reportRangeProblem(
	range: ReportRange,
): ReportRangeProblem | null {
	if (!isIsoDate(range.from) || !isIsoDate(range.to)) {
		return "invalid";
	}
	const span = inclusiveDaySpan(range.from, range.to);
	if (span < 1) {
		return "invalid";
	}
	return span > MAX_TIME_REPORT_SPAN_DAYS ? "tooLong" : null;
}

/** What a report opens with in each scope. */
export function defaultReportFilters(
	scope: ReportScope["kind"],
): ReportFilters {
	switch (scope) {
		case "organization":
			return { ...NO_REPORT_FILTERS, billingModel: "TIME_AND_MATERIALS" };
		case "project":
			return NO_REPORT_FILTERS;
		default: {
			const unhandled: never = scope;
			throw new Error(`Unhandled report scope: ${String(unhandled)}`);
		}
	}
}

/** How many filters narrow the report, for the badge on the Filter button. */
export function activeFilterCount(filters: ReportFilters): number {
	return [
		filters.projectId !== null,
		filters.userId !== null,
		filters.billable !== "all",
		filters.activity !== null,
		filters.billingModel !== null,
		filters.story !== null,
		filters.range !== null,
	].filter(Boolean).length;
}

function billableValue(filter: BillableFilter): boolean | undefined {
	switch (filter) {
		case "all":
			return undefined;
		case "billable":
			return true;
		case "non-billable":
			return false;
		default: {
			const unhandled: never = filter;
			throw new Error(`Unhandled billable filter: ${String(unhandled)}`);
		}
	}
}

/**
 * The read for `scope`, `month` and `filters`: the custom range when one is
 * set, else the month. A filter that is not set is left out entirely: the API
 * refuses an empty id list.
 */
export function buildReportRequest(
	scope: ReportScope,
	month: ReportMonth,
	filters: ReportFilters,
): ReportRequest {
	const billable = billableValue(filters.billable);
	const period = filters.range ?? month;
	const shared = {
		from: period.from,
		to: period.to,
		...(filters.userId ? { userIds: [filters.userId] } : {}),
		...(billable === undefined ? {} : { billable }),
		...(filters.activity ? { activity: filters.activity } : {}),
		...(filters.billingModel ? { billingModel: filters.billingModel } : {}),
	};
	switch (scope.kind) {
		case "organization":
			return {
				kind: "organization",
				input: {
					organizationId: scope.organizationId,
					...shared,
					...(filters.projectId
						? { projectIds: [filters.projectId] }
						: {}),
				},
			};
		case "project":
			return {
				kind: "project",
				input: {
					projectId: scope.projectId,
					...shared,
					...(filters.story ? { storyIds: [filters.story.id] } : {}),
				},
			};
		default: {
			const unhandled: never = scope;
			throw new Error(`Unhandled report scope: ${String(unhandled)}`);
		}
	}
}
