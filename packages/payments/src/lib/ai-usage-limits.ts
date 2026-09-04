/**
 * AI usage-limits — full lib surface.
 *
 * Counter storage building blocks:
 * - {@link windowStartFor} — pure timezone-aware calendar boundary calc.
 * - {@link readCounter} — Postgres `findUnique` on the
 *   `(limitId, windowStart)` unique index.
 * - {@link incrementCounter} — Postgres atomic `upsert` with Prisma's
 *   `increment` operator.
 * - {@link loadApplicableLimits} — single Prisma `findMany` resolving the
 *   active limits matching a call's `(tenant, projectId, providerConfigId,
 *   model, taskType)` scope, with each row's `currentWindowStart`
 *   precomputed for the call.
 * - {@link getTenantTimezone} — `(orgId | userId) → IANA TZ name | "UTC"`.
 *
 * Chokepoint surface (called from `packages/ai/lib/`):
 * - {@link AiUsageLimitExceededError} — structured error thrown by the
 *   pre-call gate; carries the rich payload so the client can render a
 *   destructive toast with a "Manage limits" deep link.
 * - {@link assertWithinAiUsageLimits} — pre-call gate. Short-circuits when
 *   no limits exist for the tenant; throws on the first HARD limit that
 *   would be exceeded.
 * - {@link recordAiUsageAndCheckOverage} — post-call accounting.
 *   Increments the matching counters, computes pre/post percentages, and
 *   fires `fanOut.aiUsageThreshold(..)` for each 80% / 100% line crossed.
 *   Best-effort — failures are logged and swallowed.
 *
 * Telemetry — every chokepoint event emits a structured log line via
 * `@repo/logs`. The pre-check pass log is gated on `DEBUG_AI_LIMITS=1` so
 * the hot path stays quiet by default.
 *
 * Stable `event` discriminator strings (grep tags for SRE):
 *   aiUsageLimits.preCheck.pass        debug — per-call summary (gated)
 *   aiUsageLimits.preCheck.softWarn    warn  — limit at >=80% (block
 *                                              bypassed or SOFT mode)
 *   aiUsageLimits.preCheck.block       error — HARD limit triggered
 *   aiUsageLimits.thresholdCrossed     info  — 80% / 100% crossed
 *   aiUsageLimits.fanOutFailed         warn  — notification fan-out caught
 *   aiUsageLimits.recordFailed         error — defence-in-depth top-level
 *
 * BigInt note: `JSON.stringify` cannot serialize `bigint` directly — every
 * BigInt field below is coerced via `.toString` at the log-call site.
 */

// `fanOut` is dynamically imported at the threshold call site below to
// avoid pulling `@repo/api/modules/notifications/lib/payloads.ts` (which
// evaluates `NotificationType.STORY_MENTION` at module load) into every
// caller of `@repo/payments`. Without this deferral, any consumer test
// with an incomplete `vi.mock("@repo/database")` crashes on import.
import {
	type AiTaskType,
	type AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
	db,
	type Prisma,
	setAiUsageRecorder,
} from "@repo/database";
import { logger } from "@repo/logs";

// ---------------------------------------------------------------------------
// AI usage-threshold notifier registry
// ---------------------------------------------------------------------------

/**
 * Shape of the notification fan-out handler — mirrors the signature of
 * `fanOut.aiUsageThreshold` in `@repo/api/lib/notification-service`.
 * Defined here (not imported) so this package stays free of an `@repo/api`
 * runtime dep, which would form a workspace cycle.
 */
export interface AiUsageThresholdNotifierInput {
	limitId: string;
	organizationId: string | null;
	userId: string | null;
	createdById: string;
	windowStartIso: string;
	threshold: 80 | 100;
	dimension: AiUsageLimitDimension;
	window: AiUsageLimitWindow;
	enforcement: AiUsageLimitEnforcement;
	used: bigint;
	max: bigint;
	limitName: string | null;
}

export type AiUsageThresholdNotifier = (
	input: AiUsageThresholdNotifierInput,
) => Promise<void>;

let aiUsageThresholdNotifier: AiUsageThresholdNotifier | null = null;

/**
 * Register the notification handler that {@link recordAiUsageAndCheckOverage}
 * invokes when an 80%/100% threshold is crossed. The handler must be wired up
 * at app boot from a layer that has `@repo/api/lib/notification-service`
 * available — typically `apps/web` startup or the oRPC bootstrap, depending
 * on the deployment target. If no handler is registered, threshold events are
 * still emitted to the structured log; only the email/inbox dispatch is
 * suppressed. This keeps `@repo/payments` free of a runtime dep on
 * `@repo/api` (which would form a workspace cycle).
 */
