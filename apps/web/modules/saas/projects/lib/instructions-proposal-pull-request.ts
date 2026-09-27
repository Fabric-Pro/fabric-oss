/**
 * The Coding Instructions proposal card's pull-request policy (Fizzy #2563
 * spec §12, extended by Fizzy #2738 spec §9-§10 for a member proposal
 * branch): the line a card shows for each delivery state, the failure copy a
 * stored failure reads as, which actions the card offers, and when the list
 * keeps polling. Pure, so the dialog and its tests share one answer.
 *
 * Every key here is relative to `projects.codingInstructions.proposalReview.pullRequest`,
 * except where noted. Copy comes from `en.json` by failure `code`; the row
 * never stores copy (spec §11), and its `params` hold only safe values.
 *
 * A member branch proposal (spec §10) carries `branch` and `append`, both
 * null for any #2563 (v1) proposal. `state` stays the PROPOSAL's own; `branch`
 * only changes which copy a shared state reads as, never the state machine.
 */

import type {
	InstructionPullRequestFailureCode,
	PullRequestFailure,
} from "@repo/database";

type ProposalPullRequestState =
	| "QUEUED"
	| "OPENING"
	| "OPEN"
	| "CLOSE_REQUESTED"
	| "BLOCKED"
	| "MERGED"
	| "CLOSED"
	| "CANCELED";

/**
 * The `pullRequest` block `proposals.list` returns on a REPOSITORY row (the
 * API's `ProposalPullRequestStatus`), declared here the way
 * `InstructionsSnapshot` is: the JSON columns arrive as generic JSON and the
 * card reads them as the shapes they are.
 */
export type ProposalPullRequest = {
	operationId: string;
	state: ProposalPullRequestState;
	url: string | null;
	externalId: string | null;
	failure: PullRequestFailure | null;
	lastCheckedAt: string | Date | null;
	/** The row's pull-request attempt. */
	attempt: number;
	observation: {
		targetRef: string | null;
		targetMismatch: boolean;
		mergedAt: string | null;
		closedAt: string | null;
	} | null;
	mergeSync: {
		requestedAt: string | Date | null;
		runId: string | null;
		runStatus: string | null;
	} | null;
	/**
	 * The proposal's member branch (Fizzy #2738 spec §10 `ProposalBranchView`),
	 * null for a #2563 (v1) proposal. Only `ref` is read here; the branch
	 * panel reads the rest.
	 */
	branch?: { id: string; ref: string } | null;
	/** What this proposal's own append to its branch did (spec §10 `append`). */
	append?: {
		outcome: "appended" | "already_on_branch" | null;
		commitSha: string | null;
		membership: "included" | "unverified" | null;
	} | null;
};

/** The list polls while validation runs, as it always has. */
const PROPOSAL_VALIDATION_POLL_MS = 3_000;
/** Spec §12: a pending pull-request card is re-read every 10 s. */
export const PULL_REQUEST_POLL_MS = 10_000;
/**
 * How long Refresh stays unavailable after it is pressed: the server's own
 * ration, one admitted Refresh per pull request a minute
 * (`PULL_REQUEST_REFRESH_COOLDOWN_SECONDS`). A convenience, not the
 * boundary: the server refuses a press it would not admit with
 * TOO_MANY_REQUESTS and a `retryAfter`, and that wait replaces this one
 * (`refreshRetryAfterSeconds`).
 */
export const REFRESH_COOLDOWN_MS = 60_000;

const UNRESOLVED = new Set<ProposalPullRequestState>([
	"QUEUED",
	"OPENING",
	"OPEN",
	"BLOCKED",
	"CLOSE_REQUESTED",
]);

const VALIDATING = new Set(["RECEIVING", "VALIDATING"]);

/** The finished merge-sync run statuses a MERGED card names. */
const MERGE_SYNC_OUTCOMES = new Set([
	"SUCCEEDED",
	"UNCHANGED",
	"REJECTED",
	"FAILED",
	"NOT_PUBLISHED",
	"SKIPPED",
]);

