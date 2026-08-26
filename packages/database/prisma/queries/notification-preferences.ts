/**
 * Notification Center preference queries.
 *
 * Per-user, account-global preferences controlling which in-app notification
 * categories a user receives. There is exactly one row per user, keyed at the
 * `organizationId = ""` sentinel — the compound unique reserves room for
 * per-org scoping later, but every read/write here targets the `""` row.
 * Mirrors the `orchestrator-preferences` / `chat-agent-selection` modules.
 *
 * Defaults are opt-out: a missing row (or a missing flag) means ENABLED. Only
 * the curated, user-facing categories have a toggle. SYSTEM, BILLING,
 * CONTEXT_INDEXING_* and all incident/digest types are always-on — they are
 * absent from `CATEGORY_TO_TOGGLE` and therefore never suppressed. That
 * opt-out rule covers the DELIVERY flags only — the display preference in
 * `NotificationDisplayPreference` shares the same row but is opt-in and
 * defaults to false.
 *
 * Used both by the Settings UI (via oRPC procedures) and by the write-time
 * notification filter in `@repo/api` notification-service + the in-database
 * notification writers (pm-conflict, agent-reply, repo-integration).
 */

import { db, type NotificationCategory } from "../client";

export type NotificationPreferenceFlags = {
	mentions: boolean;
	replies: boolean;
	assignments: boolean;
	status: boolean;
	syncProject: boolean;
	aiAgent: boolean;
	reportEmails: boolean;
	reviewEmails: boolean;
	publishingSuggestions: boolean;
	publishingEmails: boolean;
};

/** All-enabled default — applied when no row exists (opt-out model). */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferenceFlags = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
	reportEmails: true,
	reviewEmails: true,
	publishingSuggestions: true,
	publishingEmails: true,
};

/**
 * Display-only notification preference (#2117).
 *
 * Intentionally a separate type from `NotificationPreferenceFlags`, which is
 * consumed by the write-time delivery filter and carries the invariant that
 * every member gates delivery on some channel and defaults to `true`. A style
 * preference satisfies neither half — it gates nothing, and it is opt-in.
 * Both live on the same `notification_preference` row.
 */
export type NotificationDisplayPreference = {
	stackedCardStyle: boolean;
};

/** Opt-in default — the compact rows stay the status quo for existing users. */
export const DEFAULT_NOTIFICATION_DISPLAY: NotificationDisplayPreference = {
	stackedCardStyle: false,
};

const DISPLAY_SELECT = { stackedCardStyle: true } as const;

/**
 * Maps a `NotificationCategory` to the preference toggle that gates it.
 * Categories absent from this map are ALWAYS-ON (SYSTEM, BILLING,
 * CONTEXT_INDEXING_STARTED, CONTEXT_INDEXING_COMPLETED) — they have no toggle
 * and are never suppressed by user preferences.
 */
export const CATEGORY_TO_TOGGLE: Partial<
	Record<NotificationCategory, keyof NotificationPreferenceFlags>
> = {
	MENTION: "mentions",
	REPLY: "replies",
	ASSIGNMENT: "assignments",
	// Decision ownership routing (Fizzy #2029) is assignment-like: the person
	// made answerable for a decision, or an owned decision changed.
	DECISION_OWNER_ASSIGNED: "assignments",
	DECISION_OWNER_UPDATED: "assignments",
	STATUS: "status",
	PROJECT: "syncProject",
	AGENT: "aiAgent",
	PUBLISHING: "publishingSuggestions",
};

/**
 * Whether a category is allowed to produce an in-app notification given a
 * user's preference flags. Always-on categories (not in `CATEGORY_TO_TOGGLE`)
 * return `true` regardless of flags.
 */
export function isCategoryEnabled(
	flags: NotificationPreferenceFlags,
	category: NotificationCategory,
): boolean {
	const toggle = CATEGORY_TO_TOGGLE[category];
	if (!toggle) {
		return true; // always-on category
	}
	return flags[toggle];
}

