/**
 * Time tracking rules shared by the API (validation, warnings) and the web app
 * (input parsing, display, week navigation).
 *
 * Kept free of imports so it is safe in the browser bundle and needs no
 * database client: activities are plain string literals that match the
 * `TimeActivity` enum in the Prisma schema.
 *
 * Work dates are `YYYY-MM-DD` strings throughout. They are the day the person
 * chose, not an instant, so nothing here converts them through a time zone.
 */

/** The longest single entry, in minutes: one whole day. */
export const MAX_TIME_ENTRY_MINUTES = 1440;

/**
 * Confirmed minutes on one work date above which a save asks for
 * confirmation. Exactly this many does not warn.
 */
export const DAILY_TIME_LIMIT_MINUTES = 960;

/** The widest work-date range one list request may cover, inclusive. */
export const MAX_TIME_LIST_SPAN_DAYS = 31;

/** The widest work-date range one report may cover, inclusive: a leap year. */
export const MAX_TIME_REPORT_SPAN_DAYS = 366;

/** Matches the `ProjectBillingModel` enum in the Prisma schema. */
export const PROJECT_BILLING_MODEL_VALUES = [
	"FIXED_BID",
	"TIME_AND_MATERIALS",
] as const;

export type ProjectBillingModel = (typeof PROJECT_BILLING_MODEL_VALUES)[number];

export const PROJECT_BILLING_MODEL_LABELS: Readonly<
	Record<ProjectBillingModel, string>
> = {
	FIXED_BID: "Fixed bid",
	TIME_AND_MATERIALS: "Time and materials",
};

export const TIME_ACTIVITY_VALUES = [
	"PLANNING_REQUIREMENTS",
	"DESIGN_UX",
	"DEVELOPMENT",
	"CODE_REVIEW",
	"TESTING",
	"MEETINGS_COLLABORATION",
	"OTHER",
] as const;

export type TimeActivity = (typeof TIME_ACTIVITY_VALUES)[number];

export const TIME_ACTIVITY_LABELS: Readonly<Record<TimeActivity, string>> = {
	PLANNING_REQUIREMENTS: "Planning and requirements",
	DESIGN_UX: "Design / UX",
	DEVELOPMENT: "Development",
	CODE_REVIEW: "Code review",
	TESTING: "Testing",
	MEETINGS_COLLABORATION: "Meetings and collaboration",
	OTHER: "Other",
};

/**
 * The person a report names for an entry whose author's account is deleted
 * and whose saved name is missing.
 */
export const DELETED_USER_NAME = "Deleted user";

/**
 * Who a report names for an entry: the author's current name while the
 * account exists, else the name saved with the entry.
 */
export function timeEntryAuthorName(author: {
	currentName: string | null;
	savedName: string | null;
}): string {
	return author.currentName ?? author.savedName ?? DELETED_USER_NAME;
}

/** Activities in display order, with their English labels. */
export const TIME_ACTIVITIES: ReadonlyArray<{
	value: TimeActivity;
	label: string;
}> = TIME_ACTIVITY_VALUES.map((value) => ({
	value,
	label: TIME_ACTIVITY_LABELS[value],
}));

export const TIME_WARNING_CODES = [
	"LIKELY_DUPLICATE",
	"OVER_DAILY_LIMIT",
] as const;

export type TimeWarningCode = (typeof TIME_WARNING_CODES)[number];

/**
 * Whether the floating timer shows: always, closed until the next start
 * (which shows it again), or never. Matches the `TimeTimerWidget` enum.
 */
export const TIME_TIMER_WIDGET_VALUES = [
	"SHOWN",
	"HIDDEN_UNTIL_START",
	"OFF",
] as const;

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/** Bare whole numbers up to this many are read as hours; larger as minutes. */
const BARE_HOURS_MAX = 12;

const HOURS_AND_MINUTES = /^(\d+(?:[.,]\d+)?)\s*h(?:\s*(\d+)\s*m?)?$/;
const MINUTES_ONLY = /^(\d+)\s*m$/;
const CLOCK = /^(\d+):(\d{2})$/;
const BARE_DECIMAL = /^\d*[.,]\d+$/;
const BARE_INTEGER = /^\d+$/;

function readDecimal(text: string): number {
	return Number(text.replace(",", "."));
}

function positiveWholeMinutes(minutes: number): number | null {
	const rounded = Math.round(minutes);
	return Number.isFinite(rounded) && rounded > 0 ? rounded : null;
}