/**
 * The failure copy key for a stored failure. Two codes read differently by
 * context: a day-old unknown create that stopped being retryable says it
 * could not be confirmed (spec §11), and a merge sync given up on a changed
 * configuration says so (spec §9.1 step 5).
 */
export function pullRequestFailureKey(failure: PullRequestFailure): string {
	if (failure.code === "CREATE_OUTCOME_UNKNOWN" && !failure.retryable) {
		return "createOutcomeUnknownFinal";
	}
	if (
		failure.code === "CONFIGURATION_CHANGED" &&
		failure.phase === "merge_sync"
	) {
		return "mergeSyncConfigurationChanged";
	}
	return `failures.${failure.code satisfies InstructionPullRequestFailureCode}`;
}

/** What one card says about its pull request. */
export type PullRequestCardLine = {
	/** The headline, under `pullRequest`. */
	key: string;
	values?: Record<string, string>;
	/** The stored failure's copy, when the state shows one. */
	failureKey?: string;
	/** `{paths}` etc. for the failure copy (spec §9), from `failure.params`. */
	failureValues?: Record<string, string>;
	/** When that failure was recorded, for its age. */
	failureAt?: string;
	/** An OPEN card's last check, for "Checked <age>". */
	checkedAt?: string | Date;
	tone: "progress" | "success" | "neutral" | "error";
	/**
	 * MERGED or CLOSED with an append Fabric could not confirm was in the
	 * finished pull request (spec §10 Card: "as #2563, plus the unverified
	 * note").
	 */
	showUnverifiedNote?: boolean;
};

/** `failure.params` as `t()` values: every value stringified. */
function paramsToValues(
	params: PullRequestFailure["params"] | undefined,
): Record<string, string> | undefined {
	const entries = Object.entries(params ?? {});
	return entries.length > 0
		? Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))
		: undefined;
}

function withFailure(
	line: PullRequestCardLine,
	failure: PullRequestFailure | null,
): PullRequestCardLine {
	if (!failure) {
		return line;
	}
	const failureValues = paramsToValues(failure.params);
	return {
		...line,
		failureKey: pullRequestFailureKey(failure),
		failureAt: failure.at,
		...(failureValues ? { failureValues } : {}),
	};
}

/**
 * A member branch proposal's BLOCKED card (spec §10 Card: "the failure
 * copy"): the failure's own sentence is the whole line, since the shared
 * branch's pull request may already be open — "Pull request not opened yet"
 * would be wrong when only this proposal's append failed. `failureAt` still
 * carries the failure's age for "Recorded <time>".
 */
function branchBlockedLine(
	failure: PullRequestFailure | null,
): PullRequestCardLine {
	if (!failure) {
		return { key: "states.BLOCKED", tone: "error" };
	}
	const values = paramsToValues(failure.params);
	return {
		key: pullRequestFailureKey(failure),
		...(values ? { values } : {}),
		failureAt: failure.at,
		tone: "error",
	};
}

/**
 * The card's line for each state of spec §12. `snapshotStatus` is the
 * proposal's own validation status: a QUEUED row whose checks FAILED reads as
 * not finished even before the workflow records `VALIDATION_FAILED`.
 * "Merged" never claims the change was published in Fabric: the sync's own
 * outcome does, once it has one (spec §11).
 */