// Prisma compound unique doesn't handle null cleanly; "" is the personal /
// account-global sentinel, matching UserOrchestratorPreferences.
function normalizeOrgId(organizationId?: string | null): string {
	return organizationId || "";
}

const FLAG_SELECT = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
	reportEmails: true,
	reviewEmails: true,
	publishingSuggestions: true,
	publishingEmails: true,
} as const;

/**
 * Read a user's notification preferences. Returns the all-enabled default when
 * no row exists (opt-out model — AC-6: a missing row means everything is on).
 */
export async function getNotificationPreferences(
	userId: string,
	organizationId?: string | null,
): Promise<NotificationPreferenceFlags> {
	const row = await db.notificationPreference.findUnique({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		select: FLAG_SELECT,
	});

	if (!row) {
		return { ...DEFAULT_NOTIFICATION_PREFERENCES };
	}

	return {
		mentions: row.mentions,
		replies: row.replies,
		assignments: row.assignments,
		status: row.status,
		syncProject: row.syncProject,
		aiAgent: row.aiAgent,
		reportEmails: row.reportEmails,
		reviewEmails: row.reviewEmails,
		publishingSuggestions: row.publishingSuggestions,
		publishingEmails: row.publishingEmails,
	};
}

/**
 * Create or update a user's notification preferences. Only the provided flags
 * are changed; omitted flags keep their current (or default) value.
 */
export async function upsertNotificationPreferences(
	userId: string,
	preferences: Partial<NotificationPreferenceFlags>,
	organizationId?: string | null,
): Promise<NotificationPreferenceFlags> {
	const orgId = normalizeOrgId(organizationId);
	const row = await db.notificationPreference.upsert({
		where: { userId_organizationId: { userId, organizationId: orgId } },
		create: {
			userId,
			organizationId: orgId,
			mentions: preferences.mentions ?? true,
			replies: preferences.replies ?? true,
			assignments: preferences.assignments ?? true,
			status: preferences.status ?? true,
			syncProject: preferences.syncProject ?? true,
			aiAgent: preferences.aiAgent ?? true,
			reportEmails: preferences.reportEmails ?? true,
			reviewEmails: preferences.reviewEmails ?? true,
			publishingSuggestions: preferences.publishingSuggestions ?? true,
			publishingEmails: preferences.publishingEmails ?? true,
		},
		update: {
			...(preferences.mentions !== undefined && {
				mentions: preferences.mentions,
			}),
			...(preferences.replies !== undefined && {
				replies: preferences.replies,
			}),
			...(preferences.assignments !== undefined && {
				assignments: preferences.assignments,
			}),
			...(preferences.status !== undefined && {
				status: preferences.status,
			}),
			...(preferences.syncProject !== undefined && {
				syncProject: preferences.syncProject,
			}),
			...(preferences.aiAgent !== undefined && {
				aiAgent: preferences.aiAgent,
			}),
			...(preferences.reportEmails !== undefined && {
				reportEmails: preferences.reportEmails,
			}),
			...(preferences.reviewEmails !== undefined && {
				reviewEmails: preferences.reviewEmails,
			}),
			...(preferences.publishingSuggestions !== undefined && {
				publishingSuggestions: preferences.publishingSuggestions,
			}),
			...(preferences.publishingEmails !== undefined && {
				publishingEmails: preferences.publishingEmails,
			}),
		},
		select: FLAG_SELECT,
	});

	return {
		mentions: row.mentions,
		replies: row.replies,
		assignments: row.assignments,
		status: row.status,
		syncProject: row.syncProject,
		aiAgent: row.aiAgent,
		reportEmails: row.reportEmails,
		reviewEmails: row.reviewEmails,
		publishingSuggestions: row.publishingSuggestions,
		publishingEmails: row.publishingEmails,
	};
}