export function setAiUsageThresholdNotifier(
	notifier: AiUsageThresholdNotifier | null,
): void {
	aiUsageThresholdNotifier = notifier;
}

// Re-export the Prisma enums so downstream callers in @repo/payments,
// @repo/ai, and the oRPC layer don't need to deep-import @repo/database
// for trivial type narrowing. Callers read these straight off
// `@repo/payments`.
export {
	type AiTaskType,
	AiUsageLimitDimension,
	AiUsageLimitEnforcement,
	AiUsageLimitWindow,
} from "@repo/database";

// Public types

/**
 * The minimal shape of an `AiUsageLimit` row needed to evaluate a call.
 * Mirrors the explicit `select` used by {@link loadApplicableLimits} —
 * keep these in sync.
 */
export interface ApplicableAiUsageLimit {
	id: string;
	organizationId: string | null;
	userId: string | null;
	/**
	 * Project scope — NULL = workspace-global (applies to every AI call
	 * in the tenant); non-NULL = applies only to AI calls scoped to this
	 * project. The chokepoint enforces both global and project-scoped
	 * limits when a call carries a `projectId`; only global when not.
	 */
	projectId: string | null;
	name: string | null;
	providerConfigId: string | null;
	modelCanonicalName: string | null;
	taskType: AiTaskType | null;
	dimension: AiUsageLimitDimension;
	window: AiUsageLimitWindow;
	maxValue: bigint;
	enforcement: AiUsageLimitEnforcement;
	/**
	 * Percent (1-99) at which the in-app warning banner appears.
	 * Surface only — does not affect block / fan-out behaviour.
	 */
	bannerThresholdPercent: number;
	createdById: string;
	/**
	 * The calendar boundary (in the tenant's timezone, expressed as UTC)
	 * for the *currently active* window of this limit. Precomputed by
	 * {@link loadApplicableLimits} so callers never need to recompute it
	 * per limit — they all share the single `getTenantTimezone` lookup.
	 */
	currentWindowStart: Date;
}

/** Tenant scope. Exactly one of `organizationId` / `userId` is non-null
 * (the XOR pattern mandated by `CLAUDE.md`). */
export interface TenantScope {
	userId: string;
	organizationId?: string | null;
}

export interface LoadApplicableLimitsParams extends TenantScope {
	providerConfigId?: string | null;
	modelCanonicalName?: string | null;
	taskType?: AiTaskType | null;
	/**
	 * Project context for the AI call. When set, the chokepoint loads BOTH
	 * workspace-global limits (`projectId IS NULL` on the row) AND limits
	 * scoped to this specific project (`projectId === params.projectId`).
	 * When unset (a tenant-wide AI call with no project context, e.g.
	 * generic chat), only workspace-global limits are evaluated.
	 */
	projectId?: string | null;
}

export interface ReadCounterParams {
	limitId: string;
	windowStart: Date;
}

export interface IncrementCounterParams extends ReadCounterParams {
	deltaTokens: bigint;
	deltaMicroUsd: bigint;
	/**
	 * `window` value of the `AiUsageLimit` row that owns this counter —
	 * threaded through so callers can pass the full row without unpacking.
	 */
	limitWindow: AiUsageLimitWindow;
}

export interface CounterValue {
	usedTokens: bigint;
	usedMicroUsd: bigint;
}

// Window-start computation (timezone-aware, pure)

/**
 * Compute the first instant of the active calendar window for the given
 * `window` and IANA `timezone`, returned as a `Date` in UTC.
 * Honours DST transitions because the boundaries are derived from the
 * `Intl.DateTimeFormat` parts in the target timezone, not from naive UTC
 * offsets.
 *. Pure, unit-testable.
 * @param window — `HOURLY` / `DAILY` / `WEEKLY` / `MONTHLY`. WEEKLY uses
 * an ISO-week boundary (Monday 00:00 in the tenant's TZ).
 * @param timezone — IANA TZ name (e.g. `"America/Los_Angeles"`). `null`
 * falls back to `"UTC"` (matches the spec's default behaviour for
 * tenants that haven't set a TZ).
 * @param now — current instant (defaults to `new Date`). Threaded as a
 * parameter so unit tests can pin time without `vi.useFakeTimers`.
 */
