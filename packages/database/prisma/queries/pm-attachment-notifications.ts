/**
 * PM attachment-sync failure notification dispatch (Fizzy #1745, AC-4).
 *
 * Lives in `@repo/database` rather than `@repo/api/lib/notification-service`
 * for the same reason as `repo-integration-notifications.ts`: the emitter is a
 * Temporal activity, and `@repo/api` depends on `@repo/temporal`, so an
 * activity cannot reach the API-side fan-out without a cycle.
 *
 * Emitted by the GitLab REST push path
 * (`packages/temporal/src/activities/pm-integration/gitlab-rest-story-sync.ts`)
 * when `reconcileStoryAttachments` reports one or more files that never
 * reached the PM tool. AC-4 and AC-10 both require this to surface in the
 * notification centre — the sync-log row alone is not enough, because nobody
 * opens Sync History for a push they believe succeeded.
 *
 * - Writes one `PM_ATTACHMENT_SYNC_FAILED` row PER recipient (category
 *   `PROJECT`), deduped per recipient.
 * - The ACTING user is a recipient, unlike the conflict fan-out which
 *   excludes them. They triggered the push; they are the person who retries
 *   it or re-scopes the token.
 * - **Never throws.** Notification dispatch must not fail the activity that
 *   is reporting a failure — that would escalate "two of three files
 *   uploaded" into "the push failed".
 */
import {
	db,
	NotificationCategory,
	NotificationType,
	ProjectMemberRole,
} from "../client";
import { getEnabledRecipientsForCategory } from "./notification-preferences";

/** Matches `pm-conflict-notifications.ts` — same inbox, same single line. */
const SNIPPET_MAX_LENGTH = 280;

function truncateSnippet(snippet: string): string {
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

export interface CreatePmAttachmentSyncFailedNotificationArgs {
	/** The user who triggered the push. Always a recipient. */
	actorUserId: string;
	/** Org scope for the notification row; null in personal-project context. */
	organizationId: string | null;
	projectId: string;
	storyId: string;
	storyTitle: string;
	/** Human label for the PM tool, e.g. "GitLab". */
	pmToolLabel: string;
	/**
	 * The one-line summary produced by `summarizeAttachmentFailures` — the
	 * count, the filenames and the adapter's own reason. Rendered verbatim as
	 * the snippet so the reader learns which file failed and why without
	 * leaving the inbox (AC-10's "descriptive error").
	 */
	failureSummary: string;
	/** Context-relative deep link to the work item. No leading slash. */
	link: string;
}

export async function createPmAttachmentSyncFailedNotification(
	args: CreatePmAttachmentSyncFailedNotificationArgs,
): Promise<void> {
	try {
		const recipientUserIds = await resolveAttachmentFailureRecipients(
			args.projectId,
			args.actorUserId,
		);
		if (recipientUserIds.length === 0) {
			return;
		}

		// Write-time preference filter (Notification Center Preferences,
		// AC-4): drop recipients who disabled the Sync/Project category.
		// Recipients with no preference row stay enabled (default-on).
		const enabled = await getEnabledRecipientsForCategory(
			recipientUserIds,
			NotificationCategory.PROJECT,
		);
		const allowed = recipientUserIds.filter((id) => enabled.has(id));
		if (allowed.length === 0) {
			return;
		}

		const title = `Attachments failed to sync on "${args.storyTitle}"`;
		// The summary is rendered verbatim, with no tail of our own. The
		// caller knows whether a file never reached the PM tool or reached it
		// and lost its link locally; those need opposite advice, and any
		// sentence generic enough to append here would be wrong for one of
		// them. Truncated to match the sibling PM writer, since the inbox row
		// renders the snippet on a single truncated line either way.
		const snippet = truncateSnippet(args.failureSummary);

		await Promise.all(
			allowed.map((recipientUserId) =>
				writeAttachmentFailureRow(
					args,
					recipientUserId,
					title,
					snippet,
				),
			),
		);
	} catch (error) {
		// Best-effort by contract: never block the reporting activity. Log so
		// a sustained dispatch failure is still detectable.
		console.warn(
			"[PmAttachmentNotification] failure dispatch failed",
			{ storyId: args.storyId },
			error,
		);
	}
}

/**
 * The acting user plus the project's owners/admins — the people who can retry
 * the push or fix the integration's token. Deduped by userId so an actor who
 * is also an owner receives a single notification.
 */
async function resolveAttachmentFailureRecipients(
	projectId: string,
	actorUserId: string,
): Promise<string[]> {
	const recipients = new Set<string>([actorUserId]);

	const project = await db.project.findUnique({
		where: { id: projectId },
		select: {
			// The project creator is always the OWNER (schema invariant).
			userId: true,
			members: {
				where: {
					role: {
						in: [
							ProjectMemberRole.OWNER,
							ProjectMemberRole.PROJECT_ADMIN,
						],
					},
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: new Date() } },
					],
				},
				select: { userId: true },
			},
		},
	});

	if (project?.userId) {
		recipients.add(project.userId);
	}
	for (const member of project?.members ?? []) {
		recipients.add(member.userId);
	}

	return [...recipients];
}

/**
 * Write one row for an already preference-checked recipient.
 *
 * The dedupe key is per (story, recipient): a story pushed repeatedly while
 * its token is still mis-scoped coalesces onto the one unread row instead of
 * stacking one per attempt. The key deliberately omits the filenames — a
 * second failing file on the same story is the same problem to act on, and
 * keying on them would defeat the coalescing entirely.
 */
async function writeAttachmentFailureRow(
	args: CreatePmAttachmentSyncFailedNotificationArgs,
	recipientUserId: string,
	title: string,
	snippet: string,
): Promise<void> {
	const dedupeKey = `pmAttachmentSyncFailed:${args.storyId}:${recipientUserId}`;

	try {
		await db.notification.create({
			data: {
				userId: recipientUserId,
				organizationId: args.organizationId,
				type: NotificationType.PM_ATTACHMENT_SYNC_FAILED,
				category: NotificationCategory.PROJECT,
				title,
				snippet,
				link: args.link,
				projectId: args.projectId,
				storyId: args.storyId,
				payload: {
					projectId: args.projectId,
					storyId: args.storyId,
					storyTitle: args.storyTitle,
					pmToolLabel: args.pmToolLabel,
					failureSummary: args.failureSummary,
				},
				dedupeKey,
			},
		});
	} catch (error) {
		// P2002 is the live-unread partial unique index doing its job — the
		// existing unread row stands. Any other write error is isolated here
		// so one bad row cannot drop the rest of the fan-out.
		console.warn(
			"[PmAttachmentNotification] row write failed",
			{ storyId: args.storyId, recipientUserId },
			error,
		);
	}
}
