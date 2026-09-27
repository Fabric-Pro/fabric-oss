/**
 * The "Your branch" panel's policy (Fizzy #2738 spec §10 "Tab"): the line a
 * branch card shows for its own state, which actions it offers, and when the
 * panel keeps polling. Pure, so the panel and its tests share one answer —
 * the same shape `lib/instructions-proposal-pull-request.ts` gives the
 * per-proposal card.
 *
 * Every key here is relative to
 * `projects.codingInstructions.proposalReview.branch`. Failure copy still
 * comes from the shared `pullRequest.failures.*` namespace by `code` (spec
 * §9 says branch-level failures reuse #2563's codes), so this module reuses
 * `pullRequestFailureKey` rather than duplicating that mapping.
 */

import type { PullRequestFailure } from "@repo/database";
import { pullRequestFailureKey } from "../../../lib/instructions-proposal-pull-request";

/** The member branch's own delivery state (spec §4.4, exact). */
export type ProposalBranchState =
	| "PENDING"
	| "OPENING"
	| "OPEN"
	| "CLOSE_REQUESTED"
	| "BLOCKED"
	| "MERGED"
	| "CLOSED"
	| "CANCELED";

/**
 * A member branch as the panel needs it — the subset of the API's
 * `ProposalBranchView` (Fizzy #2738 spec §10) this policy reads.
 */
export type ProposalBranchLite = {
	id: string;
	ref: string;
	state: ProposalBranchState;
	/** The branch's fencing attempt, passed back as `expectedAttempt`. */
	attempt: number;
	foreignCommits: boolean;
	membership: "pending" | "done" | "unverified" | null;
	failure: {
		code: string;
		retryable: boolean;
		params?: Record<string, unknown>;
	} | null;
	retired: boolean;
	pullRequest: {
		url: string;
		externalId: string;
		state: "OPEN" | "MERGED" | "CLOSED";
		lastCheckedAt: string | null;
	} | null;
};

/** Branch states that still take branch commands (not yet settled). */
const UNRESOLVED = new Set<ProposalBranchState>([
	"PENDING",
	"OPENING",
	"OPEN",
	"BLOCKED",
	"CLOSE_REQUESTED",
]);

/** Every state Close is offered from: not already closing, not settled. */
const CLOSEABLE = new Set<ProposalBranchState>([
	"PENDING",
	"OPENING",
	"OPEN",
	"BLOCKED",
]);

/** What the panel's card says about one branch's own state. */
export type BranchCardLine = {
	/** The headline, under `branch.states`, unless a failure replaces it. */
	key: string;
	/** The stored failure's copy, from `pullRequest.failures.*` by code. */
	failureKey?: string;
	failureValues?: Record<string, string>;
	failureAt?: string;
	tone: "progress" | "success" | "neutral" | "error";
};

function paramsToValues(
	params: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
	const entries = Object.entries(params ?? {});
	return entries.length > 0
		? Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))
		: undefined;
}

/**
 * The branch card's line (spec §10 Tab): a failure replaces the generic
 * per-state headline outright, the same way a member branch proposal's
 * BLOCKED card reads (its own sentence is the whole line) — a branch's
 * failure is never merely decoration beside a state headline.
 *
 * `readOnly` (spec §10: "Reviewers see every member's branches read-only")
 * picks the `otherStates.*` copy instead of `states.*` for the headline, so a
 * reviewer looking at another member's branch never reads "your" about
 * someone else's. A failure keeps reading from the shared
 * `pullRequest.failures.*` namespace either way — that copy already reads
 * generically enough for a proposal's own BLOCKED card, which a reviewer can
 * already see today.
 */
export function branchCardLine(
	branch: ProposalBranchLite,
	options?: { readOnly?: boolean },
): BranchCardLine {
	if (branch.failure) {
		const failure = branch.failure as unknown as PullRequestFailure;
		const values = paramsToValues(branch.failure.params);
		return {
			key: pullRequestFailureKey(failure),
			...(values ? { failureValues: values } : {}),
			tone: "error",
		};
	}
	const tone: BranchCardLine["tone"] =
		branch.state === "MERGED"
			? "success"
			: branch.state === "OPEN"
				? "success"
				: branch.state === "CLOSED" || branch.state === "CANCELED"
					? "neutral"
					: "progress";
	return {
		key: `${options?.readOnly ? "otherStates" : "states"}.${branch.state}`,
		tone,
	};
}

/** "Close pull request" (Decision 11): while the branch still takes commands. */
export function offersClose(branch: ProposalBranchLite): boolean {
	return CLOSEABLE.has(branch.state);
}

/** "Retry opening" (spec §10 Actions): only `PR_CREATION_REFUSED`. */
export function offersRetryOpening(branch: ProposalBranchLite): boolean {
	return (
		branch.state === "BLOCKED" &&
		branch.failure?.code === "PR_CREATION_REFUSED"
	);
}

/**
 * "Start over on a new branch" (Decision 11): only a branch whose pull
 * request Fabric could not confirm opening, with no foreign commits — the
 * server re-checks both live, this only decides whether to offer the button.
 */
export function offersStartOver(branch: ProposalBranchLite): boolean {
	return (
		branch.state === "BLOCKED" &&
		branch.failure?.code === "CREATE_OUTCOME_UNKNOWN" &&
		branch.failure.retryable === false &&
		!branch.foreignCommits
	);
}

/** "Stop tracking" (Decision 19): only `REPOSITORY_CHANGED`. */
export function offersStopTracking(branch: ProposalBranchLite): boolean {
	return branch.failure?.code === "REPOSITORY_CHANGED";
}

/** Refresh re-reads a branch that has not settled yet. */
export function offersBranchRefresh(branch: ProposalBranchLite): boolean {
	return UNRESOLVED.has(branch.state);
}

/**
 * `refetchInterval` for `proposals.myBranch`: every 10 s while any shown
 * branch is unresolved, as the per-proposal pull-request poll does; off once
 * everything shown is settled.
 */
export function branchPanelPollInterval(
	branches: ReadonlyArray<Pick<ProposalBranchLite, "state">> | undefined,
): number | false {
	if (!branches || branches.length === 0) {
		return false;
	}
	return branches.some((b) => UNRESOLVED.has(b.state)) ? 10_000 : false;
}
