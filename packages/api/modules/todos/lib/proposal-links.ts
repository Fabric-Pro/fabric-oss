/**
 * What a to-do knows about the Feature Proposals inbox, and about the work
 * items an approved proposal produced (Fizzy #2340).
 *
 * The To Do page and the meeting digest are two views of ONE set of facts: an
 * action item, the proposal somebody filed from it, and the feature or bug that
 * approving the proposal created. This module is the single place the to-do
 * side derives those facts, for the same reason `visibility.ts` is the single
 * place it derives access: a second derivation would be a second opinion, and
 * the failure this unit exists to prevent is precisely the two surfaces
 * disagreeing about whether a link is still there.
 *
 * THREE ADDRESSES, ONE ORDER. A `PendingBacklogProposal` filed from a single
 * action item records that item twice — `sourceMetadata.actionItemKey` (with
 * `actionItemKeyVersion`) and `sourceMetadata.actionItemId` — and the order in
 * which they are consulted is not a matter of taste. `extractMeetingInsights`
 * replaces a transcript's action items with `deleteMany` + `createMany` on every
 * run, so `ProjectMeetingActionItem.id` does not survive a re-extraction, while
 * the key (a digest of the normalized text) does. Resolving by id first would
 * therefore lose exactly the proposals that outlived an extraction — which is
 * the defect `packages/api/modules/projects/lib/action-item-link-provenance.ts`
 * was written to close. This module resolves in the same order, from the other
 * direction, and the version is CHECKED rather than ignored for the reason that
 * module states: a key written under a different `TODO_BINDING_VERSION` is a
 * digest in another scheme and addresses nothing here.
 *
 * WHY THE LINK KEY IS NOT THE TO-DO KEY. `TodoItem.itemKey` is
 * `computeTodoItemKey`; `MeetingActionItemLink.itemKey` is
 * `computeActionItemKey`. The two digests are versioned independently on
 * purpose (see `bind-action-items.ts`), and they are equal today only by
 * coincidence. Going from a to-do to its links therefore has to pass through
 * the LIVE action item's text and re-key it — which is also why an orphaned
 * to-do (one whose wording changed under it) reports no link key at all rather
 * than one computed from its stale snapshot. A tombstone written under a key
 * the matcher never produces is worse than no tombstone: it looks like a
 * rejection and prevents nothing.
 */

import { ORPCError } from "@orpc/server";
import {
	computeActionItemKey,
	db,
	resolveBoundActionItem,
	TODO_BINDING_VERSION,
	type TodoMutationRow,
} from "@repo/database";

/** How a to-do reached the proposal that speaks for it. */
export type TodoProposalResolvedVia = "itemKey" | "actionItemId";

/**
 * Everything the read and the write both need about a to-do's meeting item,
 * resolved once.
 *
 * `transcriptRef` is the GRAPH transcript id — what the digest deep link
 * accepts — and `transcriptRowId` is the row cuid, which is what every query
 * here joins on. The two are routinely confused, so they are named apart
 * everywhere in this feature, exactly as `list-meeting-references.ts` names
 * them apart.
 */
export interface TodoMeetingBinding {
	transcriptRowId: string;
	transcriptRef: string;
	/**
	 * The project whose meeting digest this to-do's links belong to, taken from
	 * the TRANSCRIPT and not from the to-do. It is the project a write here
	 * would touch, so it is the project a write here must be authorized
	 * against.
	 */
	projectId: string;
	/** The to-do binding key — `computeTodoItemKey`, the proposal's `actionItemKey`. */
	todoItemKey: string;
	/** The live action item, or null when the binding orphaned. */
	liveActionItem: { id: string; text: string } | null;
	/**
	 * The LINK table's key for this item, or null on an orphan. Null means "no
	 * link row can be addressed", never "there are no links".
	 */
	linkItemKey: string | null;
	/**
	 * Tenancy to COPY onto any link row written here, taken from the parent
	 * transcript exactly as `addActionItemLinkProcedure` takes it. A link must
	 * sit in the same RLS scope as the meeting it belongs to; deriving it from
	 * the request would let a guest's context write a row the meeting's own
	 * members cannot read.
	 */
	tenancy: { userId: string | null; organizationId: string | null };
}

/**
 * The to-do's meeting item, or null when there is nothing to resolve.
 *
 * Null is the honest answer for a MANUAL to-do, for a meeting-sourced row whose
 * transcript is outside this organization, and for a binding with no key. None
 * of those is an error: the page asks this question of every row it renders,
 * and a manual to-do reporting "no meeting" is the correct answer rather than a
 * refusal the client has to special-case.
 */
