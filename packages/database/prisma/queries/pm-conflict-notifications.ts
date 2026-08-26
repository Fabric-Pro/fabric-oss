/**
 * PM-sync conflict notification dispatch.
 *
 * Mirrors `fanOut.pmSyncConflict` in `@repo/api/lib/notification-service`, but
 * lives in `@repo/database` so it can be invoked from `@repo/temporal`
 * activities (`@repo/api` depends on `@repo/temporal`, so the activity cannot
 * import the API-side helper without a circular dependency).
 *
 * Generalized (Chunk C) from STORY-only to Epic + Feature + Story so pull-side
 * content drift (and terminal drift) on any entity is notified. Keep the
 * state-conflict path in lock-step with `fanOut.pmSyncConflict`:
 * - same payload shape (`PM_SYNC_CONFLICT` schema in `payloads.ts`)
 * - state-conflict dedupe key `pmConflict:${entityType}:${entityId}:${pendingStateChangeId}`
 * - same title/snippet/link conventions
 *
 * CONTENT_DRIFT is the exception, and only this DB-side helper emits it (the
 * background poll, never the API mirror): it collapses to ONE coalescing row per
 * project per recipient via the `pmContentDrift:${projectId}` dedupe key, so a
 * bulk external edit or a sync content-format change can't flood the owner's bell
 * with one row per item. The per-item detail stays in the review queue.
 */
import { db } from "../client";
import type { PendingPmStateChangeAction } from "../generated/client";
import { getEnabledRecipientsForCategory } from "./notification-preferences";

const SNIPPET_MAX_LENGTH = 280;

function truncateSnippet(snippet: string): string {
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

export type PmConflictNotificationEntityType = "EPIC" | "FEATURE" | "STORY";

export type CreatePmSyncConflictNotificationsArgs = {
	/**
	 * The drifting entity. Defaults to STORY (back-compat with the existing
	 * terminal-drift caller, which passes `storyId`/`storyTitle`).
	 */
	entityType?: PmConflictNotificationEntityType;
	/** Defaults to `storyId`. */
	entityId?: string;
	/** Defaults to `storyTitle`. */
	entityTitle?: string;
	/**
	 * Distinguishes the snippet shape. CONTENT_DRIFT renders a content-changed
	 * message; HIDE/UNHIDE/FLAG_MISSING (or absent) keep the `prev → new` shape.
	 */
	proposedAction?: PendingPmStateChangeAction;
	/** The PM tool label used in content-drift copy (e.g. "Azure DevOps"). */
	pmToolLabel?: string;
	/**
	 * STORY pointer for the read-time RBAC re-check path (nullable, non-FK).
	 * Left null for EPIC/FEATURE — identity is carried in `payload` + `link`.
	 * Retained as the legacy entry point for the terminal-drift caller.
	 */
	storyId?: string;
	storyTitle?: string;
	projectId: string;
	organizationId: string | null;
	/** Null when the conflict was detected by background polling. */
	actorUserId: string | null;
	pendingStateChangeId: string;
	/** Omitted for CONTENT_DRIFT (no state transition — sentinel `"CONTENT"`). */
	previousState?: string;
	newState?: string;
	recipientUserIds: string[];
	link: string;
};

/**
 * Write one PM_SYNC_CONFLICT notification per recipient.
 *
 * - Self-skips actor.
 * - Deduplicates recipient list.
 * - Uses the live-unread partial-unique index for dedupe; ignores P2002.
 * - Never throws — failures are swallowed so the caller (background poll
 *   activity) is not blocked by notification dispatch.
 */
export async function createPmSyncConflictNotifications(
	args: CreatePmSyncConflictNotificationsArgs,
): Promise<void> {
	const entityType = args.entityType ?? "STORY";
	const entityId = args.entityId ?? args.storyId ?? "";
	const entityTitle = args.entityTitle ?? args.storyTitle ?? "";
	const isContentDrift = args.proposedAction === "CONTENT_DRIFT";

	// EPIC/FEATURE leave `storyId` null (it is a nullable, non-FK pointer used
	// only for STORY's read-time RBAC re-check + cascade cleanup). STORY keeps
	// it for that path.
	const storyId = entityType === "STORY" ? (args.storyId ?? entityId) : null;

	const recipients = Array.from(new Set(args.recipientUserIds)).filter(
		(id) => id && id !== args.actorUserId,
	);

	// Write-time preference filter (Notification Center Preferences, AC-4):
	// drop recipients who disabled the Sync/Project category (PROJECT →
	// `syncProject` toggle). One batched query for the whole fan-out;
	// recipients with no preference row stay enabled (default-on).
	const enabledRecipientIds = await getEnabledRecipientsForCategory(
		recipients,
		"PROJECT",
	);
	const allowedRecipients = recipients.filter((id) =>
		enabledRecipientIds.has(id),
	);

	const pmTool = args.pmToolLabel ?? "your PM tool";

	// CONTENT_DRIFT collapses to a SINGLE coalescing notification per project per
	// recipient. A bulk external edit — or a sync content-format change — can flag
	// dozens of items as drifted in one poll cycle; a per-item dedupe key would
	// then dump one bell row per item on the project owner. Keying content drift
	// per project lets the live-unread partial-unique index coalesce all of them
	// into one "content changes to review" ping (the per-item detail still lives in
	// the review queue). State conflicts — an actual external status change — stay
	// per-item: they are rare and individually actionable.
	const dedupeKey = isContentDrift
		? `pmContentDrift:${args.projectId}`
		: `pmConflict:${entityType}:${entityId}:${args.pendingStateChangeId}`;

	const title = isContentDrift
		? `Content changes to review in ${pmTool}`
		: `Conflict detected on "${entityTitle}"`;
	const snippet = truncateSnippet(
		isContentDrift
			? `One or more items were edited in ${pmTool} — open the project to review and reconcile.`
			: `${args.previousState ?? ""} → ${args.newState ?? ""}`,
	);

	// A collapsed content-drift row stands for potentially many items, so it links
	// to the project (where the per-item conflict chips live) rather than to a
	// single story. State-conflict rows keep their precise per-item link.
	const effectiveLink = isContentDrift
		? `projects/${args.projectId}`
		: args.link;

	const payload = {
		entityType,
		entityId,
		storyId,
		projectId: args.projectId,
		pendingStateChangeId: args.pendingStateChangeId,
		reason: isContentDrift ? "ado-content-drift" : undefined,
		previousState: args.previousState,
		newState: args.newState,
	};

	await Promise.all(
		allowedRecipients.map(async (userId) => {
			try {
				await db.notification.create({
					data: {
						userId,
						organizationId: args.organizationId,
						type: "PM_SYNC_CONFLICT",
						category: "PROJECT",
						title,
						snippet,
						link: effectiveLink,
						projectId: args.projectId,
						storyId: storyId ?? undefined,
						actorUserId: args.actorUserId ?? undefined,
						payload,
						dedupeKey,
					},
				});
			} catch (error) {
				// Coalesce on dedupe-key collision; swallow other errors so the
				// caller (background poll) is never blocked by notification writes.
				const code = (error as { code?: string } | null)?.code;
				if (code === "P2002") {
					return;
				}
				// Intentionally silent: notification dispatch is best-effort.
			}
		}),
	);
}
