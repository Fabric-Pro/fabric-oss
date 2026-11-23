import {
	computeProposalItemState,
	db,
	listProposalApplications,
	listProposalDuplicateResolutions,
	listProposalItemStates,
	listRestoredProposalItems,
	type ProposalItemState,
	type ProposalItemStateRow,
	proposalRevision,
	readRejectedChangeIndexes,
	readStoredProposalChanges,
	type StoredProposalChange,
	targetChangedSinceProposal,
} from "@repo/database";
import { readProposalChanges } from "../procedures/backlog/change-item-schema";
import { listHeldBackUpdateIndexes } from "../procedures/backlog/proposal-approval-guards";

const ITEM_TITLE_MAX_LENGTH = 200;

/** Compact per-item summary the review inbox lists and searches. */
export interface ProposalInboxItem {
	changeIndex: number;
	title: string;
	identifier: string | null;
}

/**
 * One `{ changeIndex, title, identifier }` per stored change still waiting
 * for a decision, titles capped. Resolved items are left out, so a search
 * does not match an item already applied or rejected.
 */
export function summarizeProposalItems(
	proposal: unknown,
	resolved: ReadonlySet<number> = new Set(),
): ProposalInboxItem[] {
	return readStoredProposalChanges(proposal)
		.filter((change) => !resolved.has(change.index))
		.map((change) => ({
			changeIndex: change.index,
			title: change.title.slice(0, ITEM_TITLE_MAX_LENGTH),
			identifier: change.identifier,
		}));
}

/** The per-item state fields both inbox payloads return. */
function itemStateFields(state: ProposalItemState) {
	return {
		resolvedItems: state.resolvedItems,
		remainingCount: state.remainingCount,
		duplicateChangeIndexes: state.resolvedItems
			.filter((item) => item.reason === "duplicate")
			.map((item) => item.changeIndex),
	};
}

/**
 * List-row shape for the review inbox: the raw `proposal` JSON is replaced
 * by compact unresolved items, and the server's resolved set (with a reason
 * per index) and remaining count are returned with it.
 */
export function toProposalInboxRow<
	T extends ProposalItemStateRow & { proposal: unknown },
>(row: T, state: ProposalItemState) {
	const { proposal, ...rest } = row;
	return {
		...rest,
		items: summarizeProposalItems(proposal, state.resolved),
		rejectedChangeIndexes: readRejectedChangeIndexes(row.sourceMetadata),
		...itemStateFields(state),
	};
}

/** List rows with each proposal's per-item state, in two queries. */
export async function toProposalInboxRows<
	T extends ProposalItemStateRow & { id: string; proposal: unknown },
>(rows: readonly T[]) {
	const states = await listProposalItemStates(rows);
	return rows.map((row, index) => toProposalInboxRow(row, states[index]));
}

/**
 * Whether the change proposes a description or acceptance criteria with no
 * `from`: its diff has no text it was computed against.
 */
function proposesBodyWithoutFrom(change: StoredProposalChange): boolean {
	return (["description", "acceptanceCriteria"] as const).some((field) => {
		const edit = change.raw[field];
		return (
			typeof edit === "object" &&
			edit !== null &&
			"to" in edit &&
			typeof edit.to === "string" &&
			edit.to !== "" &&
			!("from" in edit && typeof edit.from === "string")
		);
	});
}

/** The description and acceptance criteria of an update item's ticket now. */
type UpdateTargetBodies = {
	changeIndex: number;
	description: string;
	acceptanceCriteria: string;
};

/**
 * The unresolved update items' tickets as they are now, read once. Only
 * Fabric tickets of the proposal's own project are read.
 *
 * - `targetChangedSinceProposalIndexes`: the items whose ticket no longer
 *   has the description or acceptance criteria the proposed diff was
 *   computed against.
 * - `updateTargetBodies`: the ticket's bodies for each item that proposes a
 *   body with no `from`, so its change is summarized against the ticket and
 *   not against an empty body.
 */
