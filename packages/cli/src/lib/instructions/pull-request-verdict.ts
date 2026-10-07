import type {
	ProposalAppend,
	ProposalBranch,
	ProposalPullRequest,
	ProposalPullRequestFailure,
} from "@fabricorg/sdk";
import { fabricCommand } from "../launcher.js";
import { branchStoppedByFailure } from "./pull-request-wait.js";

export interface PushPullRequestStatus {
	operationId: string;
	state: string;
	url: string | null;
	failure: ProposalPullRequestFailure | null;
	timedOut: boolean;
	branch: ProposalBranch | null;
	append: ProposalAppend | null;
}

export function pushPullRequest(
	pullRequest: ProposalPullRequest,
	timedOut: boolean,
): PushPullRequestStatus {
	const branch = pullRequest.branch ?? null;
	return {
		operationId: pullRequest.operationId,
		state: pullRequest.state,
		url: branch?.pullRequest?.url ?? pullRequest.url,
		failure: pullRequest.failure,
		timedOut,
		branch,
		append: pullRequest.append ?? null,
	};
}

/**
 * Why Fabric could not open the pull request, by the stored failure's code.
 * The codes are the server's (`INSTRUCTION_PULL_REQUEST_FAILURE_CODES`); an
 * unlisted one is named rather than guessed at.
 */
const BLOCKED_REASONS: Record<string, string> = {
	ATTRIBUTION_REJECTED:
		"the project's name or your display name looks like an address, a link or a credential, so the commit could not name you safely",
	PERMISSION_REVOKED:
		"you no longer have permission to suggest changes to this project's repository",
	CONFIGURATION_CHANGED:
		"the project's repository settings changed after you suggested this; push again",
	TARGET_BRANCH_MISSING:
		"the repository branch the project syncs from no longer exists",
	BASE_COMMIT_UNAVAILABLE:
		"the commit this suggestion was based on is no longer in the repository; sync and push again",
	TREE_CONFLICT:
		"the repository changed the same files since your last sync; sync and push again",
	AUTHENTICATION_FAILED:
		"the project's repository connection needs to be reconnected",
	REPOSITORY_UNAVAILABLE: "the repository could not be reached",
	BRANCH_WRITE_REFUSED: "the repository refused the new branch",
	PR_CREATION_REFUSED: "the repository refused to open the pull request",
	REMOTE_REF_CONFLICT:
		"a branch with the same name already exists in the repository",
	CREATE_OUTCOME_UNKNOWN:
		"Fabric could not confirm whether the pull request was created",
	VALIDATION_TIMEOUT: "the files' checks did not finish in time",
	LIMITS_EXCEEDED:
		"the change is larger than Fabric can open as a pull request",
	PROVIDER_RATE_LIMITED: "the repository's provider is limiting requests",
	PROVIDER_TEMPORARY: "the repository's provider had a temporary problem",
	LOOKUP_INCONCLUSIVE: "Fabric could not confirm the pull request's state",
	// Member proposal branches (Fizzy #2738 spec §9). BRANCH_CONFLICT and
	// SUPERSEDED_BY_LATER_CHANGE name their paths, in `blockedReason`.
	BRANCH_MOVED: "your branch kept changing while Fabric was adding to it",
	BRANCH_NAME_UNAVAILABLE:
		"Fabric could not reserve a branch name for your pull request; ask an owner to remove old proposal branches",
	REPOSITORY_CHANGED:
		"the repository connection now points at another repository, so Fabric can no longer reach your pull request; close it in the repository, then stop tracking it in the Coding Instructions tab",
	PUSH_OUTCOME_UNKNOWN:
		"Fabric could not confirm whether this change reached your branch, which may have been changed outside Fabric; check the branch, then try again or withdraw it",
	BRANCH_MISSING: "your branch was deleted in the repository",
};

/**
 * How many paths a failure's `params.paths` lists at most: the server's
 * `pathParams` joins the first 20 with ", ", and `params.count` is them all.
 */
const FAILURE_PATHS_LISTED = 20;

/**
 * The failure's `params.paths` and, past those, how many more its
 * `params.count` says there are. Counted from the limit, never by splitting
 * the list: a repository path may itself contain ", ".
 */
function failurePaths(failure: { params?: Record<string, unknown> }): string {
	const paths = failure.params?.paths;
	const count = failure.params?.count;
	if (typeof paths !== "string" || paths === "") {
		return "some of its files";
	}
	return typeof count === "number" && count > FAILURE_PATHS_LISTED
		? `${paths} and ${count - FAILURE_PATHS_LISTED} more`
		: paths;
}

/** Why a pull request or a change on a branch is blocked, by its code. */
function blockedReason(failure: {
	code: string;
	params?: Record<string, unknown>;
}): string {
	switch (failure.code) {
		case "BRANCH_CONFLICT":
			return `files on your branch were changed outside Fabric (${failurePaths(failure)}), and Fabric does not overwrite them while the pull request is open; make this change on your branch in the repository, or wait until the pull request merges`;
		case "SUPERSEDED_BY_LATER_CHANGE":
			return `a newer change of yours already edits ${failurePaths(failure)}; use Try again to apply this one on top of it, or withdraw it`;
		default:
			return (
				BLOCKED_REASONS[failure.code] ??
				`it stopped with ${failure.code}`
			);
	}
}