export function windowStartFor(
	window: AiUsageLimitWindow,
	timezone: string | null,
	now: Date = new Date(),
): Date {
	const tz = timezone ?? "UTC";

	// `Intl.DateTimeFormat` is the only built-in that gives us calendar
	// parts (year/month/day/hour/minute/second) for an arbitrary IANA
	// zone without bringing in a 60kB tz database. We then reconstruct
	// the boundary by zeroing the sub-window components and converting
	// back to UTC via the same formatter.
	const parts = getDateParts(now, tz);

	switch (window) {
		case AiUsageLimitWindow.HOURLY:
			return zonedComponentsToUtc(
				{
					year: parts.year,
					month: parts.month,
					day: parts.day,
					hour: parts.hour,
					minute: 0,
					second: 0,
				},
				tz,
			);
		case AiUsageLimitWindow.DAILY:
			return zonedComponentsToUtc(
				{
					year: parts.year,
					month: parts.month,
					day: parts.day,
					hour: 0,
					minute: 0,
					second: 0,
				},
				tz,
			);
		case AiUsageLimitWindow.WEEKLY: {
			// ISO week — Monday is day 1, Sunday is day 7. We compute the
			// weekday in the tenant's TZ (so DST transitions and locale
			// boundaries are respected) and roll the day back to the most
			// recent Monday.
			const weekdayMondayBased = getZonedIsoWeekday(now, tz);
			const startOfDay = zonedComponentsToUtc(
				{
					year: parts.year,
					month: parts.month,
					day: parts.day,
					hour: 0,
					minute: 0,
					second: 0,
				},
				tz,
			);
			// Subtract (weekday-1) days from the start-of-day instant. Using
			// the UTC value here is safe because we already anchored to the
			// tenant's local midnight — subtracting a multiple of 24h lands
			// on the previous day's midnight in the same TZ (DST flips are
			// handled because the per-day step is 24h in instant time, not
			// 24h in wall-clock time; the chokepoint always compares against
			// the actual next boundary on the next call).
			return new Date(
				startOfDay.getTime() -
					(weekdayMondayBased - 1) * 24 * 60 * 60 * 1000,
			);
		}
		case AiUsageLimitWindow.MONTHLY:
			return zonedComponentsToUtc(
				{
					year: parts.year,
					month: parts.month,
					day: 1,
					hour: 0,
					minute: 0,
					second: 0,
				},
				tz,
			);
		default: {
			// Exhaustiveness check — if a new variant is added to
			// `AiUsageLimitWindow` the compiler will catch it here.
			const _exhaustive: never = window;
			throw new Error(
				`Unhandled AiUsageLimitWindow variant: ${String(_exhaustive)}`,
			);
		}
	}
}

interface ZonedDateParts {
	year: number;
	month: number; // 1-12
	day: number;
	hour: number;
	minute: number;
	second: number;
}

/**
 * Decompose a UTC `Date` into calendar parts as observed in `timezone`.
 * Internal helper for {@link windowStartFor}.
 */
function getDateParts(date: Date, timezone: string): ZonedDateParts {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});

	const result: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
	for (const part of formatter.formatToParts(date)) {
		result[part.type] = part.value;
	}

	// `hour: "2-digit", hour12: false` returns `"24"` at midnight in some
	// runtimes (legacy ICU) — normalise to `"00"`.
	const rawHour = result.hour ?? "0";
	const hour = rawHour === "24" ? 0 : Number.parseInt(rawHour, 10);

	return {
		year: Number.parseInt(result.year ?? "1970", 10),
		month: Number.parseInt(result.month ?? "1", 10),
		day: Number.parseInt(result.day ?? "1", 10),
		hour,
		minute: Number.parseInt(result.minute ?? "0", 10),
		second: Number.parseInt(result.second ?? "0", 10),
	};
}

/**
 * Return the ISO weekday (Monday=1, ..., Sunday=7) of `date` as observed
 * in the given `timezone`. Used by the WEEKLY window-start calculation.
 */
function getZonedIsoWeekday(date: Date, timezone: string): number {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		weekday: "short",
	});
	const weekday = formatter.format(date);
	// Map short weekday name → ISO weekday (Mon=1 ... Sun=7).
	switch (weekday) {
		case "Mon":
			return 1;
		case "Tue":
			return 2;
		case "Wed":
			return 3;
		case "Thu":
			return 4;
		case "Fri":
			return 5;
		case "Sat":
			return 6;
		case "Sun":
			return 7;
		default:
			// Defensive fallback — Intl returned an unexpected value (locale
			// shift, future runtime?). Treat as Monday so the window math
			// still produces a deterministic boundary.
			return 1;
	}
}

/**
 * Given calendar components observed in `timezone`, return the
 * corresponding UTC instant.
 * Algorithm: take a naive UTC `Date` from the components, then measure
 * the offset that `Intl.DateTimeFormat` reports for that instant in the
 * target zone, and shift by that offset. Two passes guarantee
 * correctness across DST transitions (the second pass picks up any
 * change in offset caused by the first shift).
 */
