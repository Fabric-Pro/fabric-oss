/**
 * Meeting auto-assignment notification (Fizzy #2340).
 *
 * When the meeting-digest owner matcher assigns one or more of a meeting's
 * action items to a Fabric member, that member hears about it once: ONE in-app
 * row per recipient per meeting, stating how many items and the first one's
 * text, linking to the To Do page.
 *
 * Lives in `@repo/database` rather than beside `fanOut` in
 * `@repo/api/lib/notification-service` because its only caller is a Temporal
 * activity, and `@repo/api` depends on `@repo/temporal` — the activity cannot
 * import the API-side helper without a circular dependency. The same reason
 * `agent-reply-notifications.ts` exists; this file mirrors it: preference
 * check, insert with a dedupe key, P2002 swallowed, never throws.
 *
 * Two things `createNotification` does that this writer deliberately does not:
 *
 *  - It starts NO external delivery (email/webhook). Meeting notices are in-app
 *    only by design: a batch of guesses an LLM read off a transcript is not
 *    something to put in anyone's inbox.
 *  - It does not invalidate the API-side unread-count cache
 *    (`packages/api/lib/notification-cache.ts`), which this package cannot
 *    reach. That cache's TTL is 5 seconds, so the bell catches up on the next
 *    poll after it expires — the same limitation `agent-reply-notifications.ts`
 *    lives with.
 *
 * The payload shape is pinned against `TODO_MEETING_ITEMS_ASSIGNED` in
 * `packages/api/modules/notifications/lib/payloads.ts` by an API-side test that
 * runs `buildTodoMeetingAssignmentPayload` through `validatePayload`.
 */
import { db } from "../../client";
import {
	getNotificationPreferences,
	isCategoryEnabled,
} from "../notification-preferences";

/**
 * How old a meeting may be, in days, and still ring the bell.
 *
 * Mirrors `TODO_AGE_THRESHOLD_DAYS` in
 * `packages/api/modules/todos/lib/visibility.ts` (an API-side test pins the two
 * equal). A meeting the To Do page already age-hides must not produce a notice
 * whose link opens onto a list that does not show the items; and it keeps
 * catch-up of an organization's historical meetings silent, so enabling the
 * To Do list does not bury every member under months of old action items.
 */
export const TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS = 30;

/** The cap `createNotification` applies to every snippet. */
const SNIPPET_MAX_LENGTH = 280;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Server-authored and fixed. A notification title becomes an email subject
 * verbatim wherever external delivery exists, so nothing user-controlled — not
 * the meeting subject, not the item text — goes into it; those appear only in
 * the snippet. See
 * docs/solutions/design-patterns/stripping-characters-cannot-make-a-name-trustworthy.md.
 */
const TITLE = "Action items from a meeting were assigned to you";

export type TodoMeetingAssignmentItem = {
	todoId: string;
	/** The live action item text; whitespace is collapsed here. */
	text: string;
};

export type CreateTodoMeetingAssignmentNotificationArgs = {
	recipientUserId: string;
	organizationId: string;
	/** The to-dos' project; carried so project deletion cascades the row. */
	projectId: string;
	transcriptId: string;
	meetingSubject: string | null;
	/** The meeting's date (ingest time when it has none) — the freshness clock. */
	sourceDate: Date;
	/** In meeting order; the first one's text leads the snippet. */
	items: readonly TodoMeetingAssignmentItem[];
	/** Injectable clock for the freshness cut. Defaults to the wall clock. */
	now?: Date;
};

/**
 * What happened, for tests and for the caller's counts. Never an exception.
 */
export type TodoMeetingAssignmentNotificationOutcome =
	| "created"
	| "no-items"
	| "stale"
	| "already-notified"
	| "not-a-member"
	| "preference-disabled"
	| "failed";

export type TodoMeetingAssignmentPayload = {
	transcriptId: string;
	projectId: string;
	todoIds: string[];
	itemCount: number;
};

export function buildTodoMeetingAssignmentPayload(args: {
	transcriptId: string;
	projectId: string;
	todoIds: readonly string[];
}): TodoMeetingAssignmentPayload {
	return {
		transcriptId: args.transcriptId,
		projectId: args.projectId,
		todoIds: [...args.todoIds],
		itemCount: args.todoIds.length,
	};
}

