import { TZDate } from "@date-fns/tz";
import {
	addDays,
	addMonths,
	getDaysInMonth,
	setDate,
	setHours,
	setMilliseconds,
	setMinutes,
	setSeconds,
} from "date-fns";
import { z } from "zod";

/**
 * Report instance scheduling: validation, timezone-aware normalization, and
 * next-run computation. Pure functions — no DB access. Used by the API
 * (instance create/update) and by Temporal activities (dispatch/reconcile).
 * NEVER imported into Temporal workflow code (it is not deterministic-safe;
 * it reads timezone data and is meant to run inside activities/handlers).
 */

const FREQUENCIES = [
	"daily",
	"weekly",
	"biweekly",
	"monthly",
	"quarterly",
] as const;

/**
 * True iff `tz` is a runtime-resolvable IANA timezone. An invalid zone (e.g. via
 * API misuse) would otherwise throw RangeError deep inside `new TZDate(..., tz)`:
 * at instance create/update it surfaces as a 500, and inside the dispatch/reconcile
 * activity it becomes a poison-pill (a deterministic throw Temporal retries forever
 * and never recovers from). Rejecting at the schema boundary keeps it out of the DB.
 */
function isValidTimeZone(tz: string): boolean {
	try {
		// Constructing a formatter throws RangeError for unknown time zones.
		new Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Reusable refined-string field so both input and stored schemas validate the zone.
 *  Kept as a field (not an object-level .refine) because reportScheduleStoredSchema
 *  uses .extend(), which only exists on ZodObject — not on the ZodEffects a top-level
 *  .refine() would produce. */
const timezoneSchema = z
	.string()
	.min(1)
	.refine(isValidTimeZone, { message: "Invalid IANA timezone" });

/** The shape a caller (UI/API) may submit. Day/time fields are optional with defaults. */
export const reportScheduleInputSchema = z.object({
	frequency: z.enum(FREQUENCIES),
	dayOfWeek: z.number().int().min(0).max(6).optional(),
	dayOfMonth: z.number().int().min(1).max(31).optional(),
	hour: z.number().int().min(0).max(23).default(9),
	minute: z.number().int().min(0).max(59).default(0),
	timezone: timezoneSchema.default("UTC"),
});

/** The fully-normalized shape stored on `TemplateInstance.schedule` (adds the frozen `anchorAt`).
 *  Enforces that the per-frequency day field is present — a stored weekly/biweekly config MUST
 *  carry dayOfWeek and a monthly/quarterly config MUST carry dayOfMonth. Without this, an
 *  incomplete stored row would parse as "valid" and make computeNextRunAt either silently drift
 *  (weekly: undefined dayOfWeek) or throw RangeError (monthly: undefined dayOfMonth). Rejecting
 *  here makes parseStoredReportSchedule return null, so find-due skips the row and reconcile
 *  re-normalizes it (which fills the field). */
export const reportScheduleStoredSchema = reportScheduleInputSchema
	.extend({
		hour: z.number().int().min(0).max(23),
		minute: z.number().int().min(0).max(59),
		timezone: timezoneSchema,
		anchorAt: z.string().datetime(),
	})
	.refine(
		(s) => {
			if (s.frequency === "weekly" || s.frequency === "biweekly") {
				return s.dayOfWeek !== undefined;
			}
			if (s.frequency === "monthly" || s.frequency === "quarterly") {
				return s.dayOfMonth !== undefined;
			}
			return true;
		},
		{
			message:
				"weekly/biweekly require dayOfWeek; monthly/quarterly require dayOfMonth",
		},
	);

export type ReportScheduleConfig = z.infer<typeof reportScheduleStoredSchema>;

/** Set wall-clock hh:mm:00.000 on a TZDate (date-fns operates in the date's timezone). */
function atTime(d: TZDate, hour: number, minute: number): TZDate {
	return setMilliseconds(
		setSeconds(setMinutes(setHours(d, hour), minute), 0),
		0,
	) as TZDate;
}

/** Clamp dayOfMonth to the month length of `d`, then set it (e.g. 31 → Feb 28/29). */
function atClampedDay(d: TZDate, dayOfMonth: number): TZDate {
	return setDate(d, Math.min(dayOfMonth, getDaysInMonth(d))) as TZDate;
}

/** First daily slot at hh:mm strictly after fromTz. */
function nextDaily(fromTz: TZDate, hour: number, minute: number): TZDate {
	let c = atTime(fromTz, hour, minute);
	if (c.getTime() <= fromTz.getTime()) {
		c = atTime(addDays(c, 1) as TZDate, hour, minute);
	}
	return c;
}

/** First date whose weekday === dayOfWeek, at hh:mm, strictly after fromTz (field-driven). */
function nextOnWeekday(
	fromTz: TZDate,
	dayOfWeek: number,
	hour: number,
	minute: number,
): TZDate {
	let c = atTime(fromTz, hour, minute);
	// At most 8 iterations to find the next matching weekday strictly after fromTz.
	for (let i = 0; i < 8; i++) {
		if (c.getDay() === dayOfWeek && c.getTime() > fromTz.getTime()) {
			return c;
		}
		c = atTime(addDays(c, 1) as TZDate, hour, minute);
	}
	// A valid 0-6 dayOfWeek always matches within 8 days; reaching here means an invalid
	// (e.g. undefined) dayOfWeek slipped through. Fail loudly rather than silently drift.
	throw new Error(`nextOnWeekday: no match for dayOfWeek=${dayOfWeek}`);
}

/** First date on dayOfMonth (month-end clamped), at hh:mm, strictly after fromTz (field-driven). */
function nextOnDayOfMonth(
	fromTz: TZDate,
	dayOfMonth: number,
	hour: number,
	minute: number,
): TZDate {
	let c = atTime(atClampedDay(fromTz, dayOfMonth), hour, minute);
	if (c.getTime() <= fromTz.getTime()) {
		c = atTime(
			atClampedDay(addMonths(c, 1) as TZDate, dayOfMonth),
			hour,
			minute,
		);
	}
	return c;
}

/**
 * Next occurrence strictly after `from`, computed from a NORMALIZED config.
 * weekly/monthly are field-driven (dayOfWeek/dayOfMonth); biweekly/quarterly
 * stride from `anchorAt` (whose weekday/day already equals the field, keeping
 * the stride phase-aligned). DST-correct via TZDate; advances skip missed
 * occurrences (no catch-up storm).
 */
export function computeNextRunAt(
	schedule: ReportScheduleConfig,
	from: Date,
): Date {
	const tz = schedule.timezone;
	const fromTz = new TZDate(from.getTime(), tz);
	const { hour, minute } = schedule;

	if (schedule.frequency === "daily") {
		return new Date(nextDaily(fromTz, hour, minute).getTime());
	}
	if (schedule.frequency === "weekly") {
		return new Date(
			nextOnWeekday(
				fromTz,
				schedule.dayOfWeek as number,
				hour,
				minute,
			).getTime(),
		);
	}
	if (schedule.frequency === "monthly") {
		return new Date(
			nextOnDayOfMonth(
				fromTz,
				schedule.dayOfMonth as number,
				hour,
				minute,
			).getTime(),
		);
	}

	// biweekly / quarterly — anchored (anchorAt already lands on the correct weekday/day).
	const anchorRaw = new TZDate(new Date(schedule.anchorAt).getTime(), tz);
	if (schedule.frequency === "biweekly") {
		let c = atTime(anchorRaw, hour, minute);
		if (c.getTime() <= fromTz.getTime()) {
			const dayDiff = Math.floor(
				(fromTz.getTime() - c.getTime()) / 86_400_000,
			);
			const jumps = Math.max(0, Math.floor(dayDiff / 14));
			c = atTime(addDays(c, jumps * 14) as TZDate, hour, minute);
			while (c.getTime() <= fromTz.getTime()) {
				c = atTime(addDays(c, 14) as TZDate, hour, minute);
			}
		}
		// if anchor is still in the future, return it (the first occurrence)
		return new Date(c.getTime());
	}

	// quarterly
	const dom = schedule.dayOfMonth as number;
	let c = atTime(atClampedDay(anchorRaw, dom), hour, minute);
	if (c.getTime() <= fromTz.getTime()) {
		const monthDiff =
			(fromTz.getFullYear() - c.getFullYear()) * 12 +
			(fromTz.getMonth() - c.getMonth());
		const jumps = Math.max(0, Math.floor(monthDiff / 3));
		c = atTime(
			atClampedDay(addMonths(c, jumps * 3) as TZDate, dom),
			hour,
			minute,
		);
		while (c.getTime() <= fromTz.getTime()) {
			c = atTime(
				atClampedDay(addMonths(c, 3) as TZDate, dom),
				hour,
				minute,
			);
		}
	}
	return new Date(c.getTime());
}

/**
 * Validate raw input, apply defaults, resolve omitted day fields, then freeze
 * `anchorAt` = the first occurrence strictly after `from` RESPECTING the
 * (explicit or resolved) dayOfWeek/dayOfMonth. Returns null for unusable input.
 */
export function normalizeReportSchedule(
	raw: unknown,
	from: Date,
): ReportScheduleConfig | null {
	const parsed = reportScheduleInputSchema.safeParse(raw);
	if (!parsed.success) {
		return null;
	}
	const input = parsed.data;
	const tz = input.timezone;
	const fromTz = new TZDate(from.getTime(), tz);

	const isWeekly =
		input.frequency === "weekly" || input.frequency === "biweekly";
	const isMonthly =
		input.frequency === "monthly" || input.frequency === "quarterly";
	// Resolve omitted day fields from `from`; explicit values are honored.
	const dayOfWeek = isWeekly
		? (input.dayOfWeek ?? fromTz.getDay())
		: undefined;
	const dayOfMonth = isMonthly
		? (input.dayOfMonth ?? fromTz.getDate())
		: undefined;

	// Compute the first occurrence DIRECTLY from the resolved fields (do NOT route
	// through computeNextRunAt with a provisional anchor — that would ignore an
	// explicit dayOfWeek/dayOfMonth).
	let first: TZDate;
	if (input.frequency === "daily") {
		first = nextDaily(fromTz, input.hour, input.minute);
	} else if (isWeekly) {
		first = nextOnWeekday(
			fromTz,
			dayOfWeek as number,
			input.hour,
			input.minute,
		);
	} else {
		first = nextOnDayOfMonth(
			fromTz,
			dayOfMonth as number,
			input.hour,
			input.minute,
		);
	}

	return {
		frequency: input.frequency,
		dayOfWeek,
		dayOfMonth,
		hour: input.hour,
		minute: input.minute,
		timezone: tz,
		anchorAt: new Date(first.getTime()).toISOString(),
	};
}

/** Validate a stored (already-normalized) schedule JSON. Returns null if it isn't one. */
export function parseStoredReportSchedule(
	raw: unknown,
): ReportScheduleConfig | null {
	const parsed = reportScheduleStoredSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}
