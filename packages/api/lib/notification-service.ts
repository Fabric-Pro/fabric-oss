/**
 * Per-recipient notification writer.
 * Writers (comment create, assignment, agent finished) call the high-level
 * `fanOut.*` helpers. The helpers in turn call `createNotification`, which
 * skips self-notifications, deduplicates via a partial unique index on live
 * unread rows (readAt IS NULL AND archivedAt IS NULL), and inserts a single row.
 * Failures are logged and swallowed — a notification dispatch must never
 * break the writer's request. Mirrors `dispatchLifecycleEvent(..).catch(..)`
 * discipline used elsewhere.
 */

import {
	CATEGORY_TO_TOGGLE,
	db,
	getNotificationPreferences,
	isCategoryEnabled,
	type Notification,
	NotificationCategory,
	NotificationType,
	type Prisma,
} from "@repo/database";
import type { Locale } from "@repo/i18n";
import { logger } from "@repo/logs";
import { sendEmail } from "@repo/mail";
import { setAiUsageThresholdNotifier } from "@repo/payments";
import { toAbsoluteUrl } from "@repo/utils";
import { validatePayload } from "../modules/notifications/lib/payloads";
import { filterAuthorizedMentionRecipients } from "../modules/projects/lib/user-mention";
import { invalidateUnreadCount } from "./notification-cache";
import { dispatchExternalDelivery } from "./notification-delivery";

const SNIPPET_MAX_LENGTH = 280;

export type NotificationSource = {
	projectId?: string;
	storyId?: string;
	taskId?: string;
	commentId?: string;
	documentId?: string;
	actorUserId?: string;
};

export type CreateNotificationArgs = {
	userId: string;
	organizationId: string | null;
	type: NotificationType;
	category: NotificationCategory;
	title: string;
	snippet?: string;
	link?: string;
	iconKey?: string;
	source: NotificationSource;
	payload: Record<string, unknown>;
	dedupeKey?: string;
	/**
	 * Controls deduplication semantics when `dedupeKey` is set.
	 * - `"exact"` (default): rely on the DB partial-unique index; a P2002 on
	 * INSERT coalesces into the existing unread+live row.
	 * - `"unreadOnly"`: a pre-INSERT read checks for an existing unread+live
	 * row and short-circuits before hitting the DB if one exists. Useful for
	 * callers that must distinguish "suppressed" from "inserted" in the
	 * return value (e.g. document-mention hardening).
	 * Has no effect unless `dedupeKey` is also set.
	 */
	dedupePolicy?: "exact" | "unreadOnly";
};

export type CreateNotificationResult =
	| Notification
	| null
	| { skipped: true; reason: "deduped-unread" | "preference-disabled" };

