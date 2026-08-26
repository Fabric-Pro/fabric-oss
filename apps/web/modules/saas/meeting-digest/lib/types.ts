type DigestAnalysisStatus =
	| "NOT_SCANNED"
	| "IN_PROGRESS"
	| "SCANNED"
	| "FAILED";

interface DigestActionItem {
	id: string | null;
	text: string;
	tentativeOwnerName: string | null;
	dueHint: string | null;
	completedAt: Date | string | null;
}

export interface DigestMeeting {
	linkedMeetingId: string;
	transcriptId: string;
	transcriptRef: string;
	subject: string | null;
	meetingDate: Date | null;
	hasTranscript: boolean;
	analysisStatus: DigestAnalysisStatus;
	createdTaskCount: number;
	participantCount: number;
	includedInDigest: boolean;
	insightsReady: boolean;
	decisions: Array<{ text: string }>;
	actionItems: DigestActionItem[];
	openQuestions: Array<{ text: string }>;
}

export interface DigestSeriesEntry {
	linkedMeetingId: string;
	subject: string | null;
}

/** Mirrors `LinkedTicket` from `packages/api/.../get-meeting.ts` (#1823). */
export interface LinkedTicket {
	storyId: string;
	identifier: string | null;
	title: string;
	statusName: string | null;
	isDone: boolean;
}

/**
 * A meeting from the authenticated user's own Microsoft calendar (#1899).
 *
 * Mirrors `PersonalMeetingRow` from
 * `packages/api/.../meeting-digest/list-personal-meetings.ts`.
 *
 * Deliberately has no insights, no analysis status, and no transcriptRef:
 * personal transcripts are never stored, so there is nothing to extract
 * insights from and nothing to reference. See the design doc.
 */
export interface PersonalMeeting {
	id: string;
	subject: string;
	startTime: string | null;
	organizer: string;
	joinUrl: string;
	/**
	 * True when this row is NOT a personal meeting at all: it is a project
	 * meeting linked to the digest whose transcript has not synced, so the team
	 * view rendered no row for it and it would otherwise be invisible (DEF-0).
	 *
	 * It travels on this type because it arrives through the same endpoint, but
	 * it inverts the privacy story — this meeting IS shared with the team. Every
	 * "Personal" label and every "only you can see this" assurance must be
	 * suppressed when this is true.
	 */
	linkedWithoutTranscript: boolean;
	/**
	 * True when the project already holds an imported copy of this occurrence
	 * (#2170). Optional because it arrived after the rest of this shape, and a
	 * caller that predates it should read as "not imported".
	 *
	 * The privacy notice depends on it: local "I just imported this" state dies
	 * on reload, and without a server-side answer the sheet goes back to calling
	 * a stored, project-visible transcript private.
	 */
	alreadyImported?: boolean;
}

/**
 * An included linked meeting occurrence that has happened but whose transcript
 * has not synced (#2051).
 *
 * Mirrors `AwaitingOccurrenceRow` from
 * `packages/api/.../meeting-digest/list-digest.ts`. Deliberately has no
 * transcriptId and no transcriptRef — there is no transcript, which is the
 * entire point. Rows of this type are rendered INERT: there is nothing to open.
 */
export interface AwaitingMeeting {
	linkedMeetingId: string;
	subject: string | null;
	/** A Date over the wire arrives as an ISO string. */
	occurrenceStart: Date | string;
	/**
	 * Used to suppress the PR #2226 personal-lane copy of this same meeting.
	 * That path hides a linked meeting only once it has a TRANSCRIPT, which this
	 * one by definition does not, so without matching on the join URL the
	 * meeting renders twice in one calendar cell in the "All meetings" scope.
	 */
	joinUrl: string;
}

/**
 * One link from a meeting action item to a work item (#1902).
 *
 * Mirrors `ActionItemLinkRow` from
 * `packages/database/prisma/queries/projects/meeting-action-item-links.ts`.
 * `confidence` and `reasoning` are populated for AUTO links only — they are the
 * matcher's own account of itself, shown in the chip tooltip so a suggestion
 * reads as a suggestion.
 */
export interface ActionItemLinkView {
	id: string;
	itemKey: string;
	storyId: string;
	origin: "AUTO" | "MANUAL" | "CREATED";
	confidence: number | null;
	similarity: number | null;
	reasoning: string | null;
	identifier: string | null;
	title: string;
	statusName: string | null;
	isDone: boolean;
}

/**
 * One action item from a personal meeting summary (#2104).
 *
 * Named here rather than left inline in `PersonalMeetingSheet` so the cached
 * payload and the rendered payload are provably the same shape. Mirrors
 * `PersonalInsightsSchema` in
 * `packages/api/modules/projects/procedures/meeting-digest/get-personal-insights.ts`.
 */
export interface PersonalInsightItem {
	text: string;
	tentativeOwnerName?: string;
	dueHint?: string;
}
