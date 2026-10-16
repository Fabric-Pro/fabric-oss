/**
 * Plain-language reading of a cron expression, for the draft a person is asked
 * to confirm before a schedule goes live. How often a cron fires is
 * `cron-interval`'s to say, and whether that is allowed is
 * `agentic-publish-validation`'s.
 *
 * Handles the five-field expressions people actually write — every N minutes,
 * hourly, daily, on some weekdays, on a day of the month. Anything else is
 * quoted as written rather than described wrongly.
 */

const WEEKDAYS = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/** Values a field selects, or null for a syntax this reader does not handle. */
function expandField(field: string, min: number, max: number): number[] | null {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
		if (!match) {
			return null;
		}
		const [, range, stepText] = match;
		const step = stepText ? Number(stepText) : 1;
		if (step < 1) {
			return null;
		}
		let from = min;
		let to = max;
		if (range !== "*") {
			const [start, end] = range.split("-").map(Number);
			from = start;
			to = end ?? (stepText ? max : start);
		}
		if (from < min || to > max || from > to) {
			return null;
		}
		for (let value = from; value <= to; value += step) {
			values.add(value);
		}
	}
	return [...values].sort((a, b) => a - b);
}

function clock(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function joinList(items: string[]): string {
	if (items.length <= 1) {
		return items.join("");
	}
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function weekdaysPhrase(days: number[]): string | null {
	const normalized = [...new Set(days.map((day) => day % 7))].sort(
		(a, b) => a - b,
	);
	if (normalized.length === 7) {
		return "day";
	}
	if (normalized.join() === "1,2,3,4,5") {
		return "weekday";
	}
	if (normalized.join() === "0,6") {
		return "weekend day";
	}
	return normalized.length > 0
		? joinList(normalized.map((day) => WEEKDAYS[day]))
		: null;
}

/**
 * "every Monday at 09:00 (Europe/Berlin)". The timezone is the one the cron is
 * read in, so it is always part of the sentence.
 */
export function describeCronSchedule(cron: string, timezone: string): string {
	const quoted = `cron "${cron.trim()}" (${timezone})`;
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) {
		return quoted;
	}
	const [minuteField, hourField, domField, monthField, dowField] = fields;
	const minutes = expandField(minuteField, 0, 59);
	const hours = expandField(hourField, 0, 23);
	const doms = expandField(domField, 1, 31);
	const months = expandField(monthField, 1, 12);
	const days = expandField(dowField, 0, 7);
	if (!minutes || !hours || !doms || !months || !days) {
		return quoted;
	}

	const everyMonth = monthField === "*";
	const everyDom = domField === "*";
	const everyDow = dowField === "*";
	const where = `(${timezone})`;

	if (!everyMonth) {
		return quoted;
	}

	if (hourField === "*" && everyDom && everyDow) {
		const step = /^\*\/(\d+)$/.exec(minuteField);
		if (minuteField === "*") {
			return `every minute ${where}`;
		}
		if (step) {
			return `every ${step[1]} minutes ${where}`;
		}
		if (minutes.length === 1) {
			return `every hour at minute ${minutes[0]} ${where}`;
		}
		return quoted;
	}

	if (minutes.length !== 1 || hours.length === 0) {
		return quoted;
	}
	const times = joinList(hours.map((hour) => clock(hour, minutes[0])));

	if (everyDom && everyDow) {
		return `every day at ${times} ${where}`;
	}
	if (everyDom && !everyDow) {
		const phrase = weekdaysPhrase(days);
		return phrase ? `every ${phrase} at ${times} ${where}` : quoted;
	}
	if (!everyDom && everyDow) {
		const ordinals = doms.map((dom) => String(dom));
		return `on day ${joinList(ordinals)} of every month at ${times} ${where}`;
	}
	return quoted;
}
