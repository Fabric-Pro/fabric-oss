import type { ScheduleSpecDescription } from "@temporalio/client";
import { CronExpressionParser } from "cron-parser";

const months = [
	"JANUARY",
	"FEBRUARY",
	"MARCH",
	"APRIL",
	"MAY",
	"JUNE",
	"JULY",
	"AUGUST",
	"SEPTEMBER",
	"OCTOBER",
	"NOVEMBER",
	"DECEMBER",
];
const days = [
	"SUNDAY",
	"MONDAY",
	"TUESDAY",
	"WEDNESDAY",
	"THURSDAY",
	"FRIDAY",
	"SATURDAY",
];
function expand(
	ranges: { start: number | string; end: number | string; step: number }[],
	names?: string[],
	offset = 0,
): number[] {
	const values = new Set<number>();
	for (const range of ranges) {
		const start =
			typeof range.start === "number"
				? range.start
				: (names?.indexOf(range.start) ?? -1) + offset;
		const end =
			typeof range.end === "number"
				? range.end
				: (names?.indexOf(range.end) ?? -1) + offset;
		if (start < 0 || end < start || end > 9999) {
			throw new Error("Unsupported calendar range");
		}
		for (
			let value = start;
			value <= end;
			value += Math.max(1, range.step)
		) {
			values.add(value);
		}
	}
	return [...values].sort((a, b) => a - b);
}
const key = (values: readonly (number | string)[]) =>
	[...new Set(values)].sort((a, b) => Number(a) - Number(b)).join(",");
/** Temporal returns normalized calendars, never the cron string supplied on creation. */
export function workflowScheduleMatches(
	spec: ScheduleSpecDescription,
	expected: { cron: string; timezone?: string | null },
): boolean | null {
	if (
		(spec.timezone || "UTC") !== (expected.timezone || "UTC") ||
		spec.intervals?.length ||
		spec.skip?.length ||
		spec.startAt ||
		spec.endAt ||
		spec.calendars?.length !== 1
	) {
		return false;
	}
	try {
		const parts = expected.cron.trim().split(/\s+/);
		if (parts.length !== 5 && parts.length !== 6) {
			return null;
		}
		// L/# are cron-parser extensions with different semantics from a Temporal calendar.
		if (parts.some((part) => /[LW#?]/i.test(part))) {
			return null;
		}
		const fields = CronExpressionParser.parse(
			parts.slice(0, 5).join(" "),
		).fields;
		const calendar = spec.calendars[0];
		const pairs = [
			[expand(calendar.second), [0]],
			[expand(calendar.minute), fields.minute.values],
			[expand(calendar.hour), fields.hour.values],
			[expand(calendar.dayOfMonth), fields.dayOfMonth.values],
			[expand(calendar.month, months, 1), fields.month.values],
			[
				expand(calendar.dayOfWeek, days),
				fields.dayOfWeek.values.map((value) => Number(value) % 7),
			],
		];
		if (pairs.some(([actual, wanted]) => key(actual) !== key(wanted))) {
			return false;
		}
		if (!parts[5] || parts[5] === "*") {
			return calendar.year.length === 0;
		}
		const years = new Set<number>();
		for (const part of parts[5].split(",")) {
			const match = /^(\d{4})(?:-(\d{4}))?(?:\/(\d+))?$/.exec(part);
			if (!match) {
				return null;
			}
			const from = Number(match[1]);
			const to = Number(match[2] ?? (match[3] ? 9999 : match[1]));
			const step = Number(match[3] ?? 1);
			if (from < 1970 || to > 9999 || from > to || step < 1) {
				return null;
			}
			for (let year = from; year <= to; year += step) {
				years.add(year);
			}
		}
		return key(expand(calendar.year)) === key([...years]);
	} catch {
		return null;
	}
}