export function pullRequestCardLine(
	pr: ProposalPullRequest,
	snapshotStatus: string,
): PullRequestCardLine {
	const unverified = pr.append?.membership === "unverified";
	switch (pr.state) {
		case "QUEUED": {
			if (
				snapshotStatus === "FAILED" ||
				pr.failure?.code === "VALIDATION_FAILED"
			) {
				return {
					key: "states.validationFailed",
					failureKey: "failures.VALIDATION_FAILED",
					tone: "error",
				};
			}
			if (pr.branch) {
				// A branch's changes append one at a time; a READY change may
				// still be waiting its turn (spec §10 Card).
				const stillChecking =
					snapshotStatus === "RECEIVING" ||
					snapshotStatus === "VALIDATING";
				return {
					key: stillChecking
						? "states.waitingForChecks"
						: "states.queuedForBranch",
					tone: "progress",
				};
			}
			return { key: "states.QUEUED", tone: "progress" };
		}
		case "OPENING":
			return {
				key: pr.branch ? "states.addingToBranch" : "states.OPENING",
				tone: "progress",
			};
		case "OPEN":
			return {
				key: pr.branch ? "states.onBranch" : "states.OPEN",
				tone: "success",
				...(pr.lastCheckedAt ? { checkedAt: pr.lastCheckedAt } : {}),
			};
		case "CLOSE_REQUESTED":
			return withFailure(
				{
					key: pr.branch
						? "states.withdrawingFromBranch"
						: "states.CLOSE_REQUESTED",
					tone: "progress",
				},
				pr.failure,
			);
		case "BLOCKED":
			return pr.branch
				? branchBlockedLine(pr.failure)
				: withFailure(
						{
							key:
								pr.failure?.retryable === false
									? "states.blockedFinal"
									: "states.BLOCKED",
							tone: "error",
						},
						pr.failure,
					);
		case "MERGED":
			return {
				...mergedLine(pr),
				...(unverified ? { showUnverifiedNote: true } : {}),
			};
		case "CLOSED":
			return {
				key: "states.CLOSED",
				tone: "neutral",
				...(unverified ? { showUnverifiedNote: true } : {}),
			};
		case "CANCELED":
			if (pr.failure?.code === "VALIDATION_REJECTED") {
				return { key: "states.rejectedByValidation", tone: "neutral" };
			}
			if (pr.append?.outcome === "already_on_branch") {
				return { key: "states.alreadyOnBranch", tone: "neutral" };
			}
			if (pr.append?.outcome === "appended") {
				return { key: "states.withdrawnFromBranch", tone: "neutral" };
			}
			return { key: "states.CANCELED", tone: "neutral" };
	}
}

function mergedLine(pr: ProposalPullRequest): PullRequestCardLine {
	if (pr.observation?.targetMismatch) {
		return {
			key: "states.mergedElsewhere",
			values: { branch: pr.observation.targetRef ?? "" },
			tone: "neutral",
		};
	}
	// A give-up is the row's non-retryable merge_sync failure (spec §9.1).
	if (pr.failure?.phase === "merge_sync" && !pr.failure.retryable) {
		return withFailure({ key: "states.MERGED", tone: "error" }, pr.failure);
	}
	if (pr.mergeSync?.requestedAt) {
		return withFailure(
			{ key: "states.mergedSyncing", tone: "progress" },
			pr.failure?.phase === "merge_sync" ? pr.failure : null,
		);
	}
	const runStatus = pr.mergeSync?.runStatus;
	if (runStatus && MERGE_SYNC_OUTCOMES.has(runStatus)) {
		return {
			key: `mergeSyncOutcomes.${runStatus}`,
			tone: runStatus === "SUCCEEDED" ? "success" : "neutral",
		};
	}
	return { key: "states.MERGED", tone: "success" };
}

/**
 * "Try again" on a member branch proposal's BLOCKED card (spec §10 Card:
 * "Try again on both conflict codes and on PUSH_OUTCOME_UNKNOWN"), by
 * `proposals.retryConflict`. Distinct from the branch panel's "Retry
 * opening", a branch command on the branch's own failure, and from the
 * FABRIC "Try again" (`finalize`) offered on a QUEUED validation failure.
 */
export function canRetryConflict(pr: ProposalPullRequest): boolean {
	if (!pr.branch || pr.state !== "BLOCKED" || !pr.failure) {
		return false;
	}
	return (
		pr.failure.code === "BRANCH_CONFLICT" ||
		pr.failure.code === "SUPERSEDED_BY_LATER_CHANGE" ||
		pr.failure.code === "PUSH_OUTCOME_UNKNOWN"
	);
}

/**
 * "Propose again" on an unverified, finished branch proposal (spec Decision
 * 14, §10 Card): Fabric could not confirm the append was in the pull request
 * before it settled, so the change's author may move it to the current
 * branch.
 */
