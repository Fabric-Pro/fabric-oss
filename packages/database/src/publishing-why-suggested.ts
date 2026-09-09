// Pure, DB-free helper for the "Based on …" provenance line's meeting dates
// (Publishing Suite, Fizzy #1851).
//
// A recurring series produces one transcript per occurrence, all sharing one
// `meetingSubject`. Provenance dedupes by transcript id — correctly, they are
// distinct sources — so the line could legitimately read
// `Based on "Weekly sync" meeting · "Weekly sync" meeting`. The ids are what
// differ; a date is the cheapest thing a reader can tell them apart by.

/**
 * Month abbreviations, written out rather than taken from `Intl`.
 *
 * `Intl.DateTimeFormat("en-US", { month: "short" })` renders September as
 * "Sep"; "Sept" is the en-GB abbreviation. Reading it out of a locale we do not
 * otherwise use would make the label depend on which ICU version the runtime
 * shipped with — a string that changes under the product on a Node upgrade,
 * with no test that would notice. The web publishing module hardcodes English
 * anyway, so the table is the honest form of what is already true.
 */
const MONTH_ABBREVIATIONS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sept",
	"Oct",
	"Nov",
	"Dec",
] as const;

/**
 * The short date shown beside a cited meeting — `"Sept 9"`, or
 * `"Sept 9, 2025"` once the year stops being the current one.
 *
 * The year is omitted for the current year because it is the only case where
 * it carries no information: every date a reader sees on a live board is
 * this year's unless something says otherwise, and repeating it on every line
 * spends width on a constant. `currentYear` is passed in rather than read from
 * the clock so the function stays pure and its tests need no fake timers.
 *
 * Read in UTC, deliberately: the label is composed server-side and would
 * otherwise be stamped with whatever timezone the request happened to land in,
 * so two servers could disagree about which day a late-evening meeting fell on.
 * The residual cost is that a meeting held late on the 9th somewhere far west
 * of UTC reads as the 10th — the same trade every server-rendered date here
 * makes.
 *
 * Returns `undefined` for a transcript with no date (the column is nullable),
 * which callers render as a bare `"…" meeting` rather than an empty paren.
 */
export function formatMeetingDateLabel(
	date: Date | null | undefined,
	currentYear: number,
): string | undefined {
	if (!date || Number.isNaN(date.getTime())) {
		return undefined;
	}
	const month = MONTH_ABBREVIATIONS[date.getUTCMonth()];
	const day = date.getUTCDate();
	const year = date.getUTCFullYear();
	return year === currentYear
		? `${month} ${day}`
		: `${month} ${day}, ${year}`;
}
