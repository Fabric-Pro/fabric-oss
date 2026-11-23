import {
	computeTodoItemKey,
	createPendingBacklogProposal,
	db,
} from "@repo/database";
import { Permissions } from "@repo/permissions";
import type { ParlumeNoteItem } from "@repo/utils/parlume-notes";
import { userHasProjectPermission } from "../../../orpc/middleware/require-permission";

/**
 * Who may propose an action item of a meeting's notes as a ticket: a member
 * who may create work items. The proposal still waits for approval in the
 * Proposal Inbox. The caller also checks that they may read the meeting's
 * transcript.
 */
export function mayProposeParlumeActionItems(input: {
	projectId: string;
	userId: string;
}): Promise<boolean> {
	return userHasProjectPermission({
		...input,
		permission: Permissions.STORY_CREATE,
	});
}

/** The transcript reader at the line a note rests on. */
export function parlumeTranscriptLineHref(input: {
	organizationSlug: string;
	projectId: string;
	contextId: string;
	anchorLine: number;
}): string {
	const path = [
		"app",
		input.organizationSlug,
		"projects",
		input.projectId,
		"contexts",
		input.contextId,
	]
		.map(encodeURIComponent)
		.join("/");
	return `/${path}#t-${input.anchorLine}`;
}

/**
 * Pure: the one-change proposal for an action item of a meeting's notes. It
 * carries the item, its owner and due date as far as its line names them,
 * and a link to that line, never the transcript or a quote of it.
 */
function buildParlumeActionItemProposal(
	item: ParlumeNoteItem,
	transcriptHref: string | null,
) {
	const source = transcriptHref
		? `From a Parlume meeting's notes, at [line ${item.anchorLine} of its transcript](${transcriptHref}).`
		: `From a Parlume meeting's notes, at line ${item.anchorLine} of its transcript.`;
	const description = [
		item.tentativeOwnerName ? `Owner: ${item.tentativeOwnerName}` : null,
		item.dueHint ? `Due: ${item.dueHint}` : null,
		source,
	]
		.filter((line): line is string => line !== null)
		.join("\n\n");
	return {
		summary: `Ticket proposed from Parlume meeting action item: "${item.text}"`,
		changes: [
			{
				type: "feature" as const,
				action: "create" as const,
				title: { to: item.text },
				description: { to: description },
				reasoning: source,
			},
		],
	};
}

/**
 * Files one action item of a meeting's notes as a pending proposal in the
 * Proposal Inbox, through the same approval as a Meeting Digest action item.
 *
 * The proposal's source metadata holds the session, the line and its link,
 * and no transcript: the inbox shows every proposal to every project reader,
 * and a Parlume transcript stays with the people who may read it. Approval
 * then drafts from the proposal's own reasoning.
 *
 * One open proposal per item, matched on the session, the line and the
 * item's wording, so writing the notes again does not lose the match.
 */
export async function proposeParlumeActionItem(params: {
	projectId: string;
	organizationId: string;
	userId: string;
	session: { id: string; meetingSubject: string | null; meetingDate: Date };
	item: ParlumeNoteItem;
	transcriptHref: string | null;
}): Promise<{ status: "proposed" | "already-proposed"; proposalId: string }> {
	const itemKey = [
		params.session.id,
		params.item.anchorLine,
		computeTodoItemKey(params.item.text),
	].join(":");
	const existing = await db.pendingBacklogProposal.findFirst({
		where: {
			projectId: params.projectId,
			status: "PENDING",
			sourceMetadata: {
				path: ["parlumeActionItemKey"],
				equals: itemKey,
			},
		},
		select: { id: true },
	});
	if (existing) {
		return { status: "already-proposed" as const, proposalId: existing.id };
	}

	const proposal = buildParlumeActionItemProposal(
		params.item,
		params.transcriptHref,
	);
	const pending = await createPendingBacklogProposal({
		projectId: params.projectId,
		source: "MONITORED_MEETING",
		proposal: JSON.parse(JSON.stringify(proposal)),
		summary: proposal.summary,
		changeCount: 1,
		sourceMetadata: JSON.parse(
			JSON.stringify({
				parlumeSessionId: params.session.id,
				parlumeActionItemKey: itemKey,
				anchorLine: params.item.anchorLine,
				transcriptHref: params.transcriptHref,
				meetingSubject:
					params.session.meetingSubject ?? "a Parlume meeting",
				meetingDate: params.session.meetingDate,
				tentativeOwnerName: params.item.tentativeOwnerName ?? null,
				dueHint: params.item.dueHint ?? null,
				attachments: [],
				attachmentWarnings: [],
			}),
		),
		userId: params.userId,
		organizationId: params.organizationId,
	});

	return { status: "proposed" as const, proposalId: pending.id };
}