/**
 * The sentence a push ends on for its pull request, and whether it is a
 * failure. `OPEN`, `MERGED`, `CLOSED`, a change already on the member's
 * branch and a wait that ran out exit 0; `BLOCKED`, any other `CANCELED` and
 * an earlier attempt's pending close exit 7.
 *
 * On a member branch (Fizzy #2738 spec §10) `OPEN` names the branch's pull
 * request: "Opened pull request" when this push saw the branch before it had
 * one, "Added to your pull request" otherwise.
 */
export function pullRequestVerdict(
	pullRequest: PushPullRequestStatus,
	{ waited, openedHere }: { waited: boolean; openedHere: boolean },
): { text: string; fails: boolean } {
	const url = pullRequest.url ? `: ${pullRequest.url}` : "";
	const branch = pullRequest.branch;
	if (!waited) {
		return {
			text: "Follow its pull request in the project's Coding Instructions tab.",
			fails: false,
		};
	}
	if (pullRequest.timedOut) {
		return {
			text: "The pull request is being opened; see the project's Coding Instructions tab.",
			fails: false,
		};
	}
	switch (pullRequest.state) {
		case "OPEN": {
			if (!branch) {
				return { text: `Pull request opened${url}`, fails: false };
			}
			// A merged or closed pull request is the outcome whatever failure
			// the branch also carries (classification can record
			// REPOSITORY_CHANGED on a settled branch): what it means for this
			// change is decided separately, so neither claims an open one.
			if (branch.state === "MERGED") {
				return {
					text: `Your pull request was merged${url} while this change was being added to it; see the project's Coding Instructions tab for whether it carried this change.`,
					fails: false,
				};
			}
			if (branch.state === "CLOSED") {
				return {
					text: `Your pull request was closed without merging${url} while this change was being added to it.`,
					fails: false,
				};
			}
			if (
				branch.failure &&
				(branch.state === "BLOCKED" || branchStoppedByFailure(branch))
			) {
				const next = branch.failure.retryable
					? "Fabric will try again on its own; see"
					: "See";
				const what = branch.pullRequest
					? `Your change is on your branch, but Fabric can no longer update its pull request${url}`
					: "Your change is on your branch, but Fabric could not open its pull request";
				return {
					text: `${what}: ${blockedReason(branch.failure)}. ${next} the project's Coding Instructions tab.`,
					fails: true,
				};
			}
			if (branch.state === "CLOSE_REQUESTED") {
				return {
					text: "Your pull request is being closed, and this change leaves with it; push again once it has closed.",
					fails: true,
				};
			}
			if (branch.state === "CANCELED") {
				return {
					text: "Your branch was closed before its pull request opened; push again.",
					fails: true,
				};
			}
			if (branch.pullRequest?.state === "OPEN") {
				return {
					text: openedHere
						? `Opened pull request ${branch.pullRequest.url}`
						: `Added to your pull request ${branch.pullRequest.url}`,
					fails: false,
				};
			}
			return {
				text: "Your change is on your branch and its pull request is being opened; see the project's Coding Instructions tab.",
				fails: false,
			};
		}
		case "MERGED":
			return {
				text: `Its pull request was already merged${url}. Run \`${fabricCommand("instructions sync")}\` once the project has synced it.`,
				fails: false,
			};
		case "CLOSED":
			return {
				text: `Its pull request was closed without merging${url}.`,
				fails: false,
			};
		case "CANCELED":
			if (pullRequest.failure?.code === "ALREADY_ON_BRANCH") {
				return {
					text: branch?.pullRequest
						? `Already on your branch; nothing to add. Your pull request: ${branch.pullRequest.url}`
						: "Already on your branch; nothing to add.",
					fails: false,
				};
			}
			return {
				text:
					pullRequest.failure?.code === "VALIDATION_REJECTED"
						? "The suggestion did not pass Fabric's checks, so no pull request was opened; see the project's Coding Instructions tab."
						: branch
							? "The suggestion was withdrawn before it was added to your pull request."
							: "The suggestion was withdrawn before a pull request was opened.",
				fails: true,
			};
		case "CLOSE_REQUESTED":
			return {
				text: "An earlier attempt at this change was withdrawn and its pull request is being closed; push again once it has closed.",
				fails: true,
			};
		case "BLOCKED": {
			// A change blocked before it reached the branch can carry its
			// branch's failure rather than one of its own.
			const failure = pullRequest.failure ?? branch?.failure ?? null;
			const reason = failure
				? blockedReason(failure)
				: "it stopped with an unknown failure";
			const next = failure?.retryable
				? "Fabric will try again on its own; see"
				: "See";
			const what = branch
				? "Fabric could not add this change to your pull request"
				: "Fabric could not open the pull request";
			return {
				text: `${what}: ${reason}. ${next} the project's Coding Instructions tab.`,
				fails: true,
			};
		}
		default:
			return {
				text: "The pull request is being opened; see the project's Coding Instructions tab.",
				fails: false,
			};
	}
}
