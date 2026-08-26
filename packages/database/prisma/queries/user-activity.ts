/**
 * User Activity dashboard query layer.
 *
 * Read-only queries for the org-scoped "User Activity" settings page,
 * over two distinct sources: `User.lastSeenAt` (real activity — the
 * recency the dashboard sorts on) and `audit_log` auth events (sign-in
 * history — the chart and the secondary column). They answer different
 * questions and neither substitutes for the other; see
 * ./user-last-seen.ts for why login events cannot rank engagement.
 *
 * Auth events are written with `organizationId = null` (no org context
 * exists at sign-in), so every query here resolves the org's member
 * userIds first and filters `audit_log` by `userId IN (...)` — never by
 * organizationId.
 *
 * Day bucketing happens in JS on UTC days (house convention — see
 * `aggregateAuditLogStats` in ./audit-log.ts; no `date_trunc`).
 */

import { db } from "../client";

export type ActivityRangeDays = 7 | 30 | 90;

export const ACTIVITY_RANGE_OPTIONS: readonly ActivityRangeDays[] = [7, 30, 90];

export type LoginDayBucket = {
	/** UTC day key, `YYYY-MM-DD`. */
	day: string;
	count: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayKey(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/**
 * Zero-filled UTC day buckets covering the last `rangeDays` days
 * (inclusive of today), oldest first. Logins outside the window are
 * ignored rather than clamped.
 */
export function bucketLoginsByDay(
	loginDates: Date[],
	rangeDays: ActivityRangeDays,
	now: Date,
): LoginDayBucket[] {
	const startOfToday = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	const buckets = new Map<string, number>();
	const order: string[] = [];
	for (let i = rangeDays - 1; i >= 0; i--) {
		const key = utcDayKey(new Date(startOfToday.getTime() - i * DAY_MS));
		buckets.set(key, 0);
		order.push(key);
	}
	for (const date of loginDates) {
		const key = utcDayKey(date);
		const current = buckets.get(key);
		if (current !== undefined) {
			buckets.set(key, current + 1);
		}
	}
	return order.map((day) => ({ day, count: buckets.get(day) ?? 0 }));
}

/**
 * Start of the activity window: UTC midnight of the oldest bucket day.
 * Range-filtered login counts and the day buckets must cover the
 * identical window, otherwise the history view's total diverges from
 * the sum of its bars.
 */
export function activityRangeStart(
	rangeDays: ActivityRangeDays,
	now: Date,
): Date {
	const startOfToday = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	);
	return new Date(startOfToday.getTime() - (rangeDays - 1) * DAY_MS);
}

/**
 * Sort by a recency date. `desc` = most recently active first, never-active
 * last. `asc` = most inactive first, so never-active (the MOST inactive)
 * sorts first. Ties break on email ascending for stable output. Pure —
 * returns a new array. The date is supplied by an accessor so the same
 * ordering serves lastSeenAt (the dashboard's metric) and lastLoginAt.
 */
export function sortMembersByRecency<T extends { email: string }>(
	rows: T[],
	sortDir: "asc" | "desc",
	getDate: (row: T) => Date | null,
): T[] {
	return [...rows].sort((a, b) => {
		const aDate = getDate(a);
		const bDate = getDate(b);
		if (aDate === null && bDate === null) {
			return a.email.localeCompare(b.email);
		}
		if (aDate === null) {
			return sortDir === "asc" ? -1 : 1;
		}
		if (bDate === null) {
			return sortDir === "asc" ? 1 : -1;
		}
		const delta = aDate.getTime() - bDate.getTime();
		if (delta !== 0) {
			return sortDir === "asc" ? delta : -delta;
		}
		return a.email.localeCompare(b.email);
	});
}

const LOGIN_ACTION = "auth.login.success";
const RECENT_EVENT_ACTIONS = ["auth.login.success", "auth.logout"];
const RECENT_EVENTS_LIMIT = 20;

export type MemberActivityRow = {
	userId: string;
	name: string | null;
	email: string;
	image: string | null;
	role: string;
	/** Last authenticated request. NULL = never active. */
	lastSeenAt: Date | null;
	lastLoginAt: Date | null;
	loginCountInRange: number;
};

export type MemberLoginHistory = {
	user: {
		id: string;
		name: string | null;
		email: string;
		image: string | null;
	};
	role: string;
	/** Last authenticated request. NULL = never active. */
	lastSeenAt: Date | null;
	buckets: LoginDayBucket[];
	totalLoginsInRange: number;
	recentEvents: Array<{
		action: string;
		createdAt: Date;
		ipAddress: string | null;
		userAgent: string | null;
	}>;
};

/**
 * Per-member last login + login count within the range, for the org's
 * member list. Sorting and offset/limit pagination happen in memory —
 * org member cardinality is small (tens to low hundreds) and the sort
 * key (lastLoginAt) only exists after the audit aggregation anyway.
 */
export async function listMemberActivity(args: {
	organizationId: string;
	rangeDays: ActivityRangeDays;
	sortDir: "asc" | "desc";
	query?: string;
	limit: number;
	offset: number;
	now?: Date;
}): Promise<{ items: MemberActivityRow[]; total: number }> {
	const now = args.now ?? new Date();
	const trimmed = (args.query ?? "").trim();

	const members = await db.member.findMany({
		where: {
			// Hard tenant clamp — same pattern as audit searchMembers.
			organizationId: args.organizationId,
			...(trimmed
				? {
						OR: [
							{
								user: {
									name: {
										contains: trimmed,
										mode: "insensitive",
									},
								},
							},
							{
								user: {
									email: {
										contains: trimmed,
										mode: "insensitive",
									},
								},
							},
						],
					}
				: {}),
		},
		select: {
			role: true,
			user: {
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
					lastSeenAt: true,
				},
			},
		},
	});

	if (members.length === 0) {
		return { items: [], total: 0 };
	}

	const userIds = members.map((m) => m.user.id);
	const rangeStart = activityRangeStart(args.rangeDays, now);

	// Auth events carry organizationId = null — filter by member userIds,
	// never by organizationId. Covered by audit_log_idx_user_created.
	const [lastLogins, counts] = await Promise.all([
		db.auditLog.groupBy({
			by: ["userId"],
			where: { userId: { in: userIds }, action: LOGIN_ACTION },
			_max: { createdAt: true },
		}),
		db.auditLog.groupBy({
			by: ["userId"],
			where: {
				userId: { in: userIds },
				action: LOGIN_ACTION,
				createdAt: { gte: rangeStart },
			},
			_count: { _all: true },
		}),
	]);

	const lastLoginByUser = new Map(
		lastLogins.map((row) => [row.userId, row._max.createdAt]),
	);
	const countByUser = new Map(
		counts.map((row) => [row.userId, row._count._all]),
	);

	const rows: MemberActivityRow[] = members.map((m) => ({
		userId: m.user.id,
		name: m.user.name,
		email: m.user.email,
		image: m.user.image,
		role: m.role,
		lastSeenAt: m.user.lastSeenAt,
		lastLoginAt: lastLoginByUser.get(m.user.id) ?? null,
		loginCountInRange: countByUser.get(m.user.id) ?? 0,
	}));

	// Recency = real activity, not re-authentication. Sessions last 30 days
	// with rolling refresh, so lastLoginAt cannot rank engagement (#1709).
	const sorted = sortMembersByRecency(
		rows,
		args.sortDir,
		(r) => r.lastSeenAt,
	);
	return {
		items: sorted.slice(args.offset, args.offset + args.limit),
		total: rows.length,
	};
}