function collapseWhitespace(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** Same rule as `truncateSnippet` in `@repo/api/lib/notification-service`. */
function truncateSnippet(snippet: string): string {
	if (snippet.length <= SNIPPET_MAX_LENGTH) {
		return snippet;
	}
	return `${snippet.slice(0, SNIPPET_MAX_LENGTH - 1).trimEnd()}…`;
}

function buildSnippet(
	meetingSubject: string | null,
	items: readonly TodoMeetingAssignmentItem[],
): string {
	const count = items.length;
	const noun = `action item${count === 1 ? "" : "s"}`;
	const subject = collapseWhitespace(meetingSubject ?? "");
	const firstItem = collapseWhitespace(items[0]?.text ?? "");
	const lead = subject
		? `${count} ${noun} from "${subject}"`
		: `${count} ${noun}`;
	return truncateSnippet(`${lead}: ${firstItem}`);
}

/**
 * Write one TODO_MEETING_ITEMS_ASSIGNED notification for one recipient and one
 * meeting.
 *
 * Checks run cheapest-first, and each one is a reason to write nothing:
 *
 *  1. No items — nothing to announce.
 *  2. The meeting is older than the To Do page's age cutoff (same `<` the list
 *     query applies, so a meeting exactly at the boundary still notifies).
 *  3. ANY row already carries this dedupe key for this user in this
 *     organization, read, archived or not. The live-unread partial unique
 *     index alone is not enough: the matcher hands over everyone holding
 *     items on every run, and a notice the person has read must still count
 *     as told. One notice per person per meeting, ever.
 *  4. The recipient is no longer a member of the organization. The matcher
 *     chose them from a member list read before its writes, which can be
 *     minutes old by now, and a notice is organization content: it must not
 *     reach someone who has left.
 *  5. The recipient switched off Assignments.
 *
 * Never throws: the caller owns what a failed notice costs. A P2002 is the
 * same notice racing itself; anything else is reported as `"failed"`, which
 * the matcher turns into a retry of its own activity.
 */
export async function createTodoMeetingAssignmentNotification(
	args: CreateTodoMeetingAssignmentNotificationArgs,
): Promise<TodoMeetingAssignmentNotificationOutcome> {
	if (args.items.length === 0) {
		return "no-items";
	}

	const now = args.now ?? new Date();
	const cutoff =
		now.getTime() - TODO_MEETING_NOTIFICATION_MAX_AGE_DAYS * DAY_MS;
	if (args.sourceDate.getTime() < cutoff) {
		return "stale";
	}

	const dedupeKey = `todoMeetingAssigned:${args.transcriptId}:${args.recipientUserId}`;

	try {
		const prior = await db.notification.findFirst({
			where: {
				userId: args.recipientUserId,
				organizationId: args.organizationId,
				dedupeKey,
			},
			select: { id: true },
		});
		if (prior) {
			return "already-notified";
		}

		const membership = await db.member.findFirst({
			where: {
				organizationId: args.organizationId,
				userId: args.recipientUserId,
			},
			select: { id: true },
		});
		if (!membership) {
			return "not-a-member";
		}

		const flags = await getNotificationPreferences(args.recipientUserId);
		if (!isCategoryEnabled(flags, "ASSIGNMENT")) {
			return "preference-disabled";
		}

		const payload = buildTodoMeetingAssignmentPayload({
			transcriptId: args.transcriptId,
			projectId: args.projectId,
			todoIds: args.items.map((item) => item.todoId),
		});

		// No `actorUserId`: nobody assigned these — the matcher did, from a
		// name read off a transcript — and naming a person would claim an
		// action they never took.
		await db.notification.create({
			data: {
				userId: args.recipientUserId,
				organizationId: args.organizationId,
				type: "TODO_MEETING_ITEMS_ASSIGNED",
				category: "ASSIGNMENT",
				title: TITLE,
				snippet: buildSnippet(args.meetingSubject, args.items),
				link: "todos",
				projectId: args.projectId,
				payload,
				dedupeKey,
			},
		});
		return "created";
	} catch (error) {
		const code = (error as { code?: string } | null)?.code;
		if (code === "P2002") {
			return "already-notified";
		}
		// Swallowed here and reported, never thrown: the caller decides what
		// a failed notice costs, and it retries rather than losing it.
		return "failed";
	}
}
