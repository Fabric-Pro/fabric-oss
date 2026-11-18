import { ORPCError } from "@orpc/server";
import {
	db,
	getPendingBacklogProposal,
	type PendingBacklogProposalStatus,
	proposalRevision,
	readRejectedChangeIndexes,
} from "@repo/database";
import { isFabricDbId } from "@repo/temporal/resolve-backlog-update-target";

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
	title: { to: string };
}

/**
 * Refuse the whole approval before anything is claimed or applied when an
 * update names a Fabric work item that is not in this project (wrong,
 * foreign, or deleted target). Non-Fabric ids (PM card ids) keep their
 * apply-time resolution path.
 */
export async function assertUpdateTargetsInProject(
	projectId: string,
	changes: readonly UpdateTargetChange[],
): Promise<void> {
	const updates = changes.filter(
		(change): change is UpdateTargetChange & { existingId: string } =>
			change.action === "update" && isFabricDbId(change.existingId),
	);
	if (updates.length === 0) {
		return;
	}
	const found = await db.userStory.findMany({
		where: {
			projectId,
			id: { in: Array.from(new Set(updates.map((u) => u.existingId))) },
		},
		select: { id: true },
	});
	const inProject = new Set(found.map((story) => story.id));
	const missing = updates.find((u) => !inProject.has(u.existingId));
	if (!missing) {
		return;
	}
	const title = missing.title.to.trim().slice(0, TITLE_MAX_LENGTH);
	const target = missing.existingIdentifier?.trim() || "the selected ticket";
	throw new ORPCError("BAD_REQUEST", {
		message: `“${title}” can't update ${target}: it is not a work item in this project. Pick another target or create a new ticket.`,
	});
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
