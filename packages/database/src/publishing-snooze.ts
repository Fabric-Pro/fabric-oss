/**
 * Snooze preset vocabulary for Publishing Suite 1D (Fizzy #2265).
 *
 * FR6 allows exactly three durations and no free-form date. That rule is
 * enforced HERE, server-side: the API accepts a preset name and never a
 * timestamp, so a caller bypassing the UI cannot invent a duration. A rule the
 * client merely declines to offer is not a rule.
 */
export const PUBLISHING_SNOOZE_PRESETS = [
	"ONE_WEEK",
	"ONE_MONTH",
	"THREE_MONTHS",
] as const;

export type PublishingSnoozePreset = (typeof PUBLISHING_SNOOZE_PRESETS)[number];

/**
 * Resolve a preset to its absolute wake time. Pure, UTC, and non-mutating —
 * `now` is a parameter rather than an internal `new Date()` so the result is
 * testable without faking the clock.
 *
 * Month presets use CALENDAR months (10 March -> 10 April), clamping when the
 * target month is shorter: 31 January + 1 month is 28/29 February, not 3 March.
 * Naive `setUTCMonth` arithmetic produces the overflow, so the day-of-month is
 * parked at 1 before the month moves and restored afterwards.
 */
export function resolvePublishingSnoozeUntil(
	preset: PublishingSnoozePreset,
	now: Date,
): Date {
	const target = new Date(now.getTime());
	if (preset === "ONE_WEEK") {
		target.setUTCDate(target.getUTCDate() + 7);
		return target;
	}
	const months = preset === "ONE_MONTH" ? 1 : 3;
	const dayOfMonth = target.getUTCDate();
	target.setUTCDate(1);
	target.setUTCMonth(target.getUTCMonth() + months);
	const lastDayOfTargetMonth = new Date(
		Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
	).getUTCDate();
	target.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
	return target;
}