/**
 * Per-member login history: zero-filled daily buckets + the most recent
 * login/logout events (with IP and user agent). Returns `null` when the
 * target user is not a member of the org — callers translate that to
 * NOT_FOUND so the endpoint cannot be used to probe non-members.
 */
export async function getMemberLoginHistory(args: {
	organizationId: string;
	userId: string;
	rangeDays: ActivityRangeDays;
	now?: Date;
}): Promise<MemberLoginHistory | null> {
	const now = args.now ?? new Date();

	const member = await db.member.findUnique({
		where: {
			organizationId_userId: {
				organizationId: args.organizationId,
				userId: args.userId,
			},
		},
		select: {
			role: true,
			user: {
				select: {
					id: true,
					name: true,
					email: true,
					image: true,
					lastSeenAt: true,
				},
			},
		},
	});
	if (!member) {
		return null;
	}

	const rangeStart = activityRangeStart(args.rangeDays, now);

	const [logins, recentEvents] = await Promise.all([
		db.auditLog.findMany({
			where: {
				userId: args.userId,
				action: LOGIN_ACTION,
				createdAt: { gte: rangeStart },
			},
			select: { createdAt: true },
			orderBy: { createdAt: "asc" },
		}),
		db.auditLog.findMany({
			where: {
				userId: args.userId,
				action: { in: RECENT_EVENT_ACTIONS },
				createdAt: { gte: rangeStart },
			},
			select: {
				action: true,
				createdAt: true,
				ipAddress: true,
				userAgent: true,
			},
			orderBy: { createdAt: "desc" },
			take: RECENT_EVENTS_LIMIT,
		}),
	]);

	const { lastSeenAt, ...user } = member.user;

	return {
		user,
		role: member.role,
		lastSeenAt,
		buckets: bucketLoginsByDay(
			logins.map((l) => l.createdAt),
			args.rangeDays,
			now,
		),
		totalLoginsInRange: logins.length,
		recentEvents,
	};
}
