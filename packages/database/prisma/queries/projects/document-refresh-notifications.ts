/**
 * Living-Documents auto-refresh subscriber notification dispatch.
 *
 * Mirrors `fanOut.subscriptionUpdate` in `@repo/api/lib/notification-service`,
 * but lives in `@repo/database` so it can be invoked from `@repo/temporal`
 * activities (`@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import the API-side helper without a circular dependency). Same pattern as
 * `repo-integration-notifications.ts`, `pm-conflict-notifications.ts`, and
 * `agent-reply-notifications.ts`.
 *
 * Emitted by the document auto-refresh job
 * (`packages/temporal/src/activities/document-refresh/run-document-refresh.ts`)
 * AFTER a new `DocumentVersion` has been committed. Recipients are the people
 * who explicitly opted in to watch the document (`Subscription` rows with
 * `subjectType: DOCUMENT`), narrowed to those who still have access to the
 * owning project.
 *
 * Kept in lock-step with `fanOut.subscriptionUpdate` so the inbox renders an
 * AI refresh exactly like a human edit:
 * - `NotificationType.DOCUMENT_UPDATED` / `NotificationCategory.SUBSCRIPTION`
 * - payload matching the registered `subscriptionUpdateBase` schema in
 *   `@repo/api` `modules/notifications/lib/payloads.ts`
 * - dedupe key `sub:DOCUMENT:${documentId}:${userId}` — the live-unread partial
 *   unique index therefore coalesces two refreshes of the same document (or a
 *   refresh landing on top of an unread human edit) into ONE unread row.
 *
 * The one deliberate divergence is the ACTOR: a refresh is committed by the AI
 * agent, not a person. The notification's `actorUserId` COLUMN stays null (it is
 * an FK to `user`, and the agent has no row); the sentinel travels in the
 * payload, and the title names the agent instead of "A teammate".
 *
 * Never throws — a failed notification cannot fail a refresh that already
 * committed. Recipient resolution, the preference lookup, and every individual
 * write are wrapped; P2002 (dedupe-key collision) is swallowed as a successful
 * coalesce.
 */
import {
	AI_REFRESH_AUTHOR_ID,
	AI_REFRESH_AUTHOR_NAME,
} from "@repo/utils/document-version-author";
import { db, NotificationCategory, NotificationType } from "../../client";
import { getEnabledRecipientsForCategory } from "../notification-preferences";
import { hasProjectAccess } from "./projects";

/**
 * `DocumentVersion.changedBy` sentinel for a version written by the auto-refresh
 * agent, and the display name the version history renders for it.
 *
 * Re-exported (not redefined) from `@repo/utils/document-version-author`, which
 * is the one definition shared by the writer (this file + the refresh activity),
 * the reader (`getDocumentVersions`), and the UI. The notification title and the
 * version-history row therefore always name the agent identically.
 */
export const DOCUMENT_REFRESH_AGENT_ID = AI_REFRESH_AUTHOR_ID;
export const DOCUMENT_REFRESH_AGENT_NAME = AI_REFRESH_AUTHOR_NAME;

const SNIPPET_MAX_LENGTH = 280;

