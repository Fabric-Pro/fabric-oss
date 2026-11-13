/**
 * The calendar month a time report covers, as its first and last work date
 * (`YYYY-MM-DD`). Months are never handled as instants, so no time zone can
 * move a boundary.
 */

import { addDays, isIsoDate } from "@repo/utils/time-tracking";

export interface ReportMonth {
	/** First day of the month, inclusive. */
	from: string;
	/** Last day of the month, inclusive. */
	to: string;
}

/** `YYYY-MM-01` of the month `months` after the month starting on `firstDay`. */
function shiftedFirstDay(firstDay: string, months: number): string {
	const monthIndex = Number(firstDay.slice(5, 7)) - 1 + months;
	const year = Number(firstDay.slice(0, 4)) + Math.floor(monthIndex / 12);
	const month = ((monthIndex % 12) + 12) % 12;
	return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The month that contains `date`. */
export function monthRange(date: string): ReportMonth {
	if (!isIsoDate(date)) {
		throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
	}
	const from = `${date.slice(0, 7)}-01`;
	return { from, to: addDays(shiftedFirstDay(from, 1), -1) };
}

/** The month `months` after `month`; negative steps back. */
export function shiftMonth(month: ReportMonth, months: number): ReportMonth {
	return monthRange(shiftedFirstDay(month.from, months));
}