function zonedComponentsToUtc(parts: ZonedDateParts, timezone: string): Date {
	const naiveUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
		0,
	);

	const offset1 = tzOffsetMinutes(naiveUtc, timezone);
	const adjusted = naiveUtc - offset1 * 60 * 1000;
	const offset2 = tzOffsetMinutes(adjusted, timezone);
	const final = naiveUtc - offset2 * 60 * 1000;

	return new Date(final);
}

/**
 * Offset (in minutes) of `timezone` from UTC at the given instant.
 * Positive when `timezone` is east of UTC (e.g. `+540` for JST), matching
 * the convention used by `Date.getTimezoneOffset` *inverted* — note
 * that `Date.prototype.getTimezoneOffset` returns minutes WEST of UTC,
 * so we do not use it here.
 */
function tzOffsetMinutes(utcMs: number, timezone: string): number {
	const date = new Date(utcMs);
	const parts = getDateParts(date, timezone);
	const asIfUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
		0,
	);
	return Math.round((asIfUtc - utcMs) / 60_000);
}

// Tenant timezone resolution

/**
 * Resolve the tenant's effective IANA timezone, defaulting to `"UTC"`
 * when the tenant hasn't picked one. Per.
 * Single-row Prisma `findUnique` with `select: { timezone: true }` —
 * deliberately minimal so the helper can be called per-request without
 * pulling unrelated columns.
 */
export async function getTenantTimezone(scope: TenantScope): Promise<string> {
	if (scope.organizationId) {
		const org = await db.organization.findUnique({
			where: { id: scope.organizationId },
			select: { timezone: true },
		});
		return org?.timezone ?? "UTC";
	}
	const user = await db.user.findUnique({
		where: { id: scope.userId },
		select: { timezone: true },
	});
	return user?.timezone ?? "UTC";
}

// Counter R/W

/**
 * Read the current counter values for `(limitId, windowStart)` directly
 * from Postgres via the unique `(limitId, windowStart)` index. A missing
 * row returns `{ usedTokens: BigInt(0), usedMicroUsd: BigInt(0) }`.
 */
export async function readCounter(
	params: ReadCounterParams,
): Promise<CounterValue> {
	const row = await db.aiUsageLimitCounter.findUnique({
		where: {
			limitId_windowStart: {
				limitId: params.limitId,
				windowStart: params.windowStart,
			},
		},
		select: { usedTokens: true, usedMicroUsd: true },
	});

	if (!row) {
		return { usedTokens: BigInt(0), usedMicroUsd: BigInt(0) };
	}

	return {
		usedTokens: row.usedTokens,
		usedMicroUsd: row.usedMicroUsd,
	};
}

/**
 * Atomically increment the `(limitId, windowStart)` counter by the given
 * deltas. Postgres `upsert` with Prisma's atomic `increment` operator
 * handles concurrent writers without explicit locks — the unique
 * `(limitId, windowStart)` index serialises conflicting INSERTs. The
 * returned values are the *new* totals.
 */
export async function incrementCounter(
	params: IncrementCounterParams,
): Promise<CounterValue> {
	const row = await db.aiUsageLimitCounter.upsert({
		where: {
			limitId_windowStart: {
				limitId: params.limitId,
				windowStart: params.windowStart,
			},
		},
		create: {
			limitId: params.limitId,
			windowStart: params.windowStart,
			usedTokens: params.deltaTokens,
			usedMicroUsd: params.deltaMicroUsd,
		},
		update: {
			usedTokens: { increment: params.deltaTokens },
			usedMicroUsd: { increment: params.deltaMicroUsd },
		},
		select: { usedTokens: true, usedMicroUsd: true },
	});

	return {
		usedTokens: row.usedTokens,
		usedMicroUsd: row.usedMicroUsd,
	};
}

// Limit enumeration

/**
 * Load every active `AiUsageLimit` whose scope matches the given call.
 * Matching rules (/):
 * - Tenant XOR: org limits match an org call iff
 * `(limit.organizationId === scope.organizationId && limit.userId IS NULL)`.
 * Personal limits match a personal call iff
 * `(limit.userId === scope.userId && limit.organizationId IS NULL)`.
 * - `archivedAt IS NULL` (soft-deleted limits are excluded from
 * evaluation but kept on disk for historical reporting).
 * - For each optional filter (`providerConfigId`, `modelCanonicalName`,
 * `taskType`): a `NULL` filter on the row matches any value the call
 * carries; a non-NULL row filter must equal the call's value. A row
 * never matches a call that does NOT pass a value when the row has a
 * non-NULL filter — i.e. an unscoped call (no `providerConfigId` /
 * `modelCanonicalName` / `taskType`) is not blocked by a row that
 * targets a specific provider / model / task.
 * Each returned row includes `currentWindowStart`, computed once per
 * call from the tenant's effective TZ — callers should not recompute.
 */