function truncateSnippet(snippet: string): string {
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

export interface CreateDocumentRefreshNotificationsArgs {
	/** The refreshed document — also the `Subscription.subjectId` to fan out on. */
	documentId: string;
	/** Rendered in the notification title. */
	documentTitle: string;
	projectId: string;
	/** Org scope for the notification rows; null in personal-project context. */
	organizationId: string | null;
	/**
	 * Context-relative deep link to the document. No leading slash — the inbox
	 * prepends the notification's own org base (see `resolveNotificationLink`).
	 */
	link: string;
	/**
	 * The refresh's change summary (the model's `summary`, the same string that
	 * lands in `DocumentVersion.changeDescription`). Rendered as the row snippet
	 * when present.
	 */
	summary?: string;
	/**
	 * `proposed` — the refresh produced an update and is waiting for a human to
	 * accept it (the default mode). `committed` — it was applied directly.
	 */
	kind?: "proposed" | "committed";
}

/**
 * Notify a document's subscribers that the auto-refresh agent committed a new
 * version. One `DOCUMENT_UPDATED` row per surviving recipient.
 *
 * Recipients are narrowed in three stages:
 *  1. `Subscription` rows for the document (cross-tenant read by subject — the
 *     sweep has no session), minus the agent sentinel itself.
 *  2. `hasProjectAccess` — a stale subscription must not leak document activity
 *     to someone who has since lost access to the project.
 *  3. `getEnabledRecipientsForCategory` — write-time per-user category
 *     preferences.
 *
 * Never throws.
 */
export async function createDocumentRefreshNotifications(
	args: CreateDocumentRefreshNotificationsArgs,
): Promise<void> {
	try {
		const subscribers = await db.subscription.findMany({
			where: { subjectType: "DOCUMENT", subjectId: args.documentId },
			select: { userId: true },
		});

		// The agent is not a person and cannot hold an inbox — defensive, since
		// nothing writes a Subscription row for the sentinel today.
		const candidateIds = Array.from(
			new Set(subscribers.map((row) => row.userId)),
		).filter((id) => id && id !== DOCUMENT_REFRESH_AGENT_ID);
		if (candidateIds.length === 0) {
			return;
		}

		const authorized = await filterSubscribersWithProjectAccess(
			candidateIds,
			args.projectId,
			args.organizationId,
		);
		if (authorized.length === 0) {
			return;
		}

		// Write-time preference filter (Notification Center Preferences, AC-4).
		// SUBSCRIPTION is an always-on category today (absent from
		// `CATEGORY_TO_TOGGLE` — the opt-out is to unsubscribe), so this is a
		// pass-through; routing through the helper anyway means a future
		// SUBSCRIPTION toggle is honored here for free, exactly as in the other
		// in-database writers.
		const enabled = await getEnabledRecipientsForCategory(
			authorized,
			NotificationCategory.SUBSCRIPTION,
		);
		const allowed = authorized.filter((id) => enabled.has(id));
		if (allowed.length === 0) {
			return;
		}

		const title =
			args.kind === "proposed"
				? `${DOCUMENT_REFRESH_AGENT_NAME} proposed an update to ${args.documentTitle}`
				: `${DOCUMENT_REFRESH_AGENT_NAME} updated ${args.documentTitle}`;
		const snippet = args.summary?.trim()
			? truncateSnippet(args.summary.trim())
			: undefined;

		await Promise.all(
			allowed.map((recipientUserId) =>
				writeRefreshNotificationRow(
					args,
					recipientUserId,
					title,
					snippet,
				),
			),
		);
	} catch (error) {
		// Best-effort: the version is already committed, so a notification
		// failure must not fail the refresh. Log so a sustained failure (DB
		// hiccup during a sweep) is detectable instead of silent.
		console.warn(
			"[DocumentRefreshNotification] subscriber dispatch failed",
			{ documentId: args.documentId, projectId: args.projectId },
			error,
		);
	}
}

/**
 * Keep only the subscribers who can still open the project.
 *
 * `filterAuthorizedMentionRecipients` — the narrowing that
 * `fanOut.subscriptionUpdate` uses — lives in `@repo/api`
 * (`modules/projects/lib/user-mention.ts`) and is therefore unreachable from
 * here without inverting the dependency edge. We use `hasProjectAccess` from
 * this package instead, which is the same intent and STRICTER: it drops an org
 * member who never joined (or was removed from) the project, where the mention
 * filter would keep them. Strictness is the right default for a notification
 * whose deep link would 403 for exactly those users.
 *
 * One `hasProjectAccess` call per subscriber; subscriber lists are small (an
 * explicit per-document opt-in) and this runs in a background sweep, so the
 * per-user call is preferred over re-deriving the access rules here and letting
 * them drift.
 */
async function filterSubscribersWithProjectAccess(
	userIds: string[],
	projectId: string,
	organizationId: string | null,
): Promise<string[]> {
	const results = await Promise.all(
		userIds.map(async (userId) => {
			const allowed = await hasProjectAccess(
				projectId,
				userId,
				organizationId ?? undefined,
			);
			return allowed ? userId : null;
		}),
	);
	return results.filter((id): id is string => id !== null);
}

/**
 * Write one refresh notification row for an already access-checked,
 * preference-checked recipient. P2002 is a successful coalesce (the existing
 * unread row stands); any other error is swallowed so one bad write cannot fail
 * the rest of the fan-out — or the refresh.
 */
async function writeRefreshNotificationRow(
	args: CreateDocumentRefreshNotificationsArgs,
	recipientUserId: string,
	title: string,
	snippet: string | undefined,
): Promise<void> {
	try {
		await db.notification.create({
			data: {
				userId: recipientUserId,
				organizationId: args.organizationId,
				type: NotificationType.DOCUMENT_UPDATED,
				category: NotificationCategory.SUBSCRIPTION,
				title,
				snippet,
				link: args.link,
				projectId: args.projectId,
				documentId: args.documentId,
				// `actorUserId` (the FK column) stays null: the refresh agent has
				// no `user` row. The sentinel lives in the payload instead.
				payload: {
					subjectType: "DOCUMENT",
					subjectId: args.documentId,
					projectId: args.projectId,
					actorUserId: DOCUMENT_REFRESH_AGENT_ID,
					changeKind: "content",
				},
				// The `:ai` suffix is load-bearing. Human document updates use
				// `sub:DOCUMENT:<id>:<user>`, and the notification writer coalesces on
				// that key — so without a distinct bucket, "the AI rewrote your PRD"
				// would be silently swallowed into an unread "Alice updated your PRD"
				// from the day before. The one notification this feature exists to
				// send is exactly the one that would vanish.
				dedupeKey: `sub:DOCUMENT:${args.documentId}:${recipientUserId}:ai`,
			},
		});
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			// Dedupe-key collision on the live-unread partial unique index: a
			// prior unread update for this document already sits in the inbox.
			return;
		}
		console.warn(
			"[DocumentRefreshNotification] notification write failed",
			{ documentId: args.documentId, recipientUserId },
			error,
		);
	}
}