export async function resolveTodoMeetingBinding(params: {
	todo: TodoMutationRow;
	organizationId: string;
}): Promise<TodoMeetingBinding | null> {
	const { todo, organizationId } = params;
	if (todo.transcriptId === null || todo.itemKey === null) {
		return null;
	}

	// Scoped by organization as well as by id: the to-do was loaded under this
	// tenant and its transcript must answer to the same one, so a row whose
	// tenancy columns disagree is unreachable rather than merely unexpected.
	const transcript = await db.projectMeetingTranscript.findFirst({
		where: { id: todo.transcriptId, organizationId },
		select: {
			id: true,
			transcriptId: true,
			projectId: true,
			userId: true,
			organizationId: true,
		},
	});
	if (!transcript) {
		return null;
	}

	const liveActionItem = await resolveBoundActionItem({
		todo,
		organizationId,
	});

	return {
		transcriptRowId: transcript.id,
		transcriptRef: transcript.transcriptId,
		projectId: transcript.projectId,
		todoItemKey: todo.itemKey,
		liveActionItem: liveActionItem
			? { id: liveActionItem.id, text: liveActionItem.text }
			: null,
		linkItemKey: liveActionItem
			? computeActionItemKey(liveActionItem.text)
			: null,
		tenancy: {
			userId: transcript.userId,
			organizationId: transcript.organizationId,
		},
	};
}

/** One proposal filed from this to-do's action item. */
export interface TodoProposalRow {
	id: string;
	status: string;
	resolvedVia: TodoProposalResolvedVia;
}

/**
 * The proposals filed from this to-do's action item, stable key first.
 *
 * STEP 1 — the stable key, scoped to the meeting. The scoping is load-bearing:
 * a key is a digest of normalized TEXT, and "Update the roadmap" is said in a
 * great many meetings. A project-wide match would attribute another meeting's
 * ticket to this to-do, which is a WRONG answer rather than a missing one and
 * far harder to notice. `transcriptRecordId` has been on every per-item
 * proposal since #1823, so the narrow lookup is the normal path.
 *
 * STEP 2 — the row id, consulted only when the key found nothing. It is the
 * only address a proposal filed before #2340 carries, and it is still correct
 * whenever no re-extraction has intervened. It needs a LIVE action item by
 * definition: the id it matches is the id of a row that still exists.
 *
 * There is no step 3 here. The provenance module's third step is the coarse
 * transcript back-link, which deliberately produces no item-level link; a to-do
 * that fell through to it would be claiming every ticket the meeting produced,
 * so it reports nothing instead.
 *
 * No status filter. A story exists only because a proposal was applied, so
 * `createdFromProposalId` already carries the "accepted" part of the question;
 * filtering on `APPLIED` as well would drop the stories of a partially applied
 * proposal, which are real work items somebody is looking at.
 */
export async function findProposalsForTodo(
	binding: TodoMeetingBinding,
): Promise<TodoProposalRow[]> {
	const byKey = await db.pendingBacklogProposal.findMany({
		where: {
			projectId: binding.projectId,
			AND: [
				{
					sourceMetadata: {
						path: ["transcriptRecordId"],
						equals: binding.transcriptRowId,
					},
				},
				{
					sourceMetadata: {
						path: ["actionItemKey"],
						equals: binding.todoItemKey,
					},
				},
				{
					// The version is part of the address, not metadata about
					// it. A key stamped with another version is a digest in a
					// scheme this code cannot reason about.
					sourceMetadata: {
						path: ["actionItemKeyVersion"],
						equals: TODO_BINDING_VERSION,
					},
				},
			],
		},
		select: { id: true, status: true },
		orderBy: { createdAt: "desc" },
	});
	if (byKey.length > 0) {
		return byKey.map((row) => ({
			id: row.id,
			status: row.status,
			resolvedVia: "itemKey" as const,
		}));
	}

	if (!binding.liveActionItem) {
		return [];
	}

	const byId = await db.pendingBacklogProposal.findMany({
		where: {
			projectId: binding.projectId,
			sourceMetadata: {
				path: ["actionItemId"],
				equals: binding.liveActionItem.id,
			},
		},
		select: { id: true, status: true },
		orderBy: { createdAt: "desc" },
	});
	return byId.map((row) => ({
		id: row.id,
		status: row.status,
		resolvedVia: "actionItemId" as const,
	}));
}

