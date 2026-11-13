/**
 * A time report as a CSV file, built on the server from the same loaded
 * report the screen shows, so its rows always match the report's.
 *
 * One line per entry, no total line: totals are the screen's, and a summing
 * spreadsheet would count a total line twice.
 */

import type { TimeReport, TimeReportRow } from "@repo/database";
import { buildCsv, type CsvCell } from "@repo/utils/csv";
import {
	formatDecimalHours,
	PROJECT_BILLING_MODEL_LABELS,
	TIME_ACTIVITY_LABELS,
} from "@repo/utils/time-tracking";

/**
 * Machine-readable column names, so a spreadsheet or script can rely on them:
 * `duration_minutes` is the canonical duration, `duration_hours` is derived
 * from it, and the timed fields are empty for a duration-only entry.
 */
export const TIME_REPORT_CSV_HEADER = [
	"work_date",
	"user",
	"project",
	"project_type",
	"work_item_reference",
	"work_item_title",
	"activity",
	"duration_minutes",
	"duration_hours",
	"billable",
	"description",
	"start_at",
	"stop_at",
	"timezone",
] as const;

/**
 * ISO 8601 with the UTC offset in force in `timeZone` at that instant, such
 * as `2026-03-02T09:00:00+01:00`, so the value is unambiguous on its own.
 */
function isoWithOffset(instant: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((p) => p.type === type)?.value ?? "";
	const offset = part("timeZoneName").replace("GMT", "") || "+00:00";
	return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}${offset}`;
}

function csvRow(row: TimeReportRow): CsvCell[] {
	const timed = row.startAt !== null && row.stopAt !== null;
	return [
		row.workDate,
		row.userName,
		row.projectName,
		PROJECT_BILLING_MODEL_LABELS[row.billingModel],
		row.storyIdentifier,
		row.storyTitle,
		TIME_ACTIVITY_LABELS[row.activity],
		row.durationMinutes,
		formatDecimalHours(row.durationMinutes),
		row.billable ? "billable" : "non-billable",
		row.description,
		row.startAt ? isoWithOffset(row.startAt, row.timezone) : null,
		row.stopAt ? isoWithOffset(row.stopAt, row.timezone) : null,
		timed ? row.timezone : null,
	];
}

export function buildTimeReportCsv(report: TimeReport): string {
	return buildCsv(TIME_REPORT_CSV_HEADER, report.rows.map(csvRow));
}

/** `my-project` from `My Project!`, for a file name. */
function fileNamePart(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return slug === "" ? "project" : slug;
}

/** `time-<project>-<from>-to-<to>.csv`, or `time-<from>-to-<to>.csv`. */
export function timeReportFilename(params: {
	from: string;
	to: string;
	projectName?: string;
}): string {
	const scope =
		params.projectName === undefined
			? ""
			: `${fileNamePart(params.projectName)}-`;
	return `time-${scope}${params.from}-to-${params.to}.csv`;
}