export async function loadApplicableLimits(
	params: LoadApplicableLimitsParams,
): Promise<ApplicableAiUsageLimit[]> {
	// Resolve the effective TZ once — every limit's currentWindowStart
	// uses the same TZ.
	const timezone = await getTenantTimezone({
		userId: params.userId,
		organizationId: params.organizationId ?? null,
	});

	// Tenant XOR scope. We never combine the two halves with OR — a row
	// is either an org row OR a personal row, never both.
	const tenantScope = params.organizationId
		? { organizationId: params.organizationId, userId: null }
		: { organizationId: null, userId: params.userId };

	// Optional-filter helper: when the call carries a value, accept rows
	// where the column is NULL (unscoped) OR equal to the call's value.
	// When the call does NOT carry a value, accept only rows where the
	// column is NULL — see the JSDoc above for the rationale. Prisma's
	// `in` filter rejects mixed value+null arrays, so we use `OR` here.
	const providerConfigClause: Prisma.AiUsageLimitWhereInput =
		params.providerConfigId
			? {
					OR: [
						{ providerConfigId: null },
						{ providerConfigId: params.providerConfigId },
					],
				}
			: { providerConfigId: null };

	const modelClause: Prisma.AiUsageLimitWhereInput = params.modelCanonicalName
		? {
				OR: [
					{ modelCanonicalName: null },
					{ modelCanonicalName: params.modelCanonicalName },
				],
			}
		: { modelCanonicalName: null };

	const taskTypeClause: Prisma.AiUsageLimitWhereInput = params.taskType
		? {
				OR: [{ taskType: null }, { taskType: params.taskType }],
			}
		: { taskType: null };

	// Project clause follows the same NULL-or-equals pattern as the other
	// scope filters: when the call carries a `projectId`, accept rows with
	// `projectId IS NULL` (workspace-global) OR `projectId === call`. When
	// the call has no project context, only workspace-global rows apply —
	// project-scoped limits never block a call that wasn't routed to that
	// project.
	const projectClause: Prisma.AiUsageLimitWhereInput = params.projectId
		? {
				OR: [{ projectId: null }, { projectId: params.projectId }],
			}
		: { projectId: null };

	const rows = await db.aiUsageLimit.findMany({
		where: {
			...tenantScope,
			archivedAt: null,
			AND: [
				providerConfigClause,
				modelClause,
				taskTypeClause,
				projectClause,
			],
		},
		select: {
			id: true,
			organizationId: true,
			userId: true,
			projectId: true,
			name: true,
			providerConfigId: true,
			modelCanonicalName: true,
			taskType: true,
			dimension: true,
			window: true,
			maxValue: true,
			enforcement: true,
			bannerThresholdPercent: true,
			createdById: true,
		},
		orderBy: { createdAt: "asc" },
	});

	const now = new Date();
	return rows.map((row) => ({
		...row,
		currentWindowStart: windowStartFor(row.window, timezone, now),
	}));
}

// ===========================================================================
// — chokepoint surface
// ===========================================================================

// AiUsageLimitExceededError

/**
 * Structured error thrown by {@link assertWithinAiUsageLimits} when a HARD
 * `AiUsageLimit` would be exceeded by the in-flight call. The fields are
 * read-only and form the contract that the oRPC error mapper + every
 * client surface (Nexus chat, document AI, daily brief, embeddings …)
 * relies on to render a single destructive toast with a "Manage limits"
 * deep link.
 * Carries the structured payload that the rich client UI needs.
 */
export class AiUsageLimitExceededError extends Error {
	readonly code = "AI_USAGE_LIMIT_EXCEEDED" as const;
	readonly limitId: string;
	readonly dimension: AiUsageLimitDimension;
	readonly window: AiUsageLimitWindow;
	readonly used: bigint;
	readonly max: bigint;
	readonly manageLimitsUrl: string;

	constructor(params: {
		message: string;
		limitId: string;
		dimension: AiUsageLimitDimension;
		window: AiUsageLimitWindow;
		used: bigint;
		max: bigint;
		manageLimitsUrl: string;
	}) {
		super(params.message);
		this.name = "AiUsageLimitExceededError";
		this.limitId = params.limitId;
		this.dimension = params.dimension;
		this.window = params.window;
		this.used = params.used;
		this.max = params.max;
		this.manageLimitsUrl = params.manageLimitsUrl;
	}
}

