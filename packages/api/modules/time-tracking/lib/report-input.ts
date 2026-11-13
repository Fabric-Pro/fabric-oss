/**
 * The input a time report is read with, for both scopes, and the step from a
 * loaded report to the wire.
 *
 * The filters are optional and combine with AND. With no `billingModel` the
 * report covers every project; the month-end default to time and materials
 * belongs to the screen, not the API.
 */

import { ORPCError } from "@orpc/server";
import type { TimeReport, TimeReportResult } from "@repo/database";
import {
	inclusiveDaySpan,
	isIsoDate,
	MAX_TIME_REPORT_SPAN_DAYS,
	PROJECT_BILLING_MODEL_VALUES,
	TIME_ACTIVITY_VALUES,
} from "@repo/utils/time-tracking";
import { z } from "zod";
import { INPUT_BOUNDS } from "../../../lib/zod-bounds";
import { workDateSchema } from "./entry-input";

/** More ids than one report filter ever needs, so a request stays bounded. */
const MAX_FILTER_IDS = 500;

const idListSchema = z
	.array(z.string().min(1).max(INPUT_BOUNDS.name))
	.min(1)
	.max(MAX_FILTER_IDS);

/**
 * The filters both scopes share. Left unrefined so each scope can extend it;
 * each procedure then refines the result with {@link reportRangeWithinCap}.
 */
const timeReportFiltersObject = z.object({
	/** First work date, inclusive. */
	from: workDateSchema,
	/** Last work date, inclusive. */
	to: workDateSchema,
	userIds: idListSchema.optional(),
	billable: z.boolean().optional(),
	activity: z.enum(TIME_ACTIVITY_VALUES).optional(),
	/** Matched against each project's current billing model. */
	billingModel: z.enum(PROJECT_BILLING_MODEL_VALUES).optional(),
});

export const organizationReportFiltersObject = timeReportFiltersObject.extend({
	organizationId: z.string().min(1).max(INPUT_BOUNDS.name),
	projectIds: idListSchema.optional(),
});

export const projectReportFiltersObject = timeReportFiltersObject.extend({
	projectId: z.string().min(1).max(INPUT_BOUNDS.name),
	/** Entries linked to one of these work items of the project. */
	storyIds: idListSchema.optional(),
});

/** The range ends on or after its start and covers at most a leap year. */
export function reportRangeWithinCap(input: {
	from: string;
	to: string;
}): boolean {
	// An unreadable date is already reported on its own field.
	if (!isIsoDate(input.from) || !isIsoDate(input.to)) {
		return true;
	}
	const span = inclusiveDaySpan(input.from, input.to);
	return span >= 1 && span <= MAX_TIME_REPORT_SPAN_DAYS;
}

export const REPORT_RANGE_ERROR = {
	message: `Choose a range of 1 to ${MAX_TIME_REPORT_SPAN_DAYS} days, ending on or after its start`,
	path: ["to"],
};

/**
 * The report, or a refusal when it has more entries than one report returns.
 * Refused rather than cut short, so a total on screen is never partial.
 */
export function requireTimeReport(result: TimeReportResult): TimeReport {
	switch (result.status) {
		case "ok":
			return result.report;
		case "too_many_rows":
			throw new ORPCError("BAD_REQUEST", {
				message: `This report has more than ${result.limit} entries. Choose a shorter range or narrow the filters.`,
				data: { reason: "TOO_MANY_ROWS", limit: result.limit },
			});
		default: {
			const unhandled: never = result;
			throw new Error(`Unhandled report result: ${String(unhandled)}`);
		}
	}
}

/** A report as both report procedures return it. */
export function serializeTimeReport(report: TimeReport) {
	return {
		rows: report.rows.map((row) => ({
			id: row.id,
			workDate: row.workDate,
			timezone: row.timezone,
			projectId: row.projectId,
			projectName: row.projectName,
			billingModel: row.billingModel,
			userId: row.userId,
			userName: row.userName,
			activity: row.activity,
			billable: row.billable,
			durationMinutes: row.durationMinutes,
			description: row.description,
			storyId: row.storyId,
			storyIdentifier: row.storyIdentifier,
			storyTitle: row.storyTitle,
			startAt: row.startAt?.toISOString() ?? null,
			stopAt: row.stopAt?.toISOString() ?? null,
		})),
		projects: report.projects,
		totals: report.totals,
	};
}
