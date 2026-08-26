import { db, tenantWhere } from "@repo/database";
import { logger } from "@repo/logs";
import { heartbeat } from "@temporalio/activity";

/**
 * Context assembly for pre-meeting agenda generation (#1901).
 *
 * Every read here is DB-only — no Graph, no HTTP, no LLM. That is load-bearing:
 * AC4 requires personal meeting transcripts are never a context source, and
 * personal meetings have ZERO database representation (#1899). Reading only
 * from Postgres makes the guarantee structural rather than a filter someone can
 * later drop. Task 13 adds an import-guard test that pins this for the whole
 * directory.
 */

/**
 * Prior occurrences of the SAME series to summarise (#2105).
 *
 * The series is `ProjectLinkedMeeting` — its `joinUrl` is stable across recurring
 * instances (see schema.prisma), and there is no calendar recurrence id anywhere
 * in the codebase to use instead. Bounded by BOTH this count and the window
 * below: a weekly series gets ~5 weeks of context, a monthly one gets three
 * months, and a series dormant for a year contributes nothing rather than
 * resurrecting year-old business.
 *
 * Both numbers are engineering defaults standing in for an unanswered PM
 * question, and are deliberately the only thing that needs editing to re-tune.
 */
export const PRIOR_MEETING_CAP = 5;
export const PRIOR_MEETING_WINDOW_DAYS = 90;
/** Open action items carried across the whole series — bounds the prompt, not just memory. */
export const CARRIED_ITEM_CAP = 20;
/** ProjectMeetingActionItem has no projectId column and no index for a project-wide scan. */
export const ACTION_ITEM_CAP = 50;
export const DECISION_CAP = 30;
/** UserStory.blocked is unindexed — this is a filtered scan over @@index([projectId]). */
export const BLOCKED_STORY_CAP = 30;

export interface AgendaTenant {
	projectId: string;
	organizationId: string | null;
	userId: string;
}

export interface PriorMeeting {
	meetingSubject: string | null;
	meetingDate: Date | null;
	summary: string | null;
	decisions: string[];
	openQuestions: string[];
}

export interface OpenActionItem {
	text: string;
	tentativeOwnerName: string | null;
	dueHint: string | null;
}

/**
 * An open action item raised by an EARLIER occurrence of this same series —
 * "old business" (#2105 FR2).
 *
 * Membership of this list is derived from data (which transcript the row hangs
 * off, and when that meeting happened), never inferred by the model. The LLM is
 * only allowed to decide how a carried item is presented, not whether it is one.
 */
export interface CarriedActionItem extends OpenActionItem {
	fromMeetingSubject: string | null;
	fromMeetingDate: Date | null;
}

export interface OpenDecision {
	storyIdentifier: string;
	storyTitle: string;
	question: string;
}

export interface BlockedStory {
	identifier: string;
	title: string;
	blockedReason: string | null;
}

export interface AgendaContext {
	priorMeetings: PriorMeeting[];
	hadPriorTranscripts: boolean;
	/** Old business — see CarriedActionItem. */
	carriedActionItems: CarriedActionItem[];
	/** New items only: carried items are excluded by the query that builds this. */
	openActionItems: OpenActionItem[];
	openDecisions: OpenDecision[];
	blockedStories: BlockedStory[];
	truncated: {
		actionItems: boolean;
		decisions: boolean;
		blockedStories: boolean;
		carriedActionItems: boolean;
	};
}

/**
 * Meeting insight columns are Json, written by extract-meeting-insights against
 * meetingDecisionSchema / meetingOpenQuestionSchema. They predate any runtime
 * validation on read, so treat them as untrusted: a malformed blob must degrade
 * to an empty list, never abort agenda generation.
 */
function readTextItems(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((item) =>
			item && typeof item === "object" && "text" in item
				? (item as { text?: unknown }).text
				: undefined,
		)
		.filter(
			(text): text is string =>
				typeof text === "string" && text.length > 0,
		);
}

/** Takes cap+1 rows so truncation is detectable rather than assumed. */
function applyCap<T>(
	rows: T[],
	cap: number,
): { items: T[]; truncated: boolean } {
	return rows.length > cap
		? { items: rows.slice(0, cap), truncated: true }
		: { items: rows, truncated: false };
}