/** One work item as the To Do page renders it. */
export interface TodoWorkItem {
	storyId: string;
	identifier: string;
	title: string;
	kind: "FEATURE" | "BUG";
	statusName: string | null;
	isDone: boolean;
	/**
	 * The link row backing this work item, or null.
	 *
	 * Null is not an anomaly: a proposal approved while
	 * `MEETING_ACTION_ITEM_LINKING` was off created the story and wrote no link,
	 * so the work item is real and the link is simply absent. Accepting one
	 * creates it.
	 */
	linkId: string | null;
	origin: "AUTO" | "MANUAL" | "CREATED" | null;
	confidence: number | null;
	/** True when an approved proposal filed from this to-do produced it. */
	fromProposal: boolean;
}

const STORY_SELECT = {
	id: true,
	identifier: true,
	title: true,
	kind: true,
	status: { select: { name: true, isFinal: true } },
} as const;

/**
 * The work items this to-do's action item points at.
 *
 * Two sources, merged on `storyId` and never double-counted:
 *
 *  1. ACTIVE `MeetingActionItemLink` rows on the same (transcript, item). This
 *     is exactly what the digest reads (`listActionItemLinks`), so the two
 *     surfaces cannot show a different set. DISMISSED rows are absent from
 *     both, which is the whole point of the tombstone.
 *  2. Stories an approved proposal produced (`UserStory.createdFromProposalId`),
 *     for the proposals resolved above. This is what recovers a work item whose
 *     link was never written because the flag was off at approve time.
 *
 * The link row wins the merge where both have the same story, because it is the
 * row a rejection acts on.
 */
export async function listWorkItemsForTodo(params: {
	binding: TodoMeetingBinding;
	proposals: readonly TodoProposalRow[];
}): Promise<TodoWorkItem[]> {
	const { binding, proposals } = params;

	const [links, proposalStories] = await Promise.all([
		binding.linkItemKey
			? db.meetingActionItemLink.findMany({
					where: {
						transcriptId: binding.transcriptRowId,
						itemKey: binding.linkItemKey,
						status: "ACTIVE",
					},
					select: {
						id: true,
						origin: true,
						confidence: true,
						story: { select: STORY_SELECT },
					},
					orderBy: [
						{ confidence: { sort: "desc", nulls: "first" } },
						{ createdAt: "asc" },
					],
				})
			: Promise.resolve([]),
		proposals.length
			? db.userStory.findMany({
					where: {
						projectId: binding.projectId,
						createdFromProposalId: {
							in: proposals.map((proposal) => proposal.id),
						},
					},
					select: STORY_SELECT,
					orderBy: { createdAt: "asc" },
				})
			: Promise.resolve([]),
	]);

	const proposalStoryIds = new Set(proposalStories.map((story) => story.id));

	const items: TodoWorkItem[] = links.map((link) => ({
		storyId: link.story.id,
		identifier: link.story.identifier,
		title: link.story.title,
		kind: link.story.kind,
		statusName: link.story.status?.name ?? null,
		isDone: link.story.status?.isFinal ?? false,
		linkId: link.id,
		origin: link.origin,
		confidence: link.confidence,
		fromProposal: proposalStoryIds.has(link.story.id),
	}));

	const seen = new Set(items.map((item) => item.storyId));
	for (const story of proposalStories) {
		if (seen.has(story.id)) {
			continue;
		}
		seen.add(story.id);
		items.push({
			storyId: story.id,
			identifier: story.identifier,
			title: story.title,
			kind: story.kind,
			statusName: story.status?.name ?? null,
			isDone: story.status?.isFinal ?? false,
			linkId: null,
			origin: null,
			confidence: null,
			fromProposal: true,
		});
	}

	return items;
}

/**
 * The binding a WRITE needs, or a refusal.
 *
 * Stricter than the read on one point, deliberately: a write needs a
 * `linkItemKey`, and an orphaned to-do has none. Writing a tombstone under a
 * key computed from a stale snapshot would create a row the matcher never looks
 * at while the real link stayed ACTIVE — the To Do page would show the link
 * gone and the digest would still show it there, which is the exact divergence
 * this unit exists to prevent.
 */
export function requireWritableBinding(
	binding: TodoMeetingBinding | null,
): TodoMeetingBinding & { linkItemKey: string } {
	if (!binding) {
		throw new ORPCError("NOT_FOUND", {
			message: "This to-do did not come from a meeting action item",
		});
	}
	if (!binding.linkItemKey) {
		throw new ORPCError("CONFLICT", {
			message:
				"This to-do's meeting item has been reworded, so its work-item links can no longer be changed from here",
		});
	}
	return binding as TodoMeetingBinding & { linkItemKey: string };
}