/**
 * Read a typed duration as whole minutes, or `null` when it is not a positive
 * duration this function understands.
 *
 * Accepted forms (case and surrounding spaces ignored):
 * - with units: `2h`, `1.5h`, `1,5h`, `1h 30m`, `1h30`, `1h30m`, `90m`;
 * - a clock: `1:30` (hours and minutes);
 * - a bare number with a decimal separator: hours (`1.5`, `1,5`, `.5`);
 * - a bare whole number: hours when it is 12 or less (`8` is 8h), minutes
 *   when it is larger (`45` is 45m). Nobody logs 45 hours as one entry, and
 *   nobody means 8 minutes by typing `8`.
 *
 * Minutes after hours (`1h 75m`, `1:75`) must be under 60 and may only follow
 * whole hours (`1.5h 30m` is refused as ambiguous). Fractions of a
 * minute are rounded. The maximum entry length is not checked here; see
 * {@link isValidDurationMinutes}.
 */
export function parseDurationInput(text: string): number | null {
	const value = text.trim().toLowerCase();
	if (value === "") {
		return null;
	}

	const hoursAndMinutes = HOURS_AND_MINUTES.exec(value);
	if (hoursAndMinutes) {
		const hasMinutes = hoursAndMinutes[2] !== undefined;
		const minutes = hasMinutes ? Number(hoursAndMinutes[2]) : 0;
		if (minutes >= 60 || (hasMinutes && /[.,]/.test(hoursAndMinutes[1]))) {
			return null;
		}
		return positiveWholeMinutes(
			readDecimal(hoursAndMinutes[1]) * 60 + minutes,
		);
	}

	const minutesOnly = MINUTES_ONLY.exec(value);
	if (minutesOnly) {
		return positiveWholeMinutes(Number(minutesOnly[1]));
	}

	const clock = CLOCK.exec(value);
	if (clock) {
		const minutes = Number(clock[2]);
		if (minutes >= 60) {
			return null;
		}
		return positiveWholeMinutes(Number(clock[1]) * 60 + minutes);
	}

	if (BARE_DECIMAL.test(value)) {
		return positiveWholeMinutes(readDecimal(value) * 60);
	}

	if (BARE_INTEGER.test(value)) {
		const number = Number(value);
		return positiveWholeMinutes(
			number <= BARE_HOURS_MAX ? number * 60 : number,
		);
	}

	return null;
}

/** `90` → `1h 30m`, `120` → `2h`, `45` → `45m`. */
export function formatDurationMinutes(minutes: number): string {
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	if (hours > 0 && rest > 0) {
		return `${hours}h ${rest}m`;
	}
	if (hours > 0) {
		return `${hours}h`;
	}
	return `${rest}m`;
}

/** `90` → `1.50`: decimal hours to two places, as invoices and exports use. */
export function formatDecimalHours(minutes: number): string {
	return (minutes / 60).toFixed(2);
}

/** A storable entry length: a whole number of minutes, 1 to one day. */
export function isValidDurationMinutes(minutes: number): boolean {
	return (
		Number.isInteger(minutes) &&
		minutes > 0 &&
		minutes <= MAX_TIME_ENTRY_MINUTES
	);
}

/**
 * Minutes actually elapsed between two instants, rounded to the nearest
 * minute, or `null` when stop is not after start.
 *
 * Computed from the instants rather than wall-clock times, so an entry that
 * spans a daylight-saving change or midnight counts the time that really
 * passed.
 */
export function elapsedMinutes(startAt: Date, stopAt: Date): number | null {
	const elapsedMs = stopAt.getTime() - startAt.getTime();
	if (!(elapsedMs > 0)) {
		return null;
	}
	return Math.round(elapsedMs / 60_000);
}

/** Whether the runtime knows this IANA time zone id (`Europe/Berlin`, `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) {
		return false;
	}
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface TimePolicySettings {
	timeRequireStartStop: boolean;
	/** `null` = inherit (project) or billable (organization). */
	timeDefaultBillable: boolean | null;
}

export interface EffectiveTimePolicy {
	startStopRequired: boolean;
	defaultBillable: boolean;
}

/**
 * The rules a new entry on a project is saved under. The organization's
 * start/stop requirement applies to every project and a project can only add
 * to it. The billable default is the project's own, else the organization's,
 * else billable.
 */
export function resolveEffectiveTimePolicy(settings: {
	org: TimePolicySettings;
	project: TimePolicySettings;
}): EffectiveTimePolicy {
	return {
		startStopRequired:
			settings.org.timeRequireStartStop ||
			settings.project.timeRequireStartStop,
		defaultBillable:
			settings.project.timeDefaultBillable ??
			settings.org.timeDefaultBillable ??
			true,
	};
}

// ---------------------------------------------------------------------------
// Work dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