export async function collectAgendaContextActivity(
	input: AgendaTenant & { linkedMeetingId: string; occurrenceStart: Date },
): Promise<AgendaContext> {
	const {
		projectId,
		organizationId,
		userId,
		linkedMeetingId,
		occurrenceStart,
	} = input;
	// UserStory and ProjectMeetingActionItem carry no userId/organizationId
	// columns of their own (verified against schema.prisma), so the tenant
	// fragment is applied under the `project` relation on every read.
	const tenant = tenantWhere(userId, organizationId);

	heartbeat(`collectAgendaContext: ${linkedMeetingId}`);

	// Half-open window, [floor, occurrenceStart). The exclusive upper bound is
	// what stops a meeting being fed its OWN transcript as history: generateAgenda
	// allows generation up to an hour after the occurrence starts, by which point
	// that transcript may already have synced. Both bounds also exclude rows with
	// a NULL meetingDate — which matters more than it looks, because Postgres
	// sorts NULLs FIRST on `ORDER BY meetingDate DESC`, so before this filter
	// three undated transcripts could displace every real occurrence.
	const windowFloor = new Date(
		occurrenceStart.getTime() -
			PRIOR_MEETING_WINDOW_DAYS * 24 * 60 * 60 * 1000,
	);

	// The series history is read FIRST, on its own, because its open action items
	// define what "carried forward" means — and that set is what the project-wide
	// scan below must exclude. Sequencing costs one extra round trip; the
	// collector benchmarks flat at ~2ms across 0-5 occurrences, so this is not
	// where the time goes.
	const transcripts = await db.projectMeetingTranscript.findMany({
		where: {
			projectId,
			linkedMeetingId,
			project: tenant,
			meetingDate: { gte: windowFloor, lt: occurrenceStart },
		},
		orderBy: { meetingDate: "desc" },
		take: PRIOR_MEETING_CAP,
		select: {
			id: true,
			meetingSubject: true,
			meetingDate: true,
			summary: true,
			extractedDecisions: true,
			extractedQuestions: true,
			// Old business (#2105 FR2). Nested rather than a separate query: the
			// index path is already there — @@index([linkedMeetingId]) on the
			// transcript, @@index([transcriptId]) on the item. Tenancy comes from
			// the parent's `project: tenant` filter, matching how the project-wide
			// scan below reaches tenancy through a relation.
			actionItems: {
				where: { completedAt: null },
				orderBy: { orderIndex: "asc" },
				// Bound the READ, not just the flattened result: one pathological
				// meeting must not pull thousands of rows.
				take: CARRIED_ITEM_CAP + 1,
				select: {
					id: true,
					text: true,
					tentativeOwnerName: true,
					dueHint: true,
				},
			},
		},
	});

	// Old business, newest occurrence first — `transcripts` is already ordered
	// meetingDate desc, so a flat map preserves recency across the series.
	//
	// When the cap bites it is the OLDEST carried items that go, which is the
	// weaker half of the trade: an item open across five occurrences is arguably
	// the most overdue thing in the room. Recency is kept anyway for consistency
	// with every other cap in this file, and because the cap only bites on a
	// series carrying 20+ open items — at which point the agenda has a bigger
	// problem than ordering. truncated.carriedActionItems discloses the cut.
	const allCarried = transcripts.flatMap((t) =>
		(t.actionItems ?? []).map((item) => ({
			id: item.id,
			text: item.text,
			tentativeOwnerName: item.tentativeOwnerName,
			dueHint: item.dueHint,
			fromMeetingSubject: t.meetingSubject,
			fromMeetingDate: t.meetingDate,
		})),
	);
	const carried = applyCap(allCarried, CARRIED_ITEM_CAP);

	// D4 — the project-wide scan would otherwise return these same rows, and the
	// model would agenda each of them twice: once as old business, once as a
	// generic open action.
	//
	// Excluded in the QUERY rather than filtered afterwards. Filtering after the
	// fact spends the read budget on rows that are then discarded: on a project
	// with 903 open items, 27 of the 51 rows fetched were carried, so the "new
	// items" pool arrived at 24 instead of 50 — and it shrank fastest exactly
	// when the series was most active. Excluding up front means all 50 slots go
	// to genuinely new work.
	//
	// The UNCAPPED set is excluded, not `carried.items`: an item the cap pushed
	// out of old business is still old business, and letting it reappear here
	// would present carried work to the model as a NEW item — precisely the
	// mislabelling FR2 exists to prevent.
	const carriedIds = allCarried.map((item) => item.id);

	const [actionItemRows, decisionRows, blockedRows] = await Promise.all([
		db.projectMeetingActionItem.findMany({
			where: {
				completedAt: null,
				transcript: { projectId, project: tenant },
				// Prisma treats `notIn: []` as a real (always-true) filter rather
				// than a no-op, so only narrow when something is actually carried.
				...(carriedIds.length > 0 ? { id: { notIn: carriedIds } } : {}),
			},
			orderBy: { createdAt: "desc" },
			take: ACTION_ITEM_CAP + 1,
			select: {
				id: true,
				text: true,
				tentativeOwnerName: true,
				dueHint: true,
			},
		}),

		// DecisionLogEntry carries its own userId/organizationId columns
		// (verified against schema.prisma), so the tenant fragment applies
		// directly rather than through a relation.
		db.decisionLogEntry.findMany({
			where: {
				...tenant,
				status: "OPEN",
				parentId: null,
				deletedAt: null,
				story: { projectId },
			},
			orderBy: { createdAt: "desc" },
			take: DECISION_CAP + 1,
			select: {
				summary: true,
				content: true,
				story: { select: { identifier: true, title: true } },
			},
		}),

		// KNOWN LIMITATION: this compound order is not the same ranking as
		// `lastEditedAt ?? createdAt` — every edited story outranks every
		// never-edited one, so under the cap a story blocked today can lose its
		// place to one last touched years ago.
		db.userStory.findMany({
			where: { projectId, blocked: true, project: tenant },
			orderBy: [
				{ lastEditedAt: { sort: "desc", nulls: "last" } },
				{ createdAt: "desc" },
			],
			take: BLOCKED_STORY_CAP + 1,
			select: { identifier: true, title: true, blockedReason: true },
		}),
	]);

	// Every row here is already both non-carried and open, so applyCap sees the
	// same list the query returned. That is what makes truncated.actionItems
	// honest again: the earlier in-memory subtraction shrank the list AFTER the
	// cap was measured, so a read that genuinely hit its cap could report false
	// and silently suppress the "more open work than fits" notice (#2105 QA, F1).
	const actionItems = applyCap(actionItemRows, ACTION_ITEM_CAP);
	const decisions = applyCap(decisionRows, DECISION_CAP);
	const blocked = applyCap(blockedRows, BLOCKED_STORY_CAP);

	const truncated = {
		actionItems: actionItems.truncated,
		decisions: decisions.truncated,
		blockedStories: blocked.truncated,
		carriedActionItems: carried.truncated,
	};

	// A capped agenda must never read as a complete one — surfaced in the UI via
	// contextStats.truncated, and logged here for operators.
	if (
		truncated.actionItems ||
		truncated.decisions ||
		truncated.blockedStories ||
		truncated.carriedActionItems
	) {
		logger.info(
			"[MeetingAgenda/collectAgendaContext] Context truncated by caps",
			{
				projectId,
				linkedMeetingId,
				truncated,
			},
		);
	}

	return {
		priorMeetings: transcripts.map((t) => ({
			meetingSubject: t.meetingSubject,
			meetingDate: t.meetingDate,
			summary: t.summary,
			decisions: readTextItems(t.extractedDecisions),
			openQuestions: readTextItems(t.extractedQuestions),
		})),
		hadPriorTranscripts: transcripts.length > 0,
		carriedActionItems: carried.items.map(({ id: _id, ...item }) => item),
		openActionItems: actionItems.items.map((a) => ({
			text: a.text,
			tentativeOwnerName: a.tentativeOwnerName,
			dueHint: a.dueHint,
		})),
		openDecisions: decisions.items.map((d) => ({
			storyIdentifier: d.story.identifier,
			storyTitle: d.story.title,
			question: d.summary ?? d.content ?? "(no question text)",
		})),
		blockedStories: blocked.items.map((s) => ({
			identifier: s.identifier,
			title: s.title,
			blockedReason: s.blockedReason,
		})),
		truncated,
	};
}