function truncateSnippet(snippet: string | undefined): string | undefined {
	if (!snippet) {
		return snippet;
	}
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Write a single notification row. Self-skips when actor === recipient.
 * Dedup is enforced by a partial unique index on (userId, dedupeKey)
 * WHERE readAt IS NULL — see migration `notification_center`. The race
 * condition in find-then-update is gone: two concurrent writers with the
 * same dedupeKey both INSERT, the loser hits a P2002 unique violation,
 * and we coalesce into the existing unread row.
 * Returns the inserted/updated row, or null on self-skip. Throws only
 * on programmer errors (invalid payload). DB errors propagate to the
 * fan-out helpers, which log and swallow.
 */
export async function createNotification(
	args: CreateNotificationArgs,
): Promise<CreateNotificationResult> {
	if (args.source.actorUserId && args.source.actorUserId === args.userId) {
		return null;
	}

	// Write-time preference filter: suppress in-app notifications whose curated
	// category the recipient has disabled (Notification Center Preferences,
	// AC-4). Account-global — reads the recipient's "" preference row. Existing
	// rows are untouched (AC-5) and re-enabling resumes future events with no
	// backfill (AC-6), because suppression is decided purely at write time.
	// Always-on categories (SYSTEM/BILLING/CONTEXT_INDEXING_*) are absent from
	// CATEGORY_TO_TOGGLE, so we skip the lookup entirely for them.
	//
	// This per-recipient guard is the SINGLE enforcement chokepoint for every
	// in-process `fanOut.*` helper — they all funnel through here, so no caller
	// can bypass it. (One indexed point-lookup per recipient; recipient counts
	// per comment/mention are small.) The in-database / temporal writers that
	// CANNOT reach this helper — pm-conflict, agent-reply, repo-integration,
	// security-scan — re-implement the same check, using the batched
	// `getEnabledRecipientsForCategory` for their multi-recipient fan-outs.
	if (CATEGORY_TO_TOGGLE[args.category]) {
		const flags = await getNotificationPreferences(args.userId);
		if (!isCategoryEnabled(flags, args.category)) {
			return { skipped: true, reason: "preference-disabled" } as const;
		}
	}

	// NOTE: The pre-query and the subsequent INSERT are NOT in a single transaction.
	// A concurrent writer can insert a row between findFirst and create — in that
	// case, this call falls through to the P2002 coalesce path and returns the
	// coalesced Notification rather than { skipped: true }. Callers must therefore
	// treat a non-skipped return as "a notification exists for this key now" and
	// not as "I won the race." This matches the legacy semantics of exact-dedup.
	if (args.dedupeKey && args.dedupePolicy === "unreadOnly") {
		const existingUnread = await db.notification.findFirst({
			where: {
				userId: args.userId,
				dedupeKey: args.dedupeKey,
				readAt: null,
				archivedAt: null,
			},
			select: { id: true },
		});
		if (existingUnread) {
			logger.debug(
				{
					userId: args.userId,
					dedupeKey: args.dedupeKey,
					existingId: existingUnread.id,
				},
				"[notification-service] notification deduped (unreadOnly)",
			);
			return { skipped: true, reason: "deduped-unread" } as const;
		}
	}

	const validatedPayload = validatePayload(
		args.type,
		args.payload,
	) as Prisma.InputJsonValue;
	const snippet = truncateSnippet(args.snippet);

	const createData = {
		userId: args.userId,
		organizationId: args.organizationId,
		type: args.type,
		category: args.category,
		title: args.title,
		snippet,
		link: args.link,
		iconKey: args.iconKey,
		projectId: args.source.projectId,
		storyId: args.source.storyId,
		taskId: args.source.taskId,
		commentId: args.source.commentId,
		documentId: args.source.documentId,
		actorUserId: args.source.actorUserId,
		payload: validatedPayload,
		dedupeKey: args.dedupeKey,
	};

	try {
		const created = await db.notification.create({ data: createData });
		// Invalidate the cached unread count so the next bell poll reflects
		// this row immediately. Failure to invalidate is logged but never
		// surfaced — the 5s TTL bounds staleness regardless.
		void invalidateUnreadCount(args.userId, args.organizationId);
		// Fan out to the recipient's opted-in external channels (email/webhook).
		// Fire-and-forget + swallow: external delivery must never break the
		// writer's request, and in-app delivery already succeeded above. Only
		// fresh inserts dispatch — the P2002 coalesce path below does not, so a
		// re-fired duplicate event doesn't re-send email/webhook.
		void dispatchExternalDelivery(created).catch((error) =>
			logFailure("external-delivery", error),
		);
		return created;
	} catch (error) {
		// Coalesce into the existing unread row on dedup-key collision.
		// Duck-type the Prisma error so we don't pull `Prisma` in as a runtime
		// value (the type-only import keeps tree-shaking + test mocks simple).
		const isUniqueViolation =
			typeof error === "object" &&
			error !== null &&
			(error as { code?: string }).code === "P2002";
		if (args.dedupeKey && isUniqueViolation) {
			await db.notification.updateMany({
				where: {
					userId: args.userId,
					dedupeKey: args.dedupeKey,
					readAt: null,
					archivedAt: null,
				},
				data: {
					title: args.title,
					snippet,
					link: args.link,
					payload: validatedPayload,
					actorUserId: args.source.actorUserId,
				},
			});
			// Coalesce path also invalidates: title/snippet may have changed
			// even though the count did not.
			void invalidateUnreadCount(args.userId, args.organizationId);
			return db.notification.findFirst({
				where: {
					userId: args.userId,
					dedupeKey: args.dedupeKey,
					readAt: null,
					archivedAt: null,
				},
				orderBy: { createdAt: "desc" },
			});
		}
		throw error;
	}
}

function logFailure(scope: string, error: unknown): void {
	logger.warn({ err: error }, `[notification-service] ${scope} failed`);
}

type StoryRefs = { storyId: string; taskId?: undefined };
type TaskRefs = { storyId?: undefined; taskId: string };

type CommentTarget = StoryRefs | TaskRefs;

type CommentMentionArgs = {
	recipientUserIds: string[];
	commentId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	target: CommentTarget;
	link: string;
	snippet: string;
	groupLabel?: string;
};

type CommentReplyArgs = {
	recipientUserIds: string[];
	commentId: string;
	parentCommentId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	target: CommentTarget;
	link: string;
	snippet: string;
};

type AssignmentArgs = {
	recipientUserId: string;
	storyId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	link: string;
	itemTitle: string;
	previousAssigneeId?: string | null;
};

type DocumentMentionRecipient = { userId: string; anchorId: string };

type DocumentMentionArgs = {
	recipients: DocumentMentionRecipient[];
	documentId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	documentTitle: string;
	link: string;
	/** Per-anchor context snippet; falls back to documentTitle if missing/empty. */
	snippetByAnchor: Record<string, string>;
	groupLabel?: string;
};

export type StoryStatusChangedArgs = {
	storyId: string;
	storyTitle: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	previousStatusId: string | null;
	previousStatusName: string | null;
	statusId: string;
	statusName: string;
	isFinal: boolean;
	requiresApproval: boolean;
	recipientUserIds: string[];
	link: string;
};

export type AgentReplyReadyArgs = {
	/**
	 * Stable identifier for the agent run / chat reply. Used as the dedupe key
	 * so completion firing twice (e.g. workflow replay + late save) produces
	 * at most one unread row. For AiChat-backed flows, callers pass the chat
	 * workflow id (one workflow per assistant turn).
	 */
	runId: string;
	recipientUserId: string;
	organizationId: string | null;
	agentName: string;
	/** Full final assistant message text. Truncated + whitespace-collapsed before persisting. */
	finalMessage: string;
	link: string;
	projectId: string;
	storyId?: string;
	taskId?: string;
	/**
	 * Optional presence guard. If it returns truthy, the notification is
	 * suppressed (the user is actively viewing the conversation, so the bell
	 * would be redundant). Errors thrown from this callback are swallowed and
	 * the notification is sent — duplicate visibility is preferable to missed
	 * visibility.
	 */
	isUserPresent?: () => boolean | Promise<boolean>;
};

const AGENT_REPLY_SNIPPET_MAX = 140;

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

export type PmSyncConflictArgs = {
	storyId: string;
	storyTitle: string;
	projectId: string;
	organizationId: string | null;
	/** Null when the conflict was detected by background polling (no acting user). */
	actorUserId: string | null;
	pendingStateChangeId: string;
	previousState: string;
	newState: string;
	recipientUserIds: string[];
	link: string;
};

export type AiUsageThresholdArgs = {
	limitId: string;
	/** XOR with `userId` per CLAUDE.md tenant pattern. */
	organizationId: string | null;
	/** XOR with `organizationId`. NULL on org-scoped limits. */
	userId: string | null;
	/** Always notified per. */
	createdById: string;
	/**
	 * ISO-formatted first instant of the window the threshold crossed in.
	 * Forms part of the dedup key — same window + same threshold + same
	 * recipient produces at most one notification.
	 */
	windowStartIso: string;
	/** 80 = warning, 100 = reached. */
	threshold: 80 | 100;
	dimension: "TOKENS" | "SPEND_USD";
	window: "HOURLY" | "DAILY" | "WEEKLY" | "MONTHLY";
	/** HARD = blocking; SOFT = informational. Affects the email copy only. */
	enforcement: "HARD" | "SOFT";
	used: bigint;
	max: bigint;
	limitName: string | null;
};

export type PromptNominationPendingArgs = {
	/** Resolved by `listPromptNominationReviewers` — only people who can decide. */
	recipients: ReadonlyArray<{
		userId: string;
		organizationId: string | null;
	}>;
	nominationId: string;
	promptId: string;
	promptName: string;
	targetScope: "SYSTEM" | "ORG";
	/** Human name for the first action, plus a count when there are more. */
	actionLabel: string;
	actionCount: number;
	/** The AI change summary, or the fallback when none could be produced. */
	changeSummary?: string | null;
	summaryDegraded: boolean;
	/** Where the reviewer decides it. */
	link: string;
	nominatedByName?: string | null;
	actorUserId: string;
};

export type PromptDefaultUpdatedArgs = {
	/** Resolved by `listPromptDefaultRecipients`, framing included. */
	recipients: ReadonlyArray<{
		userId: string;
		organizationId: string | null;
		hasOwnOverride: boolean;
	}>;
	/** Which tier moved. USER changes affect only the person who made them. */
	scope: "SYSTEM" | "ORG";
	promptId: string;
	promptName: string;
	targetKey: string;
	documentType: string;
	storyKind?: string | null;
	/** Human name for the action, e.g. "Test Case Drafter". */
	actionLabel: string;
	/** The version's change note — FR7's changelog. Absent is normal. */
	changeNote?: string | null;
	/** Context-relative deep-link into the action's catalog entry. */
	link: string;
	actorUserId: string;
};

export type StorySharedArgs = {
	recipientUserIds: string[];
	storyId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	/** Feature title shown as context in the notification. */
	featureTitle: string;
	/** `F-XXX` identifier when the story has one; null falls back to "a feature". */
	identifier: string | null;
	/** Context-relative deep-link, e.g. `projects/{projectId}/stories/{storyId}`. */
	link: string;
	/** Optional author note; surfaced as the row snippet when present. */
	message?: string;
};

export type SubscriptionUpdateArgs = {
	subjectType: "DOCUMENT" | "FEATURE";
	subjectId: string;
	projectId: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	/** Human-readable item title; rendered as `{actorName} updated {title}`. */
	title: string;
	link: string;
	/** What changed — lets the inbox renderer distinguish an edit from a move. */
	changeKind: "content" | "status" | "stage";
};

function shouldNotifyOnStatus(args: {
	statusName: string;
	isFinal: boolean;
	requiresApproval: boolean;
}): boolean {
	if (args.isFinal || args.requiresApproval) {
		return true;
	}
	return /blocked/i.test(args.statusName);
}

function isStoryTarget(t: CommentTarget): t is StoryRefs {
	return typeof t.storyId === "string";
}

/**
 * Resolve the deep-link to the AI Usage page for the given limit. In org
 * context the URL embeds the org slug (`/app/{slug}/settings/usage`); in
 * personal context it omits the slug (`/app/settings/usage`). The slug is
 * looked up via Prisma; if it is missing (e.g. an org without a slug, or
 * the org row has been deleted), the helper falls back to the personal
 * shape with the limitId still attached so the recipient at least lands on
 * a page that can show the limit. "Link".
 *
 * Returns a RELATIVE path on purpose — that is what the in-app notification
 * row needs for Next.js routing. Do not make this absolute: off-app consumers
 * (email) are the exception, and they wrap the result in `toAbsoluteUrl` at
 * their own call site.
 */
async function buildManageLimitsUrlInternal(
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

/**
 * Format a BigInt usage value for the notification snippet. Tokens render
 * as plain integers with thousands separators (`8,200`); spend renders as
 * USD with two decimals (`$42.18`). The spend value is stored as
 * micro-USD (1e-6 USD) per the AiUsageLimitCounter schema.
 */
function formatUsageDisplay(
	value: bigint,
	dimension: "TOKENS" | "SPEND_USD",
): string {
	if (dimension === "SPEND_USD") {
		// micro-USD → cents (rounded down) → dollars-with-cents string.
		// Avoid Number coercion of the BigInt directly because monthly
		// spend counters can exceed Number.MAX_SAFE_INTEGER in micro-USD.
		// `BigInt(..)` literals are used in place of `10_000n` because
		// the @repo/api tsconfig targets ES6.
		const microPerCent = BigInt(10_000); // 10_000 micro-USD = 1 cent
		const oneHundred = BigInt(100);
		const cents = value / microPerCent;
		const dollars = cents / oneHundred;
		const remainderCents = cents - dollars * oneHundred;
		const padded = remainderCents.toString().padStart(2, "0");
		return `$${dollars.toLocaleString("en-US")}.${padded}`;
	}
	// Tokens — manual thousands separator on the BigInt string so we never
	// lose precision via Number coercion. Caller appends the unit.
	return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Build the snippet shown in the inbox row: "8,200 / 10,000 tokens used" or "$42.18 / $100.00 used". */
function formatUsageSnippet(
	used: bigint,
	max: bigint,
	dimension: "TOKENS" | "SPEND_USD",
): string {
	const usedDisplay = formatUsageDisplay(used, dimension);
	const maxDisplay = formatUsageDisplay(max, dimension);
	if (dimension === "TOKENS") {
		return `${usedDisplay} / ${maxDisplay} tokens used`;
	}
	return `${usedDisplay} / ${maxDisplay} used`;
}

/**
 * Resolve the recipient list for an AI usage threshold notification.
 * Personal limit (userId set) → just the limit's owner.
 * Org limit (organizationId set) → the limit's creator plus every member
 * of the org with role `owner` or `admin`. The result is de-duplicated
 * because the creator is often already an admin.
 * Returns objects (not just IDs) so the email step has the recipient's
 * email + locale without a second round-trip.
 */
async function resolveAiUsageThresholdRecipients(args: {
	organizationId: string | null;
	userId: string | null;
	createdById: string;
}): Promise<{ id: string; email: string; locale: string | null }[]> {
	if (args.userId) {
		// Personal limit: notify the owner only. `createdById` always equals
		// `userId` for personal limits but we look up by `userId` to keep the
		// lookup explicit.
		const owner = await db.user.findUnique({
			where: { id: args.userId },
			select: { id: true, email: true, locale: true },
		});
		return owner ? [owner] : [];
	}

	if (!args.organizationId) {
		// Should never happen — XOR pattern requires one tenant key. If the
		// caller gives us neither, fall back to just the creator so we don't
		// silently drop the notification.
		const creator = await db.user.findUnique({
			where: { id: args.createdById },
			select: { id: true, email: true, locale: true },
		});
		return creator ? [creator] : [];
	}

	// Org limit: creator + all owner/admin members. Single round-trip via
	// `db.member.findMany` with an `include` for the user fields the email
	// step needs.
	const adminMembers = await db.member.findMany({
		where: {
			organizationId: args.organizationId,
			role: { in: ["owner", "admin"] },
		},
		select: {
			user: { select: { id: true, email: true, locale: true } },
		},
	});
	const creator = await db.user.findUnique({
		where: { id: args.createdById },
		select: { id: true, email: true, locale: true },
	});

	const recipientsById = new Map<
		string,
		{ id: string; email: string; locale: string | null }
	>();
	if (creator) {
		recipientsById.set(creator.id, creator);
	}
	for (const m of adminMembers) {
		if (!recipientsById.has(m.user.id)) {
			recipientsById.set(m.user.id, m.user);
		}
	}
	return Array.from(recipientsById.values());
}

export const fanOut = {
	async mention(args: CommentMentionArgs): Promise<void> {
		const isStory = isStoryTarget(args.target);
		const type = isStory
			? NotificationType.STORY_MENTION
			: NotificationType.TASK_MENTION;
		const recipients = Array.from(new Set(args.recipientUserIds)).filter(
			(id) => id !== args.actorUserId,
		);
		await Promise.all(
			recipients.map(async (userId) => {
				try {
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type,
						category: NotificationCategory.MENTION,
						title: args.groupLabel
							? `${args.actorName} mentioned @${args.groupLabel}`
							: `${args.actorName} mentioned you`,
						snippet: args.snippet,
						link: args.link,
						source: {
							projectId: args.projectId,
							storyId: args.target.storyId,
							taskId: args.target.taskId,
							commentId: args.commentId,
							actorUserId: args.actorUserId,
						},
						payload: {
							commentId: args.commentId,
							storyId: args.target.storyId,
							taskId: args.target.taskId,
							projectId: args.projectId,
							mentionedByUserId: args.actorUserId,
							snippet: args.snippet,
						},
						dedupeKey: `mention:${args.commentId}:${userId}`,
					});
				} catch (error) {
					logFailure("fanOut.mention", error);
				}
			}),
		);
	},

	async reply(args: CommentReplyArgs): Promise<void> {
		const isStory = isStoryTarget(args.target);
		const type = isStory
			? NotificationType.STORY_COMMENT_REPLY
			: NotificationType.TASK_COMMENT_REPLY;
		const recipients = Array.from(new Set(args.recipientUserIds)).filter(
			(id) => id !== args.actorUserId,
		);
		await Promise.all(
			recipients.map(async (userId) => {
				try {
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type,
						category: NotificationCategory.REPLY,
						title: `${args.actorName} replied`,
						snippet: args.snippet,
						link: args.link,
						source: {
							projectId: args.projectId,
							storyId: args.target.storyId,
							taskId: args.target.taskId,
							commentId: args.commentId,
							actorUserId: args.actorUserId,
						},
						payload: {
							commentId: args.commentId,
							parentCommentId: args.parentCommentId,
							storyId: args.target.storyId,
							taskId: args.target.taskId,
							projectId: args.projectId,
							repliedByUserId: args.actorUserId,
							snippet: args.snippet,
						},
						dedupeKey: `reply:${args.parentCommentId}:${userId}`,
					});
				} catch (error) {
					logFailure("fanOut.reply", error);
				}
			}),
		);
	},

	async documentMention(args: DocumentMentionArgs): Promise<void> {
		const seenRecipients = new Set<string>();
		const filtered = args.recipients.filter((r) => {
			if (r.userId === args.actorUserId) {
				return false;
			}
			if (seenRecipients.has(r.userId)) {
				return false;
			}
			seenRecipients.add(r.userId);
			return true;
		});
		await Promise.all(
			filtered.map(async ({ userId, anchorId }) => {
				try {
					const snippet =
						args.snippetByAnchor[anchorId]?.trim() ||
						args.documentTitle;
					// Anchor invariant: stored as `m_<rand>` in HTML, surfaced in URL
					// fragment as `#m-<rand>` for cleanliness; strip the leading `m_`.
					const urlAnchor = anchorId.replace(/^m_/, "");
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type: NotificationType.DOCUMENT_MENTION,
						category: NotificationCategory.MENTION,
						title: args.groupLabel
							? `${args.actorName} mentioned @${args.groupLabel} in ${args.documentTitle}`
							: `${args.actorName} mentioned you in ${args.documentTitle}`,
						snippet,
						link: `${args.link}#m-${urlAnchor}`,
						source: {
							projectId: args.projectId,
							documentId: args.documentId,
							actorUserId: args.actorUserId,
						},
						payload: {
							documentId: args.documentId,
							projectId: args.projectId,
							mentionedByUserId: args.actorUserId,
							mentionAnchorId: anchorId,
							snippet,
						},
						dedupeKey: `docmention:${args.documentId}:${userId}`,
						dedupePolicy: "unreadOnly",
					});
				} catch (error) {
					logFailure("fanOut.documentMention", error);
				}
			}),
		);
	},

	async storyStatusChanged(args: StoryStatusChangedArgs): Promise<void> {
		if (!shouldNotifyOnStatus(args)) {
			return;
		}
		const recipients = Array.from(new Set(args.recipientUserIds)).filter(
			(id) => id && id !== args.actorUserId,
		);
		await Promise.all(
			recipients.map(async (userId) => {
				try {
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type: NotificationType.STORY_STATUS_CHANGED,
						category: NotificationCategory.STATUS,
						title: `${args.actorName} moved "${args.storyTitle}" to ${args.statusName}`,
						snippet: args.previousStatusName
							? `${args.previousStatusName} → ${args.statusName}`
							: args.statusName,
						link: args.link,
						source: {
							projectId: args.projectId,
							storyId: args.storyId,
							actorUserId: args.actorUserId,
						},
						payload: {
							storyId: args.storyId,
							projectId: args.projectId,
							previousStatusId: args.previousStatusId,
							previousStatusName: args.previousStatusName,
							statusId: args.statusId,
							statusName: args.statusName,
							movedByUserId: args.actorUserId,
						},
						dedupeKey: `status:${args.storyId}:${args.statusId}`,
					});
				} catch (error) {
					logFailure("fanOut.storyStatusChanged", error);
				}
			}),
		);
	},

	/**
	 * Notify every opt-in subscriber of a document/feature when it changes
	 * (real content edit or status/stage move). Cross-user read by subject —
	 * loads ALL subscriber rows regardless of tenant context, then narrows to
	 * those still on the project via `filterAuthorizedMentionRecipients` (a
	 * stale subscription must not leak activity to someone who lost access).
	 * The actor is self-skipped inside `createNotification`; the per-subscriber
	 * `dedupeKey` coalesces a rapid edit→status→stage burst into a single
	 * unread row. Category SUBSCRIPTION is always-on — the only opt-out is to
	 * unsubscribe (delete the row). Best-effort: per-recipient failures are
	 * logged and swallowed, never surfaced to the writer's request.
	 */
	async subscriptionUpdate(args: SubscriptionUpdateArgs): Promise<void> {
		const subscribers = await db.subscription.findMany({
			where: { subjectType: args.subjectType, subjectId: args.subjectId },
			select: { userId: true },
		});
		const candidateIds = Array.from(
			new Set(subscribers.map((s) => s.userId)),
		).filter((id) => id !== args.actorUserId);
		if (candidateIds.length === 0) {
			return;
		}
		const authorized = await filterAuthorizedMentionRecipients(
			candidateIds,
			args.projectId,
			args.organizationId,
		);
		const type =
			args.subjectType === "DOCUMENT"
				? NotificationType.DOCUMENT_UPDATED
				: NotificationType.FEATURE_UPDATED;
		await Promise.all(
			authorized.map(async (userId) => {
				try {
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type,
						category: NotificationCategory.SUBSCRIPTION,
						title: `${args.actorName} updated ${args.title}`,
						link: args.link,
						source: {
							projectId: args.projectId,
							documentId:
								args.subjectType === "DOCUMENT"
									? args.subjectId
									: undefined,
							storyId:
								args.subjectType === "FEATURE"
									? args.subjectId
									: undefined,
							actorUserId: args.actorUserId,
						},
						payload: {
							subjectType: args.subjectType,
							subjectId: args.subjectId,
							projectId: args.projectId,
							actorUserId: args.actorUserId,
							changeKind: args.changeKind,
						},
						dedupeKey: `sub:${args.subjectType}:${args.subjectId}:${userId}`,
					});
				} catch (error) {
					logFailure("fanOut.subscriptionUpdate", error);
				}
			}),
		);
	},

	async pmSyncConflict(args: PmSyncConflictArgs): Promise<void> {
		const recipients = Array.from(new Set(args.recipientUserIds)).filter(
			(id) => id && id !== args.actorUserId,
		);
		await Promise.all(
			recipients.map(async (userId) => {
				try {
					await createNotification({
						userId,
						organizationId: args.organizationId,
						type: NotificationType.PM_SYNC_CONFLICT,
						category: NotificationCategory.PROJECT,
						title: `Conflict detected on "${args.storyTitle}"`,
						snippet: `${args.previousState} → ${args.newState}`,
						link: args.link,
						source: {
							projectId: args.projectId,
							storyId: args.storyId,
							actorUserId: args.actorUserId ?? undefined,
						},
						payload: {
							storyId: args.storyId,
							projectId: args.projectId,
							pendingStateChangeId: args.pendingStateChangeId,
							previousState: args.previousState,
							newState: args.newState,
						},
						dedupeKey: `pmConflict:${args.storyId}:${args.pendingStateChangeId}`,
					});
				} catch (error) {
					logFailure("fanOut.pmSyncConflict", error);
				}
			}),
		);
	},

	/**
	 * Emit one AGENT_REPLY_READY notification to the run's initiating user
	 * when an agent finishes a reply. Single-recipient, best-effort presence
	 * suppression, dedupe key `agentReply:${runId}`.
	 * The payload reuses the existing `AGENT_REPLY_READY` schema in
	 * `payloads.ts`. `commentId` is set to `runId` to satisfy the schema's
	 * required field — if the schema is loosened later, drop it.
	 */
	async agentReplyReady(args: AgentReplyReadyArgs): Promise<void> {
		try {
			if (args.isUserPresent) {
				try {
					if (await args.isUserPresent()) {
						return;
					}
				} catch {
					// Presence check failure is non-fatal — fall through and notify.
					// Duplicate visibility is preferable to missed visibility.
				}
			}
			const snippet = collapseWhitespace(args.finalMessage).slice(
				0,
				AGENT_REPLY_SNIPPET_MAX,
			);
			await createNotification({
				userId: args.recipientUserId,
				organizationId: args.organizationId,
				type: NotificationType.AGENT_REPLY_READY,
				category: NotificationCategory.AGENT,
				title: `${args.agentName} finished a reply`,
				snippet,
				link: args.link,
				source: {
					projectId: args.projectId,
					storyId: args.storyId,
					taskId: args.taskId,
					actorUserId: undefined,
				},
				payload: {
					projectId: args.projectId,
					storyId: args.storyId,
					taskId: args.taskId,
					commentId: args.runId,
					snippet,
				},
				dedupeKey: `agentReply:${args.runId}`,
			});
		} catch (error) {
			logFailure("fanOut.agentReplyReady", error);
		}
	},

	async assigned(args: AssignmentArgs): Promise<void> {
		if (args.recipientUserId === args.actorUserId) {
			return;
		}
		try {
			await createNotification({
				userId: args.recipientUserId,
				organizationId: args.organizationId,
				type: NotificationType.STORY_ASSIGNED,
				category: NotificationCategory.ASSIGNMENT,
				title: `${args.actorName} assigned you`,
				snippet: args.itemTitle,
				link: args.link,
				source: {
					projectId: args.projectId,
					storyId: args.storyId,
					actorUserId: args.actorUserId,
				},
				payload: {
					storyId: args.storyId,
					projectId: args.projectId,
					assignedByUserId: args.actorUserId,
					previousAssigneeId: args.previousAssigneeId ?? null,
				},
				dedupeKey: `assigned:${args.storyId}:${args.recipientUserId}`,
			});
		} catch (error) {
			logFailure("fanOut.assigned", error);
		}
	},

	/**
	 * Emit one STORY_SHARED notification per recipient when a user tags project
	 * members from the feature editor's Notify action. Multi-recipient, mirrors
	 * `fanOut.mention`: recipients are de-duplicated and the actor is filtered
	 * out (also self-skipped inside `createNotification`). Category MENTION is
	 * reused (the inbox picks a share glyph via a per-type icon override). The
	 * per-recipient dedupe key collapses an accidental double-submit within the
	 * 60s unread window into one row; a later intentional re-share creates a
	 * fresh row once the earlier one is read/archived. Best-effort — a
	 * per-recipient failure is logged and swallowed, never breaking the request.
	 *
	 * Returns the number of notification rows actually written, so the caller
	 * reports a truthful count. A recipient is NOT counted when the write is
	 * self-skipped, coalesced/suppressed by dedupe or preference
	 * (`createNotification` returns null / `{ skipped }`), or the write throws
	 * (caught below). This makes a systemic failure — e.g. a missing enum
	 * migration — surface as a 0 count instead of a false "notified N".
	 */
	/**
	 * A tier's default prompt for an action was published or changed.
	 *
	 * Fizzy #2068 FR6-FR8. The recipient list and its framing come from
	 * `listPromptDefaultRecipients`; this only writes the rows.
	 *
	 * Two framings, because they are different messages. A recipient whose own
	 * override still wins is told an improvement is available — nothing moved
	 * under them and nothing is required. Everyone else is told what they now
	 * get. Both link into the catalog entry for the action, which is where FR8's
	 * "switch my configuration" lives.
	 *
	 * The changelog is the version's own change note (FR7). No note is not an
	 * error — plenty of edits do not carry one — so the snippet falls back to
	 * naming the prompt rather than rendering an empty line.
	 */
	/**
	 * Someone proposed a prompt as a shared default (FR16).
	 *
	 * Only the admins who can actually decide it are told — the same authority
	 * the approve procedure enforces — because a notification whose only
	 * possible outcome is a permission error is worse than none.
	 *
	 * The summary rides along so the bell row is already useful, and carries
	 * whether it is degraded: a model's reading of both prompts and a plain
	 * character count read identically, and a reviewer weighs them differently.
	 *
	 * Keyed per nomination, not per prompt: two proposals of the same prompt for
	 * different actions are two decisions, and collapsing them would hide one.
	 */
	async promptNominationPending(
		args: PromptNominationPendingArgs,
	): Promise<number> {
		const tierLabel =
			args.targetScope === "SYSTEM" ? "a universal" : "an organization";
		const extra =
			args.actionCount > 1 ? ` and ${args.actionCount - 1} more` : "";
		const summary = args.changeSummary?.trim();

		const results = await Promise.all(
			args.recipients.map(async (recipient) => {
				try {
					const result = await createNotification({
						userId: recipient.userId,
						organizationId: recipient.organizationId,
						type: NotificationType.PROMPT_NOMINATION_PENDING,
						// Same AGENT category as the default-changed message, so
						// muting agent notifications mutes the whole topic.
						category: NotificationCategory.AGENT,
						title: `${
							args.nominatedByName ?? "Someone"
						} proposed ${tierLabel} default prompt`,
						snippet:
							summary ??
							`${args.promptName} for ${args.actionLabel}${extra}.`,
						link: args.link,
						source: { actorUserId: args.actorUserId },
						payload: {
							nominationId: args.nominationId,
							promptId: args.promptId,
							promptName: args.promptName,
							targetScope: args.targetScope,
							actionCount: args.actionCount,
							summaryDegraded: args.summaryDegraded,
						},
						dedupeKey: `promptNomination:${args.nominationId}:${recipient.userId}`,
					});
					return result !== null && !("skipped" in result);
				} catch (error) {
					logFailure("fanOut.promptNominationPending", error);
					return false;
				}
			}),
		);

		return results.filter(Boolean).length;
	},

	async promptDefaultUpdated(
		args: PromptDefaultUpdatedArgs,
	): Promise<number> {
		const tierLabel =
			args.scope === "SYSTEM" ? "Universal" : "Organization";
		const note = args.changeNote?.trim();

		const results = await Promise.all(
			args.recipients.map(async (recipient) => {
				try {
					const result = await createNotification({
						userId: recipient.userId,
						organizationId: recipient.organizationId,
						type: NotificationType.PROMPT_DEFAULT_UPDATED,
						// AGENT maps to the existing `aiAgent` preference, so a
						// user who muted agent notifications is not told about
						// the prompts those agents run — no new setting needed.
						category: NotificationCategory.AGENT,
						title: recipient.hasOwnOverride
							? `An improvement is available for ${args.actionLabel}`
							: `${tierLabel} prompt updated for ${args.actionLabel}`,
						snippet:
							note ??
							(recipient.hasOwnOverride
								? `${args.promptName} changed. Your own prompt is still in use.`
								: `${args.promptName} is now the ${tierLabel.toLowerCase()} default.`),
						link: args.link,
						source: { actorUserId: args.actorUserId },
						payload: {
							promptId: args.promptId,
							promptName: args.promptName,
							scope: args.scope,
							targetKey: args.targetKey,
							documentType: args.documentType,
							storyKind: args.storyKind ?? null,
							// Lets the reader see this is informational without
							// parsing the title.
							informationalOnly: recipient.hasOwnOverride,
						},
						// One message per user per prompt per action. A second
						// edit to the same prompt coalesces rather than filling
						// the bell with near-identical rows.
						dedupeKey: `promptDefault:${args.promptId}:${args.targetKey}:${args.documentType}:${recipient.userId}`,
					});
					return result !== null && !("skipped" in result);
				} catch (error) {
					logFailure("fanOut.promptDefaultUpdated", error);
					return false;
				}
			}),
		);

		return results.filter(Boolean).length;
	},

	async storyShared(args: StorySharedArgs): Promise<number> {
		const recipients = Array.from(new Set(args.recipientUserIds)).filter(
			(id) => id && id !== args.actorUserId,
		);
		const trimmedMessage = args.message?.trim() || undefined;
		// Drop the odd "shared a feature · Title" phrasing when the story has no
		// F-XXX identifier yet — just "shared Title".
		const title = args.identifier
			? `${args.actorName} shared ${args.identifier} · ${args.featureTitle}`
			: `${args.actorName} shared ${args.featureTitle}`;
		const results = await Promise.all(
			recipients.map(async (userId) => {
				try {
					const result = await createNotification({
						userId,
						organizationId: args.organizationId,
						type: NotificationType.STORY_SHARED,
						category: NotificationCategory.MENTION,
						title,
						snippet: trimmedMessage ?? args.featureTitle,
						link: args.link,
						source: {
							projectId: args.projectId,
							storyId: args.storyId,
							actorUserId: args.actorUserId,
						},
						payload: {
							storyId: args.storyId,
							projectId: args.projectId,
							sharedByUserId: args.actorUserId,
							message: trimmedMessage,
						},
						dedupeKey: `storyShared:${args.storyId}:${userId}`,
					});
					// A written row is a Notification object; null (self-skip) and
					// `{ skipped }` (dedupe/preference) do not count as delivered.
					return result !== null && !("skipped" in result);
				} catch (error) {
					logFailure("fanOut.storyShared", error);
					return false;
				}
			}),
		);
		return results.filter(Boolean).length;
	},

	/**
	 * Emit one notification per recipient when an AI usage limit crosses
	 * the 80% (warning) or 100% (reached) threshold. The dedup key
	 * `aiUsageLimit:{limitId}:{windowStartIso}:{threshold}` collapses
	 * concurrent threshold-crosses for the same recipient into a single
	 * row via the `Notification.dedupeKey` partial unique index, so each
	 * window emits at most one warn + one reached per recipient (Decision
	 * #5 /).
	 * Recipient resolution per: personal limit notifies the
	 * owner only; org limit notifies the creator + every owner/admin
	 * member, de-duplicated.
	 * Each recipient also receives an email via `sendEmail`. Email
	 * failures are logged but never abort the in-app notification — the
	 * notification row is the source of truth.
	 */
	async aiUsageThreshold(args: AiUsageThresholdArgs): Promise<void> {
		const type =
			args.threshold === 100
				? NotificationType.AI_USAGE_LIMIT_REACHED
				: NotificationType.AI_USAGE_LIMIT_WARNING;

		logger.warn(
			{
				limitId: args.limitId,
				threshold: args.threshold,
				dimension: args.dimension,
				window: args.window,
				enforcement: args.enforcement,
				organizationId: args.organizationId,
				userId: args.userId,
			},
			`[notification-service] aiUsageThreshold ${args.threshold}% crossed`,
		);

		let recipients: { id: string; email: string; locale: string | null }[];
		try {
			recipients = await resolveAiUsageThresholdRecipients({
				organizationId: args.organizationId,
				userId: args.userId,
				createdById: args.createdById,
			});
		} catch (error) {
			logFailure("fanOut.aiUsageThreshold.resolveRecipients", error);
			return;
		}

		if (recipients.length === 0) {
			logger.warn(
				{
					limitId: args.limitId,
					threshold: args.threshold,
					createdById: args.createdById,
				},
				"[notification-service] aiUsageThreshold resolved zero recipients — skipping",
			);
			return;
		}

		const link = await buildManageLimitsUrlInternal(
			args.organizationId,
			args.limitId,
		);

		// Raw BigInt-as-string for the JSON payload (precision-preserving;
		// renderer reformats per its own locale).
		const usedStr = args.used.toString();
		const maxStr = args.max.toString();
		// Pre-formatted display strings for the email body. Done once here
		// so the template can stay rendering-only (no BigInt math).
		const usedDisplay = formatUsageDisplay(args.used, args.dimension);
		const maxDisplay = formatUsageDisplay(args.max, args.dimension);
		const dedupeKey = `aiUsageLimit:${args.limitId}:${args.windowStartIso}:${args.threshold}`;

		const titlePrefix =
			args.threshold === 100
				? "AI usage limit reached"
				: "AI usage at 80%";
		const title = args.limitName
			? `${titlePrefix} — ${args.limitName}`
			: titlePrefix;
		const snippet = formatUsageSnippet(args.used, args.max, args.dimension);

		await Promise.all(
			recipients.map(async (recipient) => {
				try {
					await createNotification({
						userId: recipient.id,
						organizationId: args.organizationId,
						type,
						category: NotificationCategory.BILLING,
						title,
						snippet,
						link,
						source: {
							// Threshold notifications have no actor — they are
							// system-driven. Leaving actorUserId undefined also
							// keeps the self-skip from suppressing a recipient
							// who is also the (notional) actor.
							actorUserId: undefined,
						},
						payload: {
							limitId: args.limitId,
							limitName: args.limitName,
							threshold: args.threshold,
							dimension: args.dimension,
							window: args.window,
							used: usedStr,
							max: maxStr,
						},
						dedupeKey,
					});
				} catch (error) {
					logFailure("fanOut.aiUsageThreshold", error);
				}

				// Email is best-effort. A failure here must not abort the
				// in-app notification (already written above) — the inbox
				// row is the source of truth
				try {
					await sendEmail({
						to: recipient.email,
						templateId:
							args.threshold === 100
								? "aiUsageLimitReached"
								: "aiUsageLimitWarning",
						context: {
							limitName: args.limitName,
							dimension: args.dimension,
							window: args.window,
							// Pre-formatted display strings — the template
							// keeps no BigInt math, just renders the value.
							used: usedDisplay,
							max: maxDisplay,
							enforcement: args.enforcement,
							// Absolute, unlike the in-app `link` above: an
							// email client has no origin to resolve a relative
							// path against, so `/app/...` renders as a dead
							// button and a dead copy-paste fallback.
							manageLimitsUrl: toAbsoluteUrl(link),
						},
						// recipient.locale is the user's preferred locale
						// (Better Auth stores it as a string column on User).
						// `sendEmail` falls back to the default locale when
						// undefined, so we coalesce null → undefined here.
						...(recipient.locale
							? { locale: recipient.locale as Locale }
							: {}),
					});
				} catch (error) {
					logFailure("fanOut.aiUsageThreshold.email", error);
				}
			}),
		);
	},
};

// Self-register the AI usage-threshold notifier in `@repo/payments` so
// `recordAiUsageAndCheckOverage` dispatches notifications via this module
// without `@repo/payments` ever importing from `@repo/api` (which would
// form a workspace cycle: api → payments → api).
setAiUsageThresholdNotifier(fanOut.aiUsageThreshold);
