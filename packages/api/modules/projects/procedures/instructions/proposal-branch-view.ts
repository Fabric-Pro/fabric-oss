/**
 * The member proposal branch blocks every surface returns (Fizzy #2738 spec
 * §10 "Procedures, REST v1 and SDK"): the tab's procedures, the proposal's
 * `pullRequest` block, `submit-change.ts`, REST v1 and the SDK's hand-written
 * mirror (`packages/sdk/src/resources/instructions.ts`).
 *
 * Pure and free of Temporal and storage, so the v1 read routes can import it
 * without pulling either into their module graph. Nothing here is read from
 * a provider: the rows are the answer.
 */
import {
	type BranchRow,
	membershipStatusOf,
	type ProposalAppendSummary,
	type ProposalBranchAttachment,
	proposalAppendSummary,
} from "@repo/database";

/** A member branch's state (spec §4.4). */
type ProposalBranchState = BranchRow["state"];

/**
 * One member branch as the tab, the CLI and REST v1 show it (spec §10).
 * `pullRequest` is null until Fabric has the pull request's receipt;
 * its `state` is where the pull request itself stands.
 */
export type ProposalBranchView = {
	id: string;
	ref: string;
	number: number;
	state: ProposalBranchState;
	/**
	 * The branch's fencing attempt: every branch command (Close, Start over,
	 * Retry opening, Stop tracking) takes it as `expectedAttempt`, so the
	 * member acts on the branch as it was shown.
	 */
	attempt: number;
	/** "Your branch has commits made outside Fabric" (spec Decision 7). */
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

/** What a proposal's append did (spec §10 `append`). */
export type ProposalAppendView = ProposalAppendSummary;

function failureView(value: unknown): ProposalBranchView["failure"] {
	if (value === null || typeof value !== "object") {
		return null;
	}
	const f = value as {
		code?: unknown;
		retryable?: unknown;
		params?: unknown;
	};
	if (typeof f.code !== "string") {
		return null;
	}
	return {
		code: f.code,
		retryable: f.retryable === true,
		...(f.params !== null &&
		typeof f.params === "object" &&
		!Array.isArray(f.params) &&
		Object.keys(f.params).length > 0
			? { params: f.params as Record<string, unknown> }
			: {}),
	};
}

/**
 * The pull request's own state from the branch's (spec §4.4): MERGED and
 * CLOSED are the provider's observed outcome; a settled branch that found
 * none (CANCELED) never had an open one Fabric could show, so it reads as
 * closed; anything else with a receipt is still open.
 */
function pullRequestStateOf(
	state: ProposalBranchState,
): "OPEN" | "MERGED" | "CLOSED" {
	switch (state) {
		case "MERGED":
			return "MERGED";
		case "CLOSED":
		case "CANCELED":
			return "CLOSED";
		default:
			return "OPEN";
	}
}

/** A branch row as the §10 block. */
export function proposalBranchView(
	branch: Pick<
		BranchRow,
		| "id"
		| "ref"
		| "number"
		| "state"
		| "attempt"
		| "foreignTipAt"
		| "membership"
		| "failure"
		| "retiredAt"
		| "pullRequestUrl"
		| "pullRequestExternalId"
		| "lastCheckedAt"
	>,
): ProposalBranchView {
	return {
		id: branch.id,
		ref: branch.ref,
		number: branch.number,
		state: branch.state,
		attempt: branch.attempt,
		foreignCommits: branch.foreignTipAt !== null,
		membership: membershipStatusOf(branch.membership),
		failure: failureView(branch.failure),
		retired: branch.retiredAt !== null,
		pullRequest:
			branch.pullRequestUrl && branch.pullRequestExternalId
				? {
						url: branch.pullRequestUrl,
						externalId: branch.pullRequestExternalId,
						state: pullRequestStateOf(branch.state),
						lastCheckedAt:
							branch.lastCheckedAt?.toISOString() ?? null,
					}
				: null,
	};
}

/** A proposal's `append` block from its attachment to a branch. */
export function proposalAppendView(
	attachment: Pick<
		ProposalBranchAttachment,
		"branch" | "assignment" | "failure" | "ops"
	>,
): ProposalAppendView {
	return proposalAppendSummary(attachment);
}