// Threshold-crossing math (pure)

/**
 * Compute `(used * 100) / max` as a number for telemetry labels.
 * BigInt division truncates, which is what we want for a "percent used"
 * label — `99.6%` reads as `99` so we never log `100` until the counter
 * has actually crossed. `max <= 0` is defensive (the upsert procedure
 * validates `maxValue > 0`); we return `0` rather than throw because
 * telemetry must never break the hot path.
 * The result is bounded: at v1 limits (max ~10^12 micro-USD over a
 * monthly window) the multiplied value still fits in `Number.MAX_SAFE_INTEGER`,
 * so the `Number(..)` coercion is lossless.
 */
function percentUsed(used: bigint, max: bigint): number {
	if (max <= BigInt(0)) {
		return 0;
	}
	return Number((used * BigInt(100)) / max);
}

/**
 * Returns the threshold lines (80%, 100%) crossed when the counter moved
 * from `pre` to `post` against the given `max`. Pure, BigInt-only — no
 * floating-point coercion, so monthly micro-USD counters that exceed
 * `Number.MAX_SAFE_INTEGER` still compute correctly.
 * Comparison form: `value * 100 >= max * threshold` rather than a ratio,
 * which keeps the arithmetic in BigInt all the way through. A single
 * large call that takes the counter from 0% straight to 110% returns
 * `[80, 100]` so both notifications fire.
 * `max <= 0n` is treated as "no threshold can be crossed" — defensive
 * against a malformed limit row; the upsert procedure validates
 * `maxValue > 0` so this should be unreachable in practice.
 */
function crossedThresholds(
	pre: bigint,
	post: bigint,
	max: bigint,
): (80 | 100)[] {
	if (max <= BigInt(0)) {
		return [];
	}

	const crossed: (80 | 100)[] = [];
	const hundred = BigInt(100);
	const eighty = BigInt(80);

	const preTimes100 = pre * hundred;
	const postTimes100 = post * hundred;
	const max80 = max * eighty;
	const max100 = max * hundred;

	if (preTimes100 < max80 && postTimes100 >= max80) {
		crossed.push(80);
	}
	if (preTimes100 < max100 && postTimes100 >= max100) {
		crossed.push(100);
	}

	return crossed;
}

// Manage-limits deep link

/**
 * Build the in-app deep link to the AI Usage page for the given limit.
 * Org context: `/app/{slug}/settings/usage?limitId={limitId}` (slug looked
 * up via Prisma). Personal context: `/app/settings/usage?limitId={limitId}`.
 * On a missing slug (e.g. an org row without one or a deleted org), falls
 * back to the personal shape so the recipient at least lands on a page
 * that can show the limit. "Link".
 * TODO: dedupe with `notification-service.buildManageLimitsUrlInternal`.
 * The two helpers carry the same logic on purpose — `notification-service`
 * lives in `@repo/api` and importing from there inside this hot-path
 * helper would import a large module graph (sendEmail, validatePayload,
 * etc.) just for ten lines. Keep them in sync; both follow
 */
async function buildManageLimitsUrl(
	organizationId: string | null,
	limitId: string,
): Promise<string> {
	if (organizationId) {
		const org = await db.organization.findUnique({
			where: { id: organizationId },
			select: { slug: true },
		});
		if (org?.slug) {
			return `/app/${org.slug}/settings/usage?limitId=${limitId}`;
		}
	}
	return `/app/settings/usage?limitId=${limitId}`;
}

// Pre-call gate

export interface AssertWithinAiUsageLimitsParams {
	userId: string;
	organizationId?: string | null;
	providerConfigId?: string | null;
	modelCanonicalName?: string | null;
	taskType?: AiTaskType | null;
	/**
	 * Project context for the AI call. When set, project-scoped limits for
	 * this project are evaluated alongside workspace-global limits. When
	 * unset (a tenant-wide AI call with no project context), only
	 * workspace-global limits are evaluated.
	 */
	projectId?: string | null;
}

/**
 * Throw {@link AiUsageLimitExceededError} if any HARD `AiUsageLimit`
 * applicable to the given call would be exceeded by `currentValue + 1`.
 * Behaviour Flow A:
 * 1. Enumerate the limits matching the call's `(tenant, providerConfigId?,
 * modelCanonicalName?, taskType?)` scope via {@link loadApplicableLimits}.
 * 2. If no limits apply, return immediately — no further query, no
 * overhead. This is the backward-compat guarantee: tenants with no
 * limits configured see no behaviour change.
 * 3. For each limit, read the counter for the active window. For HARD
 * limits, compare `currentValue + 1n` against `maxValue`; throw on
 * breach. SOFT limits are not evaluated here — the post-record path
 * fires the notification when the counter actually crosses 100%.
 * The `+1n` reservation is optimistic — overshoot is
 * accepted in v1, bounded by a single in-flight call per concurrent
 * worker. A stricter reservation pattern is deferred to v2.
 * Telemetry: `error` log on a HARD block; the pre-check
 * pass log is gated on `DEBUG_AI_LIMITS=1` so the hot path stays quiet.
 */
