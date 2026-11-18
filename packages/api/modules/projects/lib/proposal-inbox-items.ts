import {
	computeProposalItemState,
	db,
	listProposalApplications,
	listProposalDuplicateResolutions,
	listProposalItemStates,
	type ProposalItemState,
	type ProposalItemStateRow,
	proposalRevision,
	readRejectedChangeIndexes,
	readStoredProposalChanges,
	targetChangedSinceProposal,
} from "@repo/database";

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
 * Indexes of the unresolved update items whose target ticket no longer has
 * the description or acceptance criteria the proposed diff was computed
 * against. Only Fabric tickets of the proposal's own project are compared.
 */
async function listTargetsChangedSinceProposal(
	proposal: { projectId: string; proposal: unknown },
	resolved: ReadonlySet<number>,
): Promise<number[]> {
	const updates = readStoredProposalChanges(proposal.proposal).flatMap(
		(change) =>
			change.action === "update" &&
			change.existingId !== null &&
			!resolved.has(change.index) &&
			(change.descriptionFrom !== null ||
				change.acceptanceCriteriaFrom !== null)
				? [{ change, storyId: change.existingId }]
				: [],
	);
	if (updates.length === 0) {
		return [];
	}
	const stories = await db.userStory.findMany({
		where: {
			id: { in: updates.map((update) => update.storyId) },
			projectId: proposal.projectId,
		},
		select: { id: true, description: true, acceptanceCriteria: true },
	});
	const byId = new Map(stories.map((story) => [story.id, story]));
	return updates
		.filter(({ change, storyId }) => {
			const story = byId.get(storyId);
			return !!story && targetChangedSinceProposal(change, story);
		})
		.map(({ change }) => change.index);
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
 * was edited after the proposal was analyzed.
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
	return {
		applications,
		createdChangeIndexes: applications.map((a) => a.changeIndex),
		duplicateResolutions,
		rejectedChangeIndexes,
		...itemStateFields(state),
		proposalRevision: proposalRevision(proposal.proposal),
		targetChangedSinceProposalIndexes:
			await listTargetsChangedSinceProposal(proposal, state.resolved),
	};
}
