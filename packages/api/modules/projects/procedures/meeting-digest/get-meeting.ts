import { ORPCError } from "@orpc/server";
import {
	ACTION_ITEM_LINK_VERSION,
	type ActionItemLinkRow,
	computeActionItemKey,
	db,
	hasProjectAccess,
	isFeatureEnabled,
	listActionItemLinks,
} from "@repo/database";
import { MEETING_INSIGHTS_VERSION } from "@repo/temporal/activities";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export interface ActionItemPayload {
	id: string | null;
	text: string;
	tentativeOwnerName: string | null;
	dueHint: string | null;
	completedAt: Date | null;
	sourceQuote: string | null;
	anchorLine: number | null;
	/**
	 * #1902: the durable key this item's links hang off. Computed from the text
	 * rather than stored, so it is correct for legacy Json items too — and so it
	 * always agrees with what the matcher wrote, since both call the same
	 * function. Without this the client has no way to join `linksByItemKey` to
	 * the items it renders.
	 */
	itemKey: string;
}

export interface LinkedTicket {
	storyId: string;
	identifier: string | null;
	title: string;
	statusName: string | null;
	isDone: boolean;
}

/** Pure: first-class rows win; legacy Json only pre-backfill (id null → not checkable). */
export function toActionItemPayload(params: {
	rows: Array<{
		id: string;
		orderIndex: number;
		text: string;
		tentativeOwnerName: string | null;
		dueHint: string | null;
		completedAt: Date | null;
		sourceQuote: string | null;
		anchorLine: number | null;
	}>;
	legacyJson: unknown;
}): ActionItemPayload[] {
	if (params.rows.length > 0) {
		return [...params.rows]
			.sort((a, b) => a.orderIndex - b.orderIndex)
			.map(({ orderIndex: _o, ...row }) => ({
				...row,
				itemKey: computeActionItemKey(row.text),
			}));
	}
	if (!Array.isArray(params.legacyJson)) {
		return [];
	}
	return params.legacyJson.map((el) => {
		const obj = (el ?? {}) as Record<string, unknown>;
		const text =
			typeof obj.text === "string" ? obj.text : JSON.stringify(el);
		return {
			id: null,
			text,
			itemKey: computeActionItemKey(text),
			tentativeOwnerName:
				typeof obj.tentativeOwnerName === "string"
					? obj.tentativeOwnerName
					: null,
			dueHint: typeof obj.dueHint === "string" ? obj.dueHint : null,
			completedAt: null,
			sourceQuote:
				typeof obj.sourceQuote === "string" ? obj.sourceQuote : null,
			anchorLine:
				typeof obj.anchorLine === "number" ? obj.anchorLine : null,
		};
	});
}

/**
 * Pure: whether the insights cache (summary/decisions/actions/questions) is
 * filled at the current extraction version. False tells the UI to fire
 * meetingDigest.extractInsights and poll.
 */
export function toInsightsReady(t: {
	insightsExtractedAt: Date | null;
	insightsVersion: number | null;
}): boolean {
	return (
		t.insightsExtractedAt !== null &&
		t.insightsVersion === MEETING_INSIGHTS_VERSION
	);
}

/**
 * Pure: transcript availability + the two refs the UI needs.
 * - `transcriptRef` (the row id) is what `getContent` accepts (inline pane).
 * - `transcriptContextId` (the ProjectContext id) is what the full-screen
 *   reader route `…/contexts/[contextId]` resolves; null when unsynced.
 */
export function toTranscriptAvailability(t: {
	id: string;
	contextId: string | null;
}): {
	hasTranscript: boolean;
	transcriptRef: string;
	transcriptContextId: string | null;
} {
	return {
		hasTranscript: Boolean(t.contextId),
		transcriptRef: t.id,
		transcriptContextId: t.contextId,
	};
}

/**
 * Pure: live completion per linked story (#1823 FR8). Done iff the Kanban
 * status is marked final (ProjectStoryStatus.isFinal — the schema's own
 * completion flag); a missing status is defensively "not done". External PM
 * terminal state (pmTicketTerminal) is deliberately NOT consulted — the card
 * scopes completion to Fabric state.
 */