async function readUpdateTargets(
	proposal: { projectId: string; proposal: unknown },
	resolved: ReadonlySet<number>,
): Promise<{
	targetChangedSinceProposalIndexes: number[];
	updateTargetBodies: UpdateTargetBodies[];
}> {
	const updates = readStoredProposalChanges(proposal.proposal).flatMap(
		(change) => {
			if (
				change.action !== "update" ||
				change.existingId === null ||
				resolved.has(change.index)
			) {
				return [];
			}
			const hasFrom =
				change.descriptionFrom !== null ||
				change.acceptanceCriteriaFrom !== null;
			const withoutFrom = proposesBodyWithoutFrom(change);
			return hasFrom || withoutFrom
				? [{ change, storyId: change.existingId, hasFrom, withoutFrom }]
				: [];
		},
	);
	if (updates.length === 0) {
		return {
			targetChangedSinceProposalIndexes: [],
			updateTargetBodies: [],
		};
	}
	const stories = await db.userStory.findMany({
		where: {
			id: { in: updates.map((update) => update.storyId) },
			projectId: proposal.projectId,
		},
		select: { id: true, description: true, acceptanceCriteria: true },
	});
	const byId = new Map(stories.map((story) => [story.id, story]));
	return {
		targetChangedSinceProposalIndexes: updates.flatMap(
			({ change, storyId, hasFrom }) => {
				const story = byId.get(storyId);
				return hasFrom &&
					story &&
					targetChangedSinceProposal(change, story)
					? [change.index]
					: [];
			},
		),
		updateTargetBodies: updates.flatMap(
			({ change, storyId, withoutFrom }) => {
				const story = byId.get(storyId);
				return withoutFrom && story
					? [
							{
								changeIndex: change.index,
								description: story.description ?? "",
								acceptanceCriteria:
									story.acceptanceCriteria ?? "",
							},
						]
					: [];
			},
		),
	};
}

/**
 * Per-item outcomes for a single proposal: what each applied item created
 * or updated, which items were resolved as duplicates of an existing ticket,
 * and which were moved to Rejected on their own, plus the server's resolved
 * set and remaining count. `createdChangeIndexes` comes from the application
 * table only, unlike the `appliedChangeIndexes` mirror, which also counts
 * duplicate skips.
 *
 * `proposalRevision` identifies the proposal content the reviewer sees; an
 * approval sends it back so a proposal changed since is refused.
 * `targetChangedSinceProposalIndexes` lists the update items whose ticket
 * was edited after the proposal was analyzed, `updateTargetBodies` the
 * ticket bodies an update with no `from` is summarized against, and
 * `heldBackUpdateIndexes` the open update items an approval would hold back
 * for an invalid target.
 * `restoredItems` lists the items moved to Rejected and then restored from
 * there, with the ticket each one created.
 */
export async function loadProposalItemOutcomes(
	proposal: ProposalItemStateRow & {
		id: string;
		projectId: string;
		proposal: unknown;
	},
) {
	const [applications, duplicateResolutions] = await Promise.all([
		listProposalApplications(proposal.id),
		listProposalDuplicateResolutions(proposal.id),
	]);
	const rejectedChangeIndexes = readRejectedChangeIndexes(
		proposal.sourceMetadata,
	);
	const state = computeProposalItemState({
		changeCount: proposal.changeCount,
		appliedChangeIndexes: proposal.appliedChangeIndexes,
		applicationIndexes: applications.map((a) => a.changeIndex),
		duplicateIndexes: duplicateResolutions.map((d) => d.changeIndex),
		rejectedChangeIndexes,
	});
	const [updateTargets, heldBackUpdateIndexes, restoredItems] =
		await Promise.all([
			readUpdateTargets(proposal, state.resolved),
			listHeldBackUpdateIndexes(
				proposal.projectId,
				readProposalChanges(proposal.proposal),
				state.resolved,
			),
			rejectedChangeIndexes.length > 0
				? listRestoredProposalItems(proposal)
				: [],
		]);
	return {
		applications,
		createdChangeIndexes: applications.map((a) => a.changeIndex),
		duplicateResolutions,
		rejectedChangeIndexes,
		restoredItems,
		...itemStateFields(state),
		proposalRevision: proposalRevision(proposal.proposal),
		...updateTargets,
		heldBackUpdateIndexes,
	};
}
