import { ORPCError } from "@orpc/server";
import {
	db,
	getPendingBacklogProposal,
	type PendingBacklogProposalStatus,
	proposalRevision,
	readRejectedChangeIndexes,
} from "@repo/database";
import {
	isFabricDbId,
	type ResolvableBacklogItem,
	resolveBacklogUpdateTarget,
} from "@repo/temporal/resolve-backlog-update-target";

const TITLE_MAX_LENGTH = 200;

/** Message shared by every refusal of an already-actioned proposal or item. */
export const PROPOSAL_ALREADY_ACTIONED_MESSAGE =
	"This proposal has already been approved or rejected perhaps by another user.";

/**
 * Statuses a Slack or Teams approval admits: the review states, plus a
 * deferred proposal approved out of the Rejected list.
 */
export const APPROVABLE_PROPOSAL_STATUSES: readonly PendingBacklogProposalStatus[] =
	["PENDING", "FAILED", "BACKLOG"];

/** Refusal when the proposal changed after the reviewer loaded it. */
export const PROPOSAL_CHANGED_MESSAGE =
	"This proposal changed after you opened it. Reopen it to review the latest version.";

/**
 * Refuse an approval built from an older version of the proposal, such as a
 * view loaded before a manual entry was merged into one of its items. Older
 * clients send no revision and are fenced by the claim alone.
 */
export function assertProposalRevision(
	storedProposal: unknown,
	expectedRevision: string | undefined,
): void {
	if (
		expectedRevision !== undefined &&
		expectedRevision !== proposalRevision(storedProposal)
	) {
		throw new ORPCError("CONFLICT", { message: PROPOSAL_CHANGED_MESSAGE });
	}
}

/**
 * The CONFLICT for a claim that lost its compare-and-set: the proposal
 * changed when it is still open in one of `openStatuses` (another item was
 * resolved or merged into), otherwise someone already actioned it.
 */
export async function lostClaimConflict(
	proposalId: string,
	openStatuses: readonly PendingBacklogProposalStatus[],
) {
	const current = await getPendingBacklogProposal(proposalId);
	return new ORPCError("CONFLICT", {
		message:
			current && openStatuses.includes(current.status)
				? PROPOSAL_CHANGED_MESSAGE
				: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
	});
}

interface UpdateTargetChange {
	action: "create" | "update";
	existingId?: string | null;
	existingIdentifier?: string | null;
	existingExternalId?: string | null;
	title: { from?: string | null; to: string };
}

/** An update whose target is not a work item in this project. */
interface InvalidUpdateTarget<T extends UpdateTargetChange> {
	change: T;
	/** Names the item and its target, for the reviewer. */
	message: string;
}

function namesTarget(change: UpdateTargetChange): boolean {
	return [
		change.existingId,
		change.existingIdentifier,
		change.existingExternalId,
	].some((reference) => !!reference?.trim());
}

function invalidTargetMessage(change: UpdateTargetChange): string {
	const title = change.title.to.trim().slice(0, TITLE_MAX_LENGTH);
	const target =
		change.existingIdentifier?.trim() ||
		change.existingExternalId?.trim() ||
		"the selected ticket";
	return `“${title}” can't update ${target}: it is not a work item in this project. Pick another target or create a new ticket.`;
}

function fabricIdOf(change: UpdateTargetChange): string | null {
	return change.existingId && isFabricDbId(change.existingId)
		? change.existingId
		: null;
}

/** Distinct non-empty values. */
function distinct(values: readonly (string | null | undefined)[]): string[] {
	return Array.from(
		new Set(values.filter((value): value is string => !!value)),
	);
}

/**
 * The project's tickets any of `updates` could resolve to: by Fabric id, or,
 * for any other reference, by identifier, PM card id or title, the
 * strategies the apply resolves with. Only those tickets are read, not the
 * whole project.
 */
async function candidateTargets(
	projectId: string,
	updates: readonly UpdateTargetChange[],
): Promise<ResolvableBacklogItem[]> {
	const others = updates.filter((change) => !fabricIdOf(change));
	const titles = distinct(
		others.map((change) => change.title.from || change.title.to),
	);
	const fabricIds = distinct(updates.map(fabricIdOf));
	const identifiers = distinct(
		others.map((change) => change.existingIdentifier),
	);
	const externalIds = distinct(
		others.map((change) => change.existingExternalId),
	);
	return await db.userStory.findMany({
		where: {
			projectId,
			OR: [
				...(fabricIds.length > 0 ? [{ id: { in: fabricIds } }] : []),
				...(identifiers.length > 0
					? [{ identifier: { in: identifiers } }]
					: []),
				...(externalIds.length > 0
					? [{ externalId: { in: externalIds } }]
					: []),
				...titles.map((title) => ({
					title: { equals: title, mode: "insensitive" as const },
				})),
			],
		},
		select: { id: true, identifier: true, title: true, externalId: true },
	});
}