export function toLinkedTicket(s: {
	id: string;
	identifier: string | null;
	title: string;
	status: { name: string; isFinal: boolean } | null;
}): LinkedTicket {
	return {
		storyId: s.id,
		identifier: s.identifier,
		title: s.title,
		statusName: s.status?.name ?? null,
		isDone: s.status?.isFinal ?? false,
	};
}

/**
 * Pure: group links by the action item they belong to (#1902 FR2/FR9).
 *
 * Keyed by `itemKey`, not by action item id, because links deliberately do not
 * hold an id — see meeting-action-item-keys.ts. An item whose text changed since
 * the link was written simply has no entry here and renders unlinked, which is
 * the accepted degradation.
 */
export function groupLinksByItemKey(
	links: ActionItemLinkRow[],
): Record<string, ActionItemLinkRow[]> {
	const byKey: Record<string, ActionItemLinkRow[]> = {};
	for (const link of links) {
		const existing = byKey[link.itemKey];
		if (existing) {
			existing.push(link);
		} else {
			byKey[link.itemKey] = [link];
		}
	}
	return byKey;
}

export const getMeetingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/meeting-digest/{transcriptId}",
		tags: ["Projects", "Meeting Digest"],
		summary: "Get one meeting's digest detail",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			transcriptId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const access = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);
		if (!access) {
			throw new ORPCError("FORBIDDEN", {
				message: "You do not have access to this project",
			});
		}

		const transcript = await db.projectMeetingTranscript.findFirst({
			where: {
				projectId: input.projectId,
				transcriptId: input.transcriptId,
			},
			include: {
				linkedMeeting: { select: { organizer: true, subject: true } },
				actionItems: {
					select: {
						id: true,
						orderIndex: true,
						text: true,
						tentativeOwnerName: true,
						dueHint: true,
						completedAt: true,
						sourceQuote: true,
						anchorLine: true,
					},
				},
			},
		});
		if (!transcript) {
			throw new ORPCError("NOT_FOUND", { message: "Meeting not found" });
		}

		// #1814: stored provenance replaces the apply-window correlation.
		// Stories stamped at approve time (or by the backfill script).
		const sourcedStories = await db.userStory.findMany({
			where: {
				projectId: input.projectId,
				sourceMeetingTranscriptId: transcript.id,
			},
			select: {
				id: true,
				identifier: true,
				title: true,
				status: { select: { name: true, isFinal: true } },
			},
			orderBy: { createdAt: "asc" },
		});

		// #1902: links are read only when the feature is on, so flipping the flag
		// off hides them without deleting anything (clean rollback).
		const linkingEnabled = await isFeatureEnabled(
			"MEETING_ACTION_ITEM_LINKING",
		);
		const links = linkingEnabled
			? await listActionItemLinks(transcript.id)
			: [];

		return {
			subject:
				transcript.linkedMeeting?.subject ?? transcript.meetingSubject,
			meetingDate: transcript.meetingDate,
			organizer: transcript.linkedMeeting?.organizer ?? null,
			participants: transcript.speakerNames,
			summary: transcript.summary,
			analysisStatus: transcript.analysisStatus,
			analyzedAt: transcript.analyzedAt,
			analysisError: transcript.analysisError,
			...toTranscriptAvailability(transcript),
			insightsReady: toInsightsReady(transcript),
			insightsExtractedAt: transcript.insightsExtractedAt,
			createdTasks: sourcedStories.map(toLinkedTicket),
			decisions: transcript.extractedDecisions,
			actionItems: toActionItemPayload({
				rows: transcript.actionItems,
				legacyJson: transcript.extractedActionItems,
			}),
			openQuestions: transcript.extractedQuestions,
			declinedTasks: null, // phase 2
			// #1902. `linkingEnabled` lets the client hide the whole affordance
			// rather than render an empty one; `linkingReady` is what it polls on
			// (false = a matching run has not finished for this meeting yet).
			linkingEnabled,
			linkingReady:
				!linkingEnabled ||
				transcript.actionItemsLinkVersion === ACTION_ITEM_LINK_VERSION,
			linksByItemKey: groupLinksByItemKey(links),
		};
	});