function dateToUtcMs(date: string): number | null {
	const match = ISO_DATE.exec(date);
	if (!match) {
		return null;
	}
	const ms = Date.UTC(
		Number(match[1]),
		Number(match[2]) - 1,
		Number(match[3]),
	);
	return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

function utcMsToDate(ms: number): string {
	return new Date(ms).toISOString().slice(0, 10);
}

/** A real calendar date written as `YYYY-MM-DD` (rejects `2026-02-30`). */
export function isIsoDate(date: string): boolean {
	return dateToUtcMs(date) !== null;
}

function requireDateMs(date: string): number {
	const ms = dateToUtcMs(date);
	if (ms === null) {
		throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
	}
	return ms;
}

export function addDays(date: string, days: number): string {
	return utcMsToDate(requireDateMs(date) + days * DAY_MS);
}

/** Days from `from` to `to`, counting both ends; 0 when `to` is before `from`. */
export function inclusiveDaySpan(from: string, to: string): number {
	const span = (requireDateMs(to) - requireDateMs(from)) / DAY_MS + 1;
	return Math.max(0, span);
}

/** The Monday-to-Sunday week that contains `date`. */
export function weekRange(date: string): { from: string; to: string } {
	const ms = requireDateMs(date);
	const dayOfWeek = new Date(ms).getUTCDay();
	const daysSinceMonday = (dayOfWeek + 6) % 7;
	const from = utcMsToDate(ms - daysSinceMonday * DAY_MS);
	return { from, to: addDays(from, 6) };
}

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

/** The fields warning detection compares. */
export interface TimeEntryFacts {
	projectId: string;
	workDate: string;
	durationMinutes: number;
	startAt: Date | null;
	stopAt: Date | null;
	activity: TimeActivity;
	storyId: string | null;
	description: string | null;
}

export interface ExistingTimeEntryFacts extends TimeEntryFacts {
	id: string;
}

export type TimeEntryWarning =
	| { code: "LIKELY_DUPLICATE"; entryIds: string[] }
	| {
			code: "OVER_DAILY_LIMIT";
			totalMinutes: number;
			limitMinutes: number;
	  };

function normalizeDescription(description: string | null): string {
	return (description ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function overlaps(a: TimeEntryFacts, b: TimeEntryFacts): boolean {
	if (!a.startAt || !a.stopAt || !b.startAt || !b.stopAt) {
		return false;
	}
	return (
		a.startAt.getTime() < b.stopAt.getTime() &&
		b.startAt.getTime() < a.stopAt.getTime()
	);
}

/**
 * Whether `other` looks like the same work as `proposed`. Timed entries whose
 * times overlap always do, on any project and any work date: one person
 * cannot log the same minutes twice. Otherwise both must be on the same
 * project and work date, and either on the same work item for the same
 * duration, or have the same duration, activity and description. Two entries
 * with no description count as having the same one.
 */
export function isLikelyDuplicate(
	proposed: TimeEntryFacts,
	other: TimeEntryFacts,
): boolean {
	if (overlaps(proposed, other)) {
		return true;
	}
	if (
		proposed.projectId !== other.projectId ||
		proposed.workDate !== other.workDate
	) {
		return false;
	}
	const sameDuration = proposed.durationMinutes === other.durationMinutes;
	if (
		sameDuration &&
		proposed.storyId !== null &&
		proposed.storyId === other.storyId
	) {
		return true;
	}
	return (
		sameDuration &&
		proposed.activity === other.activity &&
		normalizeDescription(proposed.description) ===
			normalizeDescription(other.description)
	);
}

/**
 * The warnings a save must be confirmed past.
 *
 * `existingEntries` are the author's confirmed entries across every project of
 * the organization: those on the proposed work date, plus any timed entry that
 * overlaps the proposed span on another work date. Only the ones on the
 * proposed work date count toward the daily total. The entry being edited,
 * when given, is left out of both checks so it is neither its own duplicate
 * nor counted twice toward the daily total.
 */
export function detectTimeEntryWarnings(params: {
	proposed: TimeEntryFacts;
	existingEntries: readonly ExistingTimeEntryFacts[];
	editingEntryId?: string;
}): TimeEntryWarning[] {
	const others = params.existingEntries.filter(
		(entry) => entry.id !== params.editingEntryId,
	);
	const warnings: TimeEntryWarning[] = [];

	const duplicateIds = others
		.filter((entry) => isLikelyDuplicate(params.proposed, entry))
		.map((entry) => entry.id);
	if (duplicateIds.length > 0) {
		warnings.push({ code: "LIKELY_DUPLICATE", entryIds: duplicateIds });
	}

	const totalMinutes = others
		.filter((entry) => entry.workDate === params.proposed.workDate)
		.reduce(
			(sum, entry) => sum + entry.durationMinutes,
			params.proposed.durationMinutes,
		);
	if (totalMinutes > DAILY_TIME_LIMIT_MINUTES) {
		warnings.push({
			code: "OVER_DAILY_LIMIT",
			totalMinutes,
			limitMinutes: DAILY_TIME_LIMIT_MINUTES,
		});
	}

	return warnings;
}
