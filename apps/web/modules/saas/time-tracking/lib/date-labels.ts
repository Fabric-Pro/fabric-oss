/**
 * Display labels for work dates. A work date is a calendar day, not an
 * instant, so it is formatted at UTC midnight in UTC: no zone can move it to
 * the day before.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function workDateAsUtc(workDate: string): Date {
	const match = ISO_DATE.exec(workDate);
	if (!match) {
		throw new RangeError(`Not a YYYY-MM-DD date: ${workDate}`);
	}
	return new Date(
		Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
	);
}

function format(
	workDate: string,
	locale: string,
	options: Intl.DateTimeFormatOptions,
): string {
	return new Intl.DateTimeFormat(locale, {
		...options,
		timeZone: "UTC",
	}).format(workDateAsUtc(workDate));
}

/** `Mon 9` */
export function shortDayLabel(workDate: string, locale: string): string {
	return format(workDate, locale, { weekday: "short", day: "numeric" });
}

/** `Mon, Nov 9` */
export function shortDateLabel(workDate: string, locale: string): string {
	return format(workDate, locale, {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
}

/** `Tuesday, November 10, 2026` */
export function longDateLabel(workDate: string, locale: string): string {
	return format(workDate, locale, {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

/** `November 2026` */
export function monthLabel(workDate: string, locale: string): string {
	return format(workDate, locale, { month: "long", year: "numeric" });
}

/** `November 9 – 15, 2026` */
export function weekRangeLabel(
	from: string,
	to: string,
	locale: string,
): string {
	return new Intl.DateTimeFormat(locale, {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
	}).formatRange(workDateAsUtc(from), workDateAsUtc(to));
}

/** A work date as the local-midnight `Date` a calendar picker shows. */
export function workDateToPickerDate(workDate: string): Date {
	const utc = workDateAsUtc(workDate);
	return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** The work date of the local-midnight `Date` a calendar picker returns. */
export function pickerDateToWorkDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}