export function canProposeAgain(pr: ProposalPullRequest): boolean {
	if (!pr.branch || pr.append?.membership !== "unverified") {
		return false;
	}
	return (
		pr.state === "MERGED" ||
		pr.state === "CLOSED" ||
		pr.state === "CANCELED"
	);
}

/**
 * Which Withdraw confirm text a card shows (spec §10 Copy: "`withdrawConfirm`:
 * split into a pre-append and a post-append version"). A #2563 (v1)
 * proposal keeps its single `withdrawConfirm`; a branch proposal reads
 * `branch.withdrawConfirmPending` before its change ever reached the branch,
 * or `branch.withdrawConfirmAppended` once it did (or the branch could not
 * confirm whether it did).
 */
export function withdrawConfirmVariant(
	pr: ProposalPullRequest,
): "v1" | "pending" | "appended" {
	if (!pr.branch) {
		return "v1";
	}
	return pr.append?.outcome === "appended" ? "appended" : "pending";
}

/** Refresh asks for a fresh look at a row that is not settled yet. */
export function offersPullRequestRefresh(pr: ProposalPullRequest): boolean {
	return UNRESOLVED.has(pr.state);
}

/**
 * A card whose opening or closing failed to authenticate with the
 * repository offers the way to reconnect it. Only AUTHENTICATION_FAILED:
 * every other failure's copy says what to do about it.
 */
export function offersReconnect(pr: ProposalPullRequest): boolean {
	return (
		(pr.state === "BLOCKED" || pr.state === "CLOSE_REQUESTED") &&
		pr.failure?.code === "AUTHENTICATION_FAILED"
	);
}

/**
 * Whole seconds Refresh stays held until `heldUntil` (epoch ms), rounded
 * up so the button never reads "0 s" while it is still disabled; 0 when it
 * is free.
 */
export function refreshHoldSeconds(
	heldUntil: number | undefined,
	now: number,
): number {
	if (heldUntil === undefined || heldUntil <= now) {
		return 0;
	}
	return Math.ceil((heldUntil - now) / 1_000);
}

/**
 * The wait a refused Refresh names, in whole seconds: TOO_MANY_REQUESTS with
 * `data.retryAfter` (phase C), for the server's one-minute ration and a
 * provider's backoff alike. The server is the boundary, so its number
 * replaces the client's own hold. Anything else, or a wait that is not a
 * positive number, is `null`.
 */
export function refreshRetryAfterSeconds(error: unknown): number | null {
	if (typeof error !== "object" || error === null) {
		return null;
	}
	const { code, data } = error as {
		code?: unknown;
		data?: { retryAfter?: unknown };
	};
	const retryAfter = data?.retryAfter;
	if (
		code !== "TOO_MANY_REQUESTS" ||
		typeof retryAfter !== "number" ||
		!Number.isFinite(retryAfter) ||
		retryAfter <= 0
	) {
		return null;
	}
	return Math.ceil(retryAfter);
}

/**
 * `refetchInterval` for `proposals.list`: every 3 s while a pending proposal
 * is being validated; every 10 s while a pull-request proposal is pending
 * (QUEUED, OPENING, OPEN, BLOCKED, CLOSE_REQUESTED) or a MERGED one has a
 * merge sync requested; not at all once everything shown is settled.
 */
export function proposalListPollInterval(
	rows:
		| ReadonlyArray<{
				proposalStatus: string;
				status: string;
				pullRequest?: ProposalPullRequest | null;
		  }>
		| undefined,
): number | false {
	if (!rows) {
		return false;
	}
	if (
		rows.some(
			(row) =>
				row.proposalStatus === "PENDING" && VALIDATING.has(row.status),
		)
	) {
		return PROPOSAL_VALIDATION_POLL_MS;
	}
	return rows.some((row) => {
		const pr = row.pullRequest;
		if (!pr) {
			return false;
		}
		return (
			UNRESOLVED.has(pr.state) ||
			(pr.state === "MERGED" && Boolean(pr.mergeSync?.requestedAt))
		);
	})
		? PULL_REQUEST_POLL_MS
		: false;
}
