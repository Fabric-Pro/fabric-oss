import { formatDurationMinutes } from "@repo/utils/time-tracking";

/** The common durations a duration field offers, in minutes. */
const DURATION_SHORTCUT_MINUTES = [
	15, 30, 45, 60, 90, 120, 180, 240, 480,
] as const;

/**
 * The common durations as a native list for a duration field: point the
 * input's `list` at `id`. Typing stays free; the browser offers the list from
 * the keyboard (arrow down) and on focus, with nothing shown on the page.
 * Each value is written the way `parseDurationInput` reads it back.
 */
export function DurationShortcuts({ id }: { id: string }) {
	return (
		<datalist id={id}>
			{DURATION_SHORTCUT_MINUTES.map((minutes) => (
				<option key={minutes} value={formatDurationMinutes(minutes)} />
			))}
		</datalist>
	);
}