export async function assertWithinAiUsageLimits(
	params: AssertWithinAiUsageLimitsParams,
): Promise<void> {
	const limits = await loadApplicableLimits({
		userId: params.userId,
		organizationId: params.organizationId ?? null,
		providerConfigId: params.providerConfigId ?? null,
		modelCanonicalName: params.modelCanonicalName ?? null,
		taskType: params.taskType ?? null,
		projectId: params.projectId ?? null,
	});

	// fast path — no limits configured, no overhead.
	if (limits.length === 0) {
		return;
	}

	for (const limit of limits) {
		const counter = await readCounter({
			limitId: limit.id,
			windowStart: limit.currentWindowStart,
		});

		const current =
			limit.dimension === "TOKENS"
				? counter.usedTokens
				: counter.usedMicroUsd;

		// Per-limit percent label for telemetry — computed once and reused
		// by every log line below so the SRE can grep on a single field
		// without re-deriving it from `used` / `max`.
		const percent = percentUsed(current, limit.maxValue);

		// HARD-block branch — overshoot-accepted reservation (`+ 1n`) per
		// / We reserve a single token (or
		// micro-USD) because the chokepoint doesn't price the in-flight
		// call — the catch is for the *prior* over-budget state. See
		// / in
		const wouldBlock =
			limit.enforcement === AiUsageLimitEnforcement.HARD &&
			current + BigInt(1) > limit.maxValue;

		if (wouldBlock) {
			const manageLimitsUrl = await buildManageLimitsUrl(
				limit.organizationId,
				limit.id,
			);

			const message = `AI usage limit exceeded: ${limit.id} (${limit.dimension}, ${limit.window}) — used ${current.toString()} of ${limit.maxValue.toString()}`;

			logger.error(
				{
					event: "aiUsageLimits.preCheck.block",
					limitId: limit.id,
					currentValue: current.toString(),
					max: limit.maxValue.toString(),
					percent,
					dimension: limit.dimension,
					window: limit.window,
					enforcement: limit.enforcement,
					userId: params.userId,
					organizationId: params.organizationId ?? null,
					providerConfigId: params.providerConfigId ?? null,
					modelCanonicalName: params.modelCanonicalName ?? null,
					taskType: params.taskType ?? null,
				},
				"[AiUsageLimits] HARD block",
			);

			throw new AiUsageLimitExceededError({
				message,
				limitId: limit.id,
				dimension: limit.dimension,
				window: limit.window,
				used: current,
				max: limit.maxValue,
				manageLimitsUrl,
			});
		}

		// Pre-check warn — emitted when the counter is already at >=80% but
		// the call is still let through (SOFT limit, OR HARD limit not yet
		// at the breach line). row "Pre-check warn (>=80%
		// but not blocking)". The fan-out notification is owned by the
		// post-record path; this log is purely an ops signal so dashboards
		// can rate the "approaching limit" population without waiting for
		// the threshold-crossed line.
		if (percent >= 80) {
			logger.warn(
				{
					event: "aiUsageLimits.preCheck.softWarn",
					limitId: limit.id,
					currentValue: current.toString(),
					max: limit.maxValue.toString(),
					percent,
					dimension: limit.dimension,
					window: limit.window,
					enforcement: limit.enforcement,
					userId: params.userId,
					organizationId: params.organizationId ?? null,
				},
				"[AiUsageLimits] Soft limit at threshold",
			);
		}
	}

	// Pre-check pass log — opt-in via env var so the hot path stays quiet
	// in production.
	if (process.env.DEBUG_AI_LIMITS === "1") {
		logger.debug(
			{
				event: "aiUsageLimits.preCheck.pass",
				userId: params.userId,
				organizationId: params.organizationId ?? null,
				applicableCount: limits.length,
			},
			"[AiUsageLimits] pre-check pass",
		);
	}
}

// Post-call accounting + threshold detection

export interface RecordAiUsageAndCheckOverageParams
	extends AssertWithinAiUsageLimitsParams {
	totalTokens: number;
	costMicroUsd: number;
}

