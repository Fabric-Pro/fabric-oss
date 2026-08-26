/**
 * Shared formatter for the small `<time>` element rendered under each chat
 * message bubble.
 *
 * Returns a compact, human-friendly `label` suited to rendering BELOW a chat
 * bubble — short enough to read at a glance ("3m ago", "2h ago", "yesterday",
 * "Mar 4") and never wider than the bubble it sits under. Pair it with the
 * local-timezone `tooltip` as the `title` attribute so hovering reveals the
 * full date + time in the READER'S timezone.
 *
 *   { label: "just now",   iso: "2026-05-22T20:54:44.464Z", tooltip: "May 22, 2026, 4:54 PM GMT-4" }
 *   { label: "3m ago",     iso: "...", tooltip: "..." }
 *   { label: "yesterday",  iso: "...", tooltip: "..." }
 *   { label: "Mar 4",      iso: "...", tooltip: "..." }      // same calendar year
 *   { label: "Mar 4, 2025", iso: "...", tooltip: "..." }     // previous calendar year
 *
 * Returns `null` when the input is missing / unparseable — callers should
 * not render the `<time>` element in that case (a chip with no value is
 * worse than no chip).
 */
export interface FormattedMessageTimestamp {
	label: string;
	/**
	 * Machine-readable UTC timestamp for the `<time dateTime>` attribute.
	 * Per the HTML spec `dateTime` must be a valid global date-and-time
	 * string (zulu / UTC) — it is intentionally NOT localized. Never show
	 * this to the reader; use {@link tooltip} for that.
	 */
	iso: string;
	/**
	 * Human-readable absolute timestamp in the READER'S LOCAL timezone, for
	 * the hover `title`. Built with `toLocaleString` so a reader in any
	 * timezone sees their own wall-clock plus the zone name
	 * (e.g. "May 31, 2026, 2:34 PM GMT+3") instead of a UTC "…Z" string.
	 */
	tooltip: string;
}

/**
 * Accept-anything timestamp source. CopilotKit's runtime puts the wall-clock
 * on `createdAt`; our persistence schema uses `timestamp`. Both surface here
 * — callers don't need to pre-coerce.
 */
export interface TimestampSource {
	timestamp?: string | Date | null;
	createdAt?: string | Date | null;
}

function toDate(input: string | Date | null | undefined): Date | null {
	if (!input) {
		return null;
	}
	if (input instanceof Date) {
		return Number.isNaN(input.getTime()) ? null : input;
	}
	if (typeof input !== "string") {
		return null;
	}
	const t = Date.parse(input);
	return Number.isNaN(t) ? null : new Date(t);
}

/**
 * Reads the first defined timestamp from a message-shaped object. Looks
 * at `timestamp` first (our persisted shape) then `createdAt` (CopilotKit
 * runtime shape).
 */
function readMessageTimestamp(source: TimestampSource): Date | null {
	return toDate(source.timestamp) ?? toDate(source.createdAt);
}

/**
 * Absolute date + time rendered in the reader's LOCAL timezone, for the hover
 * `title`. `timeZoneName: "short"` makes the zone explicit so a distributed
 * team never has to guess whether a time is UTC or local — directly fixing
 * the "tooltip shows UTC" report. Falls back to the UTC ISO only if
 * `toLocaleString` throws on an exotic/unsupported runtime locale.
 */
function formatLocalTooltip(when: Date): string {
	try {
		return when.toLocaleString(undefined, {
			year: "numeric",
			month: "short",
			day: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		});
	} catch {
		return when.toISOString();
	}
}

/**
 * One-line entry point used by every chat surface. Returns the `label`, the
 * UTC `iso` string for `<time datetime>`, and the local-timezone `tooltip`
 * for the hover `title` — or `null` if there's no usable timestamp.
 *
 * Time math for the label is intentionally simple: no Intl.RelativeTimeFormat
 * dependency (smaller bundle, predictable across locales), no timezone
 * gymnastics (Date.parse handles ISO-with-Z fine). The "yesterday" cutoff is
 * "more than 18 hours ago AND yesterday in local time" so a 1 a.m. message
 * read at 4 a.m. doesn't flip from "3h ago" to "yesterday" in the same session.
 */
export function formatMessageTimestamp(
	source: TimestampSource,
	now: Date = new Date(),
): FormattedMessageTimestamp | null {
	const when = readMessageTimestamp(source);
	if (!when) {
		return null;
	}
	const iso = when.toISOString();
	const tooltip = formatLocalTooltip(when);
	// All branches share the same iso/tooltip — only the short `label` differs.
	const make = (label: string): FormattedMessageTimestamp => ({
		label,
		iso,
		tooltip,
	});

	const deltaMs = now.getTime() - when.getTime();
	const seconds = Math.round(deltaMs / 1000);

	if (seconds < 45) {
		return make("just now");
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return make(`${minutes}m ago`);
	}
	const hours = Math.round(minutes / 60);
	if (hours < 18) {
		return make(`${hours}h ago`);
	}

	// Same calendar day → still "Nh ago". Anything earlier than 18h yet
	// still today (e.g. 4 a.m. → 11 p.m.) is rare but fine here.
	const sameDay =
		when.getFullYear() === now.getFullYear() &&
		when.getMonth() === now.getMonth() &&
		when.getDate() === now.getDate();
	if (sameDay) {
		return make(`${hours}h ago`);
	}

	const yesterday = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate() - 1,
	);
	const sameAsYesterday =
		when.getFullYear() === yesterday.getFullYear() &&
		when.getMonth() === yesterday.getMonth() &&
		when.getDate() === yesterday.getDate();
	if (sameAsYesterday) {
		return make("yesterday");
	}

	try {
		const sameYear = when.getFullYear() === now.getFullYear();
		const label = when.toLocaleDateString(undefined, {
			month: "short",
			day: "numeric",
			...(sameYear ? {} : { year: "numeric" }),
		});
		return make(label);
	} catch {
		return make(iso.slice(0, 10));
	}
}
