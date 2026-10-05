/**
 * What a move of a project's uploaded coding instructions into its repository
 * looks like to a client (Fizzy #2878 §9): the stored pointer, with the state
 * a person sees read from the pull request's own rows each time.
 *
 * Only two states are stored (`PROPOSING` and `SWITCHING`, see
 * `@repo/database`'s pointer module). The rest are derived here from the
 * move's proposal, so they cannot go stale beside the rows that own them:
 *
 * - `PROPOSING`: the pull request is being prepared and opened;
 * - `OPEN`: it is open in the repository (`closing` while its close is
 *   settling);
 * - `BLOCKED`: it could not be opened or pushed, with the typed `failure`
 *   and whether a retry can help;
 * - `MERGED`: it merged, and the project has not switched yet (settlement is
 *   about to, or its step has to be repeated: `retry` finishes it);
 * - `SWITCHING`: the project is repository-backed and waits for its first
 *   sync from the repository to succeed;
 * - `ABANDONED`: the pull request ended without its files landing and the
 *   pointer has not been cleaned up yet (`cancel` or `retry` finishes it).
 *
 * `SYNCED` and a finished cancellation are not states of a move: the pointer
 * is gone, `getRepositoryMigration` answers `null`, and the project reports
 * its own source of truth.
 */
import type { InstructionMigrationPointer } from "@repo/database";
import type { ProposalPullRequestView } from "../proposal-pull-request";

export type RepositoryMigrationState =
	| "PROPOSING"
	| "OPEN"
	| "BLOCKED"
	| "MERGED"
	| "SWITCHING"
	| "ABANDONED";

export type RepositoryMigrationView = {
	state: RepositoryMigrationState;
	/** The pull request is being closed (a cancel is settling); `state` stays `OPEN` until it has. */
	closing: boolean;
	/** ISO 8601. */
	startedAt: string;
	/** The member who started it: the sync acts as them once the move is over. */
	startedByUserId: string;
	snapshotId: string | null;
	/** The member branch the move's pull request is on now. */
	branchId: string | null;
	syncId: string;
	pullRequest: {
		url: string;
		externalId: string;
		state: "OPEN" | "MERGED" | "CLOSED";
	} | null;
	/**
	 * The pull request merged into a branch other than the one the sync reads,
	 * so its files are not where the project will look: the move is
	 * `ABANDONED` (nothing switches), and a client says so.
	 */
	targetMismatch: boolean;
	/**
	 * Why it is `BLOCKED` (or what is wrong with an `OPEN` one): a typed code,
	 * never text. `SOURCE_FLIPPED` (not retryable) is a move whose project was
	 * switched to the repository by something other than the move: "switch to
	 * upload mode" is the way out.
	 */
	failure: { code: string; retryable: boolean } | null;
};

/** The pull request a branch-less proposal view or a branch's own block shows, in the move's terms. */
function pullRequestOf(
	view: ProposalPullRequestView | null,
	pointer: InstructionMigrationPointer,
): RepositoryMigrationView["pullRequest"] {
	const url = view?.url ?? pointer.pullRequestUrl;
	const externalId = view?.externalId ?? null;
	if (!url || !externalId) {
		return null;
	}
	const branch = view?.branch?.pullRequest;
	if (branch) {
		return { url, externalId, state: branch.state };
	}
	switch (view?.state) {
		case "MERGED":
			return { url, externalId, state: "MERGED" };
		case "CLOSED":
		case "CANCELED":
			return { url, externalId, state: "CLOSED" };
		default:
			return { url, externalId, state: "OPEN" };
	}
}

/**
 * What the move's own rows cannot say and the project and its branch do:
 * whether something flipped the project to the repository behind a move that is
 * still proposing (`sourceFlipped`), and whether the pull request merged into a
 * branch other than the one the sync reads (`targetMismatch`).
 */
export type RepositoryMigrationEvidence = {
	sourceFlipped: boolean;
	targetMismatch: boolean;
};

/** The failure a move that was flipped behind its back reads with: no retry fixes it, switching to upload mode ends it. */
const SOURCE_FLIPPED_FAILURE = {
	code: "SOURCE_FLIPPED",
	retryable: false,
} as const;

/** The state a person sees (see the module comment). */
export function repositoryMigrationState(
	pointer: Pick<InstructionMigrationPointer, "state">,
	proposal: Pick<
		ProposalPullRequestView,
		"state" | "failure" | "branch"
	> | null,
	evidence: RepositoryMigrationEvidence = {
		sourceFlipped: false,
		targetMismatch: false,
	},
): RepositoryMigrationState {
	if (pointer.state === "SWITCHING") {
		return "SWITCHING";
	}
	if (evidence.sourceFlipped) {
		// Nothing this move does can be trusted once the project it was made
		// for was flipped by something else: its sync row is that something's.
		return "BLOCKED";
	}
	if (proposal === null) {
		return "PROPOSING";
	}
	if (proposal.state === "MERGED" && evidence.targetMismatch) {
		// Merged into a branch the sync does not read: its files are not where
		// the project will look, so the move did not happen, whatever the
		// pull request says.
		return "ABANDONED";
	}
	const failure = proposal.failure ?? proposal.branch?.failure ?? null;
	switch (proposal.state) {
		case "QUEUED":
		case "OPENING":
			return failure === null ? "PROPOSING" : "BLOCKED";
		case "OPEN":
		case "CLOSE_REQUESTED":
			return "OPEN";
		case "BLOCKED":
			return "BLOCKED";
		case "MERGED":
			return "MERGED";
		case "CLOSED":
		case "CANCELED":
			return "ABANDONED";
		default: {
			const unreachable: never = proposal.state;
			return unreachable;
		}
	}
}

/** The move as a client reads it. */
export function repositoryMigrationView(
	pointer: InstructionMigrationPointer,
	proposal: ProposalPullRequestView | null,
	branchId: string | null,
	evidence: RepositoryMigrationEvidence = {
		sourceFlipped: false,
		targetMismatch: false,
	},
): RepositoryMigrationView {
	const failure = proposal?.failure ?? proposal?.branch?.failure ?? null;
	const sourceFlipped =
		evidence.sourceFlipped && pointer.state === "PROPOSING";
	return {
		state: repositoryMigrationState(pointer, proposal, evidence),
		closing: proposal?.state === "CLOSE_REQUESTED",
		startedAt: pointer.startedAt,
		startedByUserId: pointer.userId,
		snapshotId: pointer.snapshotId,
		branchId,
		syncId: pointer.syncId,
		pullRequest: pullRequestOf(proposal, pointer),
		targetMismatch: evidence.targetMismatch,
		failure: sourceFlipped
			? { ...SOURCE_FLIPPED_FAILURE }
			: failure === null
				? null
				: { code: failure.code, retryable: failure.retryable },
	};
}