/**
 * Increment counters for every limit matching the call and fire a
 * threshold notification for each 80% / 100% line crossed.
 * Behaviour Flow B:
 * 1. Enumerate the same set of limits {@link assertWithinAiUsageLimits}
 * would have evaluated. Empty → return.
 * 2. For each limit, compute the dimension-specific delta and call
 * {@link incrementCounter}. The helper returns the POST-totals; we
 * derive `pre = post - delta` to detect threshold crossings without a
 * second read.
 * 3. For each line crossed in this update, call
 * `fanOut.aiUsageThreshold(..)` from `@repo/api/lib/notification-service`.
 * Each fan-out is wrapped in try/catch — a notification failure must
 * never break the wrapping `logAiUsage` row insert.
 * Top-level try/catch: any error inside the body is logged and swallowed.
 * `logAiUsage` already wraps this call in its own try/catch but the
 * defence-in-depth catch here keeps the error structured for ops grep
 * regardless of the call site.
 */
export async function recordAiUsageAndCheckOverage(
	params: RecordAiUsageAndCheckOverageParams,
): Promise<void> {
	try {
		const limits = await loadApplicableLimits({
			userId: params.userId,
			organizationId: params.organizationId ?? null,
			providerConfigId: params.providerConfigId ?? null,
			modelCanonicalName: params.modelCanonicalName ?? null,
			taskType: params.taskType ?? null,
			projectId: params.projectId ?? null,
		});

		if (limits.length === 0) {
			return;
		}

		const tokenDelta = BigInt(params.totalTokens);
		const microUsdDelta = BigInt(params.costMicroUsd);

		for (const limit of limits) {
			const isTokens = limit.dimension === "TOKENS";
			const deltaTokens = isTokens ? tokenDelta : BigInt(0);
			const deltaMicroUsd = isTokens ? BigInt(0) : microUsdDelta;

			const post = await incrementCounter({
				limitId: limit.id,
				windowStart: limit.currentWindowStart,
				deltaTokens,
				deltaMicroUsd,
				limitWindow: limit.window,
			});

			const postValue = isTokens ? post.usedTokens : post.usedMicroUsd;
			const delta = isTokens ? deltaTokens : deltaMicroUsd;
			const preValue = postValue - delta;

			const crossings = crossedThresholds(
				preValue,
				postValue,
				limit.maxValue,
			);

			if (crossings.length === 0) {
				continue;
			}

			const windowStartIso = limit.currentWindowStart.toISOString();

			for (const threshold of crossings) {
				logger.info(
					{
						event: "aiUsageLimits.thresholdCrossed",
						limitId: limit.id,
						threshold,
						used: postValue.toString(),
						max: limit.maxValue.toString(),
						dimension: limit.dimension,
						window: limit.window,
					},
					"[AiUsageLimits] threshold crossed",
				);

				try {
					// Notification fan-out lives in `@repo/api/lib/notification-service`,
					// which `@repo/payments` cannot statically depend on (would form
					// a workspace cycle: api → payments → api). Callers register a
					// handler via {@link setAiUsageThresholdNotifier} during their
					// app boot; if none is registered, the threshold is still logged
					// above but no email/inbox notification is dispatched — that's
					// the trade-off for keeping the cycle broken.
					const notifier = aiUsageThresholdNotifier;
					if (notifier) {
						await notifier({
							limitId: limit.id,
							organizationId: limit.organizationId,
							userId: limit.userId,
							createdById: limit.createdById,
							windowStartIso,
							threshold,
							dimension: limit.dimension,
							window: limit.window,
							enforcement: limit.enforcement,
							used: postValue,
							max: limit.maxValue,
							limitName: limit.name,
						});
					}
				} catch (error) {
					logger.warn(
						{
							event: "aiUsageLimits.fanOutFailed",
							limitId: limit.id,
							threshold,
							error: String(error),
						},
						"[AiUsageLimits] Failed to fan out threshold notification",
					);
				}
			}
		}
	} catch (error) {
		// Defence-in-depth — `logAiUsage` already wraps this call in its
		// own try/catch, but the structured catch here
		// keeps the warn-log shape consistent regardless of caller.
		logger.error(
			{
				event: "aiUsageLimits.recordFailed",
				userId: params.userId,
				organizationId: params.organizationId ?? null,
				error: String(error),
			},
			"[AiUsageLimits] Failed to record usage / check overage",
		);
	}
}

// Self-register the post-record hook in `@repo/database` so `logAiUsage`
// invokes `recordAiUsageAndCheckOverage` after every successful insert.
// Without this, AI usage rows would log but per-limit counters would
// never advance — limits would be effectively disabled.
setAiUsageRecorder(recordAiUsageAndCheckOverage);
