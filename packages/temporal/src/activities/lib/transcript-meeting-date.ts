/**
 * The date a transcript file's meeting was held, read from the file itself
 * (Fizzy #3507, FR13).
 *
 * A folder can hold a year of meetings, so the day a file is imported says
 * nothing about the day it was held. The filename is read first, since export
 * tools put the date there, then the top of the text, where Teams and Otter
 * exports print it under the title. Only the top: a date in the conversation
 * ("the release is on 1 December") is not the meeting's.
 *
 * A date that could be read two ways (03/04/2026) is not guessed at. Unknown is
 * an honest answer, and the user can set it; a wrong date files the meeting
 * under the wrong day without anyone noticing.
 */

/** How much of the text counts as its top. */
const HEADER_CHARS = 600;

const MONTHS: Record<string, number> = {
	jan: 1,
	january: 1,
	feb: 2,
	february: 2,
	mar: 3,
	march: 3,
	apr: 4,
	april: 4,
	may: 5,
	jun: 6,
	june: 6,
	jul: 7,
	july: 7,
	aug: 8,
	august: 8,
	sep: 9,
	sept: 9,
	september: 9,
	oct: 10,
	october: 10,
	nov: 11,
	november: 11,
	dec: 12,
	december: 12,
};

const MONTH_NAME = `(${Object.keys(MONTHS)
	.sort((a, b) => b.length - a.length)
	.join("|")})\\.?`;

// The digits around a date must not be digits, or "1202611050" would read as
// a date inside a longer number.
const YEAR_FIRST = /(?<!\d)(20\d{2})[-_. ](\d{1,2})[-_. ](\d{1,2})(?!\d)/;
const COMPACT = /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/;
const MONTH_FIRST = new RegExp(
	`\\b${MONTH_NAME}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})(?!\\d)`,
	"i",
);
const DAY_FIRST = new RegExp(
	`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_NAME},?\\s+(20\\d{2})(?!\\d)`,
	"i",
);
const NUMERIC = /(?<!\d)(\d{1,2})[/.](\d{1,2})[/.](20\d{2})(?!\d)/;

/**
 * Noon UTC, not midnight: the digest groups meetings by the viewer's local
 * day, and noon is the same calendar day everywhere from UTC-11 to UTC+11.
 */
function dateOf(year: number, month: number, day: number): Date | null {
	if (month < 1 || month > 12 || day < 1 || day > 31) {
		return null;
	}
	const date = new Date(Date.UTC(year, month - 1, day, 12));
	// 2026-02-30 rolls over into March; that is not a date.
	return date.getUTCMonth() === month - 1 && date.getUTCDate() === day
		? date
		: null;
}

function monthNumber(name: string): number | null {
	return MONTHS[name.toLowerCase().replace(/\.$/, "")] ?? null;
}

function dateIn(text: string): Date | null {
	const yearFirst = text.match(YEAR_FIRST);
	if (yearFirst) {
		const date = dateOf(
			Number(yearFirst[1]),
			Number(yearFirst[2]),
			Number(yearFirst[3]),
		);
		if (date) {
			return date;
		}
	}

	const compact = text.match(COMPACT);
	if (compact) {
		const date = dateOf(
			Number(compact[1]),
			Number(compact[2]),
			Number(compact[3]),
		);
		if (date) {
			return date;
		}
	}

	const monthFirst = text.match(MONTH_FIRST);
	if (monthFirst?.[1]) {
		const month = monthNumber(monthFirst[1]);
		const date =
			month &&
			dateOf(Number(monthFirst[3]), month, Number(monthFirst[2]));
		if (date) {
			return date;
		}
	}

	const dayFirst = text.match(DAY_FIRST);
	if (dayFirst?.[2]) {
		const month = monthNumber(dayFirst[2]);
		const date =
			month && dateOf(Number(dayFirst[3]), month, Number(dayFirst[1]));
		if (date) {
			return date;
		}
	}

	const numeric = text.match(NUMERIC);
	if (numeric) {
		const first = Number(numeric[1]);
		const second = Number(numeric[2]);
		const year = Number(numeric[3]);
		// Only when one reading is impossible: 25/10 is a day first, 10/25 a
		// month first, and 03/04 could be either.
		if (first > 12 && second <= 12) {
			return dateOf(year, second, first);
		}
		if (second > 12 && first <= 12) {
			return dateOf(year, first, second);
		}
	}

	return null;
}

export function inferMeetingDate(params: {
	filename: string;
	text: string;
}): Date | null {
	const name = params.filename.replace(/\.[^/.]+$/, "");
	return dateIn(name) ?? dateIn(params.text.slice(0, HEADER_CHARS));
}