/**
 * Every update whose named target is not a work item in this project (a
 * wrong, foreign or deleted ticket), each with a message naming the item and
 * its target. A Fabric id must be a ticket of this project; any other
 * reference (an identifier or a PM card id) must resolve the way the apply
 * resolves it. An update that names no target keeps its apply-time handling.
 */
async function findInvalidUpdateTargets<T extends UpdateTargetChange>(
	projectId: string,
	changes: readonly T[],
): Promise<InvalidUpdateTarget<T>[]> {
	const updates = changes.filter(
		(change) => change.action === "update" && namesTarget(change),
	);
	if (updates.length === 0) {
		return [];
	}
	const stories = await candidateTargets(projectId, updates);
	const inProject = new Set(stories.map((story) => story.id));
	return updates
		.filter((change) => {
			const id = fabricIdOf(change);
			return id
				? !inProject.has(id)
				: resolveBacklogUpdateTarget(stories, change).status ===
						"unresolved";
		})
		.map((change) => ({ change, message: invalidTargetMessage(change) }));
}

/**
 * Refuse the whole AI Update apply before anything is claimed or applied
 * when an update names a Fabric work item that is not in this project
 * (wrong, foreign, or deleted target), naming every such item. Non-Fabric
 * references (PM card ids, identifiers) keep their apply-time resolution,
 * which turns an unresolved one into a create. Proposal approvals and
 * retries use the stricter {@link holdBackInvalidUpdateTargets}.
 */
export async function assertUpdateTargetsInProject(
	projectId: string,
	changes: readonly UpdateTargetChange[],
): Promise<void> {
	const invalid = await findInvalidUpdateTargets(
		projectId,
		changes.filter((change) => fabricIdOf(change) !== null),
	);
	if (invalid.length > 0) {
		throw new ORPCError("BAD_REQUEST", {
			message: invalid.map((entry) => entry.message).join("\n"),
		});
	}
}

/** The updates held back for an invalid target, and why. */
export interface HeldBackTargets<T> {
	heldBack: ReadonlySet<T>;
	refusals: string[];
}

/**
 * Split off every update in `pending` whose target is not a work item in
 * this project: those items are left out of the apply and stay in review,
 * and `refusals` names each one. Never refuses; a retry with nothing left to
 * replay returns the proposal to review.
 */
export async function partitionUpdateTargets<T extends UpdateTargetChange>(
	projectId: string,
	pending: readonly T[],
): Promise<HeldBackTargets<T>> {
	const invalid = await findInvalidUpdateTargets(projectId, pending);
	return {
		heldBack: new Set(invalid.map((entry) => entry.change)),
		refusals: invalid.map((entry) => entry.message),
	};
}

/**
 * The indexes of a proposal's open update items that an approval would hold
 * back, by the rule {@link partitionUpdateTargets} applies, so the review can
 * say so before anything is submitted. `resolved` items are not checked.
 */
export async function listHeldBackUpdateIndexes(
	projectId: string,
	changes: readonly UpdateTargetChange[],
	resolved: ReadonlySet<number>,
): Promise<number[]> {
	const open = changes.flatMap((change, index) =>
		!resolved.has(index) && typeof change.title?.to === "string"
			? [{ change, index }]
			: [],
	);
	const { heldBack } = await partitionUpdateTargets(
		projectId,
		open.map(({ change }) => change),
	);
	return open
		.filter(({ change }) => heldBack.has(change))
		.map(({ index }) => index);
}

/**
 * {@link partitionUpdateTargets} for a proposal approval: the other items
 * still apply, and the request is refused when every item in `pending` is
 * held back, since the reviewer is there to pick another target.
 */
export async function holdBackInvalidUpdateTargets<
	T extends UpdateTargetChange,
>(projectId: string, pending: readonly T[]): Promise<HeldBackTargets<T>> {
	const targets = await partitionUpdateTargets(projectId, pending);
	if (
		targets.refusals.length > 0 &&
		targets.refusals.length === pending.length
	) {
		throw new ORPCError("BAD_REQUEST", {
			message: targets.refusals.join("\n"),
		});
	}
	return targets;
}

/**
 * Refuse an approval that names an item already moved to Rejected, or an
 * item already applied. Applied items are skipped instead (idempotent retry)
 * when `allowApplied` is set: a FAILED proposal's retry resubmits them.
 */
export function assertProposalItemsUnresolved(params: {
	indexes: readonly number[];
	applied: ReadonlySet<number>;
	sourceMetadata: unknown;
	allowApplied: boolean;
}): void {
	const rejected = new Set(readRejectedChangeIndexes(params.sourceMetadata));
	const blocked = (index: number) =>
		rejected.has(index) ||
		(!params.allowApplied && params.applied.has(index));
	if (params.indexes.some(blocked)) {
		throw new ORPCError("CONFLICT", {
			message: PROPOSAL_ALREADY_ACTIONED_MESSAGE,
		});
	}
}