/** Read a user's display preference. Missing row → the opt-in default. */
export async function getNotificationDisplayPreference(
	userId: string,
	organizationId?: string | null,
): Promise<NotificationDisplayPreference> {
	const row = await db.notificationPreference.findUnique({
		where: {
			userId_organizationId: {
				userId,
				organizationId: normalizeOrgId(organizationId),
			},
		},
		select: DISPLAY_SELECT,
	});

	if (!row) {
		return { ...DEFAULT_NOTIFICATION_DISPLAY };
	}

	return { stackedCardStyle: row.stackedCardStyle };
}

/**
 * Write a user's display preference. Touches only the display column — the
 * delivery flags on a newly created row fall to their schema defaults, which
 * match `DEFAULT_NOTIFICATION_PREFERENCES` (all enabled).
 */
export async function upsertNotificationDisplayPreference(
	userId: string,
	preferences: Partial<NotificationDisplayPreference>,
	organizationId?: string | null,
): Promise<NotificationDisplayPreference> {
	const orgId = normalizeOrgId(organizationId);
	const row = await db.notificationPreference.upsert({
		where: { userId_organizationId: { userId, organizationId: orgId } },
		create: {
			userId,
			organizationId: orgId,
			stackedCardStyle: preferences.stackedCardStyle ?? false,
		},
		update: {
			...(preferences.stackedCardStyle !== undefined && {
				stackedCardStyle: preferences.stackedCardStyle,
			}),
		},
		select: DISPLAY_SELECT,
	});

	return { stackedCardStyle: row.stackedCardStyle };
}

/**
 * Given a set of recipient user IDs and a notification category, return the
 * subset whose preferences allow that category. Single batched query for
 * fan-out efficiency (one query regardless of recipient count).
 *
 * Semantics:
 *  - Always-on category (not in `CATEGORY_TO_TOGGLE`) → every recipient.
 *  - Default-on: a recipient with no preference row is INCLUDED.
 *  - Only recipients with an explicit `false` on the mapped toggle are dropped.
 */
export async function getEnabledRecipientsForCategory(
	userIds: string[],
	category: NotificationCategory,
): Promise<Set<string>> {
	const toggle = CATEGORY_TO_TOGGLE[category];
	if (!toggle) {
		return new Set(userIds); // always-on category
	}
	if (userIds.length === 0) {
		return new Set();
	}

	const rows = await db.notificationPreference.findMany({
		where: { userId: { in: userIds }, organizationId: "" },
		select: { userId: true, ...FLAG_SELECT },
	});

	const disabled = new Set(
		rows.filter((row) => row[toggle] === false).map((row) => row.userId),
	);

	return new Set(userIds.filter((id) => !disabled.has(id)));
}

/** The preference flags that gate an email send — one member per email-channel toggle. */
export const EMAIL_FLAGS = [
	"reportEmails",
	"reviewEmails",
	"publishingEmails",
] as const;
export type NotificationEmailFlag = (typeof EMAIL_FLAGS)[number];

/**
 * The EMAIL-channel counterpart to getEnabledRecipientsForCategory.
 *
 * A separate function rather than a parameter on that one, because they answer different
 * questions. That one maps a NotificationCategory through CATEGORY_TO_TOGGLE and returns everyone
 * for an always-on category; this one is handed the column directly, because email toggles are
 * not categories and have no always-on case — an email nobody can switch off is a different
 * product decision from a bell nobody can switch off.
 *
 * Same opt-out semantics as its sibling and as `reviewEmails`
 * (newsletter-review-recipients.ts:198-201): a recipient with NO preference row is INCLUDED, and
 * only an explicit `false` drops them. One batched query regardless of recipient count.
 */
export async function getRecipientsWithEmailFlagEnabled(
	userIds: string[],
	flag: NotificationEmailFlag,
): Promise<Set<string>> {
	if (userIds.length === 0) {
		return new Set();
	}

	const rows = await db.notificationPreference.findMany({
		where: { userId: { in: userIds }, organizationId: "" },
		select: { userId: true, ...FLAG_SELECT },
	});

	const disabled = new Set(
		rows.filter((row) => row[flag] === false).map((row) => row.userId),
	);

	return new Set(userIds.filter((id) => !disabled.has(id)));
}
