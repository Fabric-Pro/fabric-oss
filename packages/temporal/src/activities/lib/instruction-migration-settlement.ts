/**
 * The three moments of a move from uploads into the repository that the
 * member branch and sync machinery already pass through (Fizzy #2878 §9), and
 * what each owes the move:
 *
 * - the branch's pull request MERGED where the sync reads (`settleMigration
 *   ForObservedBranch`): the project switches to the repository, the pause
 *   comes off, and the normal merge-triggered sync runs against it;
 * - the pull request ended without its files landing (closed unmerged,
 *   merged into another branch, or closed by Fabric's own cancel): the move is
 *   over and uploads carry on (`abandonMigrationOfBranch`);
 * - the first sync from the repository succeeded (`settleMigrationAfter
 *   SuccessfulRun`): the move is complete.
 *
 * Each is called from a step that is retried and re-run, so each is idempotent
 * (the writers in `@repo/database` are), and each starts with a read that
 * costs one indexed select and takes no lock: a branch or a sync run that has
 * nothing to do with a move is the overwhelmingly common case and must not
 * take the project row's lock to find that out.
 *
 * Not exported through the activities barrel: every export of a module the
 * barrel re-exports is a schedulable activity.
 */
import {
	abandonInstructionMigration,
	type BranchRow,
	completeInstructionMigration,
	getOpenMigrationOfBranch,
	getProjectInstructionSettings,
	mergedElsewhere,
	settleInstructionMigrationAfterSync,
} from "@repo/database";
import { logger } from "@repo/logs";

type BranchOfAMove = Pick<
	BranchRow,
	| "id"
	| "projectId"
	| "organizationId"
	| "state"
	| "closeIntent"
	| "pullRequestUrl"
	| "pullRequestObservation"
>;

/**
 * The move was `PROPOSING` and its project was repository-backed anyway
 * (something flipped it behind the move's back), so its sync row was left
 * alone: one line, ids only, for whoever has to switch the project back.
 */
function logSourceFlipped(
	branch: Pick<BranchRow, "id" | "projectId" | "organizationId">,
	syncId: string,
): void {
	logger.warn(
		{
			event: "instruction_migration.source_flipped",
			projectId: branch.projectId,
			organizationId: branch.organizationId,
			branchId: branch.id,
			syncId,
		},
		"[CodingInstructions] A move from uploads ended but the project was already repository-backed; its sync row was left in place",
	);
}

/** The pointer's sync row when this branch carries the project's open move, else null. */
async function openMoveOf(
	branch: Pick<BranchRow, "id" | "projectId" | "organizationId">,
): Promise<{ syncId: string; state: "PROPOSING" | "SWITCHING" } | null> {
	const pointer = await getOpenMigrationOfBranch({
		projectId: branch.projectId,
		organizationId: branch.organizationId,
		branchId: branch.id,
	});
	return pointer === null
		? null
		: { syncId: pointer.syncId, state: pointer.state };
}

/**
 * A branch that was observed MERGED or CLOSED and is being classified: a
 * merge where the sync reads completes the move; a close, or a merge
 * elsewhere, abandons it. Idempotent, and a branch that carries no open move
 * is left alone.
 *
 * A close that is a START OVER's (`closeIntent`) is not the move ending: the
 * member's proposal is rehomed to a new branch and its pull request opens
 * again, so abandoning here would delete the sync row and the pointer under a
 * move that is carrying on. A merge is never a start over's.
 */
export async function settleMigrationForObservedBranch(
	branch: BranchOfAMove,
): Promise<void> {
	if (branch.state !== "MERGED" && branch.state !== "CLOSED") {
		return;
	}
	if (branch.state === "CLOSED" && branch.closeIntent === "START_OVER") {
		return;
	}
	const move = await openMoveOf(branch);
	if (move === null) {
		return;
	}
	const tenant = {
		projectId: branch.projectId,
		organizationId: branch.organizationId,
	};
	if (
		branch.state === "MERGED" &&
		!mergedElsewhere(branch.pullRequestObservation)
	) {
		await completeInstructionMigration({
			...tenant,
			branchId: branch.id,
			pullRequestUrl: branch.pullRequestUrl,
		});
		return;
	}
	const ended = await abandonInstructionMigration({
		...tenant,
		syncId: move.syncId,
		reason: "pull_request_closed",
	});
	if (ended === "source_flipped") {
		logSourceFlipped(branch, move.syncId);
	}
}

/**
 * A branch whose settlement ended CANCELED (Fabric closed its pull request:
 * the member canceled the move, or a start over): the move is over.
 */
export async function abandonMigrationOfBranch(
	branch: Pick<BranchRow, "id" | "projectId" | "organizationId">,
	reason: "canceled" | "pull_request_closed",
): Promise<void> {
	const move = await openMoveOf(branch);
	if (move === null || move.state !== "PROPOSING") {
		return;
	}
	const ended = await abandonInstructionMigration({
		projectId: branch.projectId,
		organizationId: branch.organizationId,
		syncId: move.syncId,
		reason,
	});
	if (ended === "source_flipped") {
		logSourceFlipped(branch, move.syncId);
	}
}

/**
 * A sync run that finished: when it succeeded for the sync row a switching
 * move is waiting on, the move is complete. A run that failed, was skipped
 * or published nothing leaves the move switching, and the sync's own schedule
 * tries again.
 */
export async function settleMigrationAfterSuccessfulRun(input: {
	projectId: string;
	organizationId: string;
	syncId: string;
	status: string;
	snapshotId: string | null;
}): Promise<void> {
	if (input.status !== "SUCCEEDED" && input.status !== "UNCHANGED") {
		return;
	}
	const settings = await getProjectInstructionSettings(
		input.projectId,
		input.organizationId,
	);
	const pointer = settings.migration;
	if (
		!pointer ||
		pointer.state !== "SWITCHING" ||
		pointer.syncId !== input.syncId
	) {
		return;
	}
	await settleInstructionMigrationAfterSync({
		projectId: input.projectId,
		organizationId: input.organizationId,
		syncId: input.syncId,
		snapshotId: input.snapshotId,
	});
}
