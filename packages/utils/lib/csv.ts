/**
 * CSV files people open in a spreadsheet.
 *
 * Fields are quoted per RFC 4180, rows end in CRLF, and a cell that starts
 * with a character a spreadsheet reads as the start of a formula (`=`, `+`,
 * `-`, `@`, tab, carriage return) is prefixed with an apostrophe, so text a
 * user typed is shown, never evaluated. Numbers are written as numbers and are
 * not prefixed, so a negative amount stays a number.
 */

export type CsvCell = string | number | boolean | null | undefined;

const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

/** One field: empty for null and undefined, quoted only when it must be. */
export function csvField(value: CsvCell): string {
	if (value === null || value === undefined) {
		return "";
	}
	let text = String(value);
	if (typeof value === "string" && FORMULA_START.test(text)) {
		text = `'${text}`;
	}
	return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A header row and data rows as one CSV document, ending in CRLF. */
export function buildCsv(
	header: readonly string[],
	rows: ReadonlyArray<readonly CsvCell[]>,
): string {
	const lines = [header, ...rows].map((row) => row.map(csvField).join(","));
	return `${lines.join("\r\n")}\r\n`;
}
