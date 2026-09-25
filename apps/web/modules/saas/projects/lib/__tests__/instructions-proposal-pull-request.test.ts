/**
 * The card policy for a proposal that opens a pull request (Fizzy #2563 spec
 * §12): which line a card shows for each delivery state, which failure copy a
 * stored failure reads as, when the card offers Retry opening, Refresh and
 * Reconnect, and when the list keeps polling. Pure, so the dialog and these
 * tests share one answer.
 */
import {
	INSTRUCTION_PULL_REQUEST_FAILURE_CODES,
	type PullRequestFailure,
} from "@repo/database";
import en from "@repo/i18n/translations/en.json";
import { describe, expect, it } from "vitest";
import {
	canRetryOpening,
	offersPullRequestRefresh,
	offersReconnect,
	type ProposalPullRequest,
	PULL_REQUEST_POLL_MS,
	proposalListPollInterval,
	pullRequestCardLine,
	pullRequestFailureKey,
	REFRESH_COOLDOWN_MS,
	refreshHoldSeconds,
	refreshRetryAfterSeconds,
} from "../instructions-proposal-pull-request";

const copy = en.projects.codingInstructions.proposalReview.pullRequest;

function failure(
	code: PullRequestFailure["code"],
	overrides: Partial<PullRequestFailure> = {},
): PullRequestFailure {
	return {
		phase: "create",
		code,
		retryable: true,
		at: "2026-09-24T10:00:00.000Z",
		params: {},
		...overrides,
	};
}

function pr(overrides: Partial<ProposalPullRequest> = {}): ProposalPullRequest {
	return {
		operationId: "op_1",
		state: "QUEUED",
		url: null,
		externalId: null,
		failure: null,
		lastCheckedAt: null,
		attempt: 3,
		observation: null,
		mergeSync: null,
		...overrides,
	};
}

/** The copy a key names, under `proposalReview.pullRequest`. */
function text(key: string): unknown {
	return key
		.split(".")
		.reduce<unknown>(
			(node, part) =>
				node && typeof node === "object"
					? (node as Record<string, unknown>)[part]
					: undefined,
			copy,
		);
}

describe("failure copy (spec §11)", () => {
	// Verbatim from the spec's Copy column: one sentence per code, from
	// en.json by code, never stored on the row.
	const SPEC_COPY: Record<
		(typeof INSTRUCTION_PULL_REQUEST_FAILURE_CODES)[number],
		string
	> = {
		VALIDATION_REJECTED: "The proposed files did not pass validation.",
		VALIDATION_FAILED:
			"Validation could not finish. Try again to continue; the pull request opens once it passes.",
		VALIDATION_TIMEOUT:
			"Fabric is still checking the proposed files and will try again.",
		ATTRIBUTION_REJECTED:
			"Fabric could not attribute this change safely. Withdraw it and ask an owner to check the project name.",
		PERMISSION_REVOKED:
			"Your project access no longer permits this action.",
		CONFIGURATION_CHANGED:
			"The repository connection or instruction location changed. Sync and submit again.",
		TARGET_BRANCH_MISSING:
			"The branch this proposal targets no longer exists. Sync and submit again.",
		BASE_COMMIT_UNAVAILABLE:
			"The repository no longer provides the commit this proposal was based on. Sync and submit again.",
		TREE_CONFLICT:
			"A proposed file collides with a repository entry Fabric does not manage. Make this change in the repository.",
		AUTHENTICATION_FAILED:
			"The repository connection could not authenticate. Reconnect it; Fabric will retry.",
		REPOSITORY_UNAVAILABLE: "The connection cannot access this repository.",
		BRANCH_WRITE_REFUSED:
			"The repository refused the proposal branch. Check the connection's permissions and repository rules.",
		PR_CREATION_REFUSED:
			"The proposal branch exists, but the repository refused the pull request.",
		REMOTE_REF_CONFLICT:
			"The proposal branch was created or changed outside Fabric. Fabric did not overwrite or delete it.",
		LOOKUP_INCONCLUSIVE:
			"Fabric could not confirm the pull request's state and will check again.",
		CREATE_OUTCOME_UNKNOWN:
			"Fabric is checking whether the pull request was created.",
		PROVIDER_RATE_LIMITED:
			"The repository provider is temporarily unavailable. Fabric will retry.",
		PROVIDER_TEMPORARY:
			"The repository provider is temporarily unavailable. Fabric will retry.",
		CLOSE_REFUSED:
			"The repository refused to close the pull request. Close it there, or Fabric will retry.",
		CLOSE_CREDENTIALS_UNAVAILABLE:
			"Reconnect the repository to close this pull request.",
		STORAGE_FAILED:
			"Fabric could not read the proposed files. It will retry.",
		GIT_FAILED: "Fabric could not prepare the proposal branch.",
		LIMITS_EXCEEDED:
			"The repository is too large to prepare this proposal.",
		SYNC_START_FAILED:
			"The pull request merged; Fabric will sync the repository shortly.",
		MERGE_SYNC_FAILED:
			"The pull request merged, but Fabric could not sync it. Sync the repository manually.",
		UNEXPECTED: "Something went wrong. Fabric will retry.",
	};

	it.each([...INSTRUCTION_PULL_REQUEST_FAILURE_CODES])(
		"reads %s from en.json, verbatim from the spec",
		(code) => {
			const key = pullRequestFailureKey(failure(code));
			expect(text(key)).toBe(SPEC_COPY[code]);
		},
	);

	it("covers exactly the codes the database defines", () => {
		expect(Object.keys(copy.failures).sort()).toEqual(
			[...INSTRUCTION_PULL_REQUEST_FAILURE_CODES].sort(),
		);
	});

	it("says a day-old unknown create could not be confirmed once it stops being retryable", () => {
		expect(
			text(
				pullRequestFailureKey(
					failure("CREATE_OUTCOME_UNKNOWN", { retryable: false }),
				),
			),
		).toBe(
			"Fabric could not confirm whether the pull request was created.",
		);
	});

	it("gives a merge-sync give-up on a changed configuration its own copy (spec §9.1 step 5)", () => {
		expect(
			text(
				pullRequestFailureKey(
					failure("CONFIGURATION_CHANGED", {
						phase: "merge_sync",
						retryable: false,
					}),
				),
			),
		).toBe(
			"Merged; the repository configuration changed, sync it manually.",
		);
	});
});

describe("the card line for every state (spec §12)", () => {
	it.each([
		[pr({ state: "QUEUED" }), "READY", "states.QUEUED", "Checking files"],
		[
			pr({
				state: "QUEUED",
				failure: failure("VALIDATION_FAILED", { phase: "validation" }),
			}),
			"FAILED",
			"states.validationFailed",
			"Checks could not finish",
		],
		[
			pr({ state: "OPENING" }),
			"READY",
			"states.OPENING",
			"Opening pull request",
		],
		[pr({ state: "OPEN" }), "READY", "states.OPEN", "Pull request open"],
		[
			pr({ state: "CLOSE_REQUESTED" }),
			"READY",
			"states.CLOSE_REQUESTED",
			"Closing pull request",
		],
		[
			pr({ state: "CLOSED" }),
			"READY",
			"states.CLOSED",
			"Closed without merging",
		],
		[pr({ state: "CANCELED" }), "READY", "states.CANCELED", "Withdrawn"],
		[
			pr({
				state: "CANCELED",
				failure: failure("VALIDATION_REJECTED", {
					phase: "validation",
					retryable: false,
				}),
			}),
			"REJECTED",
			"states.rejectedByValidation",
			"Rejected by validation",
		],
		[pr({ state: "MERGED" }), "READY", "states.MERGED", "Merged"],
	] as const)("%#: shows %s", (value, snapshotStatus, key, expected) => {
		const line = pullRequestCardLine(value, snapshotStatus);
		expect(line.key).toBe(key);
		expect(text(line.key)).toBe(expected);
	});

	it("a QUEUED proposal whose checks FAILED before the workflow saw it still reads as not finished", () => {
		expect(pullRequestCardLine(pr({ state: "QUEUED" }), "FAILED").key).toBe(
			"states.validationFailed",
		);
	});

	it("BLOCKED reads as not opened, with the failure beside it", () => {
		const line = pullRequestCardLine(
			pr({
				state: "BLOCKED",
				failure: failure("BRANCH_WRITE_REFUSED", { phase: "push" }),
			}),
			"READY",
		);
		expect(text(line.key)).toBe("Pull request not opened yet");
		expect(line.failureKey).toBe("failures.BRANCH_WRITE_REFUSED");
		expect(line.failureAt).toBe("2026-09-24T10:00:00.000Z");
	});

	it("a non-retryable BLOCKED reads as not opened", () => {
		const line = pullRequestCardLine(
			pr({
				state: "BLOCKED",
				failure: failure("PR_CREATION_REFUSED", { retryable: false }),
			}),
			"READY",
		);
		expect(text(line.key)).toBe("Pull request not opened");
	});

	it("CLOSE_REQUESTED carries any failure", () => {
		const line = pullRequestCardLine(
			pr({
				state: "CLOSE_REQUESTED",
				failure: failure("CLOSE_REFUSED", { phase: "close" }),
			}),
			"READY",
		);
		expect(line.failureKey).toBe("failures.CLOSE_REFUSED");
	});

	it("OPEN carries its link and the age of its last check, never a failure", () => {
		const line = pullRequestCardLine(
			pr({
				state: "OPEN",
				url: "https://github.com/example-org/example-repo/pull/7",
				lastCheckedAt: "2026-09-24T10:05:00.000Z",
				failure: failure("LOOKUP_INCONCLUSIVE", { phase: "reconcile" }),
			}),
			"READY",
		);
		expect(line.checkedAt).toBe("2026-09-24T10:05:00.000Z");
		expect(line.failureKey).toBeUndefined();
	});

	it("MERGED with a pending merge-sync request says Syncing", () => {
		const line = pullRequestCardLine(
			pr({
				state: "MERGED",
				mergeSync: {
					requestedAt: "2026-09-24T10:00:00.000Z",
					runId: null,
					runStatus: null,
				},
			}),
			"READY",
		);
		expect(text(line.key)).toBe("Merged. Syncing the repository…");
	});

	it("MERGED shows a retryable start failure while it is still syncing", () => {
		const line = pullRequestCardLine(
			pr({
				state: "MERGED",
				failure: failure("SYNC_START_FAILED", { phase: "merge_sync" }),
				mergeSync: {
					requestedAt: "2026-09-24T10:00:00.000Z",
					runId: null,
					runStatus: null,
				},
			}),
			"READY",
		);
		expect(line.failureKey).toBe("failures.SYNC_START_FAILED");
	});

	it.each([
		["SUCCEEDED", "Merged and synced: the repository sync published it."],
		[
			"UNCHANGED",
			"Merged. The repository sync found nothing new to publish.",
		],
		[
			"REJECTED",
			"Merged, but the repository sync's checks rejected the merged files.",
		],
		["FAILED", "Merged, but the repository sync failed."],
		[
			"NOT_PUBLISHED",
			"Merged, but the repository sync did not publish it.",
		],
		["SKIPPED", "Merged, but the repository sync was skipped."],
	])(
		"MERGED with a finished %s sync names the run's outcome",
		(runStatus, expected) => {
			const line = pullRequestCardLine(
				pr({
					state: "MERGED",
					mergeSync: { requestedAt: null, runId: "run_1", runStatus },
				}),
				"READY",
			);
			expect(text(line.key)).toBe(expected);
		},
	);

	it("MERGED after a give-up shows the give-up copy", () => {
		const line = pullRequestCardLine(
			pr({
				state: "MERGED",
				failure: failure("MERGE_SYNC_FAILED", {
					phase: "merge_sync",
					retryable: false,
				}),
				mergeSync: {
					requestedAt: null,
					runId: "run_1",
					runStatus: null,
				},
			}),
			"READY",
		);
		expect(line.key).toBe("states.MERGED");
		expect(line.failureKey).toBe("failures.MERGE_SYNC_FAILED");
	});

	it("MERGED into a different branch says Fabric did not sync it", () => {
		const line = pullRequestCardLine(
			pr({
				state: "MERGED",
				observation: {
					targetRef: "release",
					targetMismatch: true,
					mergedAt: "2026-09-24T10:00:00.000Z",
					closedAt: null,
				},
			}),
			"READY",
		);
		expect(line.key).toBe("states.mergedElsewhere");
		expect(line.values).toEqual({ branch: "release" });
		expect(text(line.key)).toBe(
			"Merged into {branch}, a different branch; Fabric did not sync it",
		);
	});
});

describe("actions", () => {
	it.each([
		["CREATE_OUTCOME_UNKNOWN", false, true],
		["CREATE_OUTCOME_UNKNOWN", true, false],
		["PR_CREATION_REFUSED", false, true],
		["REMOTE_REF_CONFLICT", false, true],
		["BRANCH_WRITE_REFUSED", true, false],
		["PERMISSION_REVOKED", false, false],
	] as const)(
		"Retry opening on BLOCKED %s (retryable %s): %s",
		(code, retryable, offered) => {
			expect(
				canRetryOpening(
					pr({
						state: "BLOCKED",
						failure: failure(code, { retryable }),
					}),
				),
			).toBe(offered);
		},
	);

	it("never offers Retry opening outside BLOCKED", () => {
		expect(
			canRetryOpening(
				pr({
					state: "CLOSE_REQUESTED",
					failure: failure("REMOTE_REF_CONFLICT", {
						retryable: false,
					}),
				}),
			),
		).toBe(false);
	});

	it.each([
		["QUEUED", true],
		["OPENING", true],
		["OPEN", true],
		["BLOCKED", true],
		["CLOSE_REQUESTED", true],
		["MERGED", false],
		["CLOSED", false],
		["CANCELED", false],
	] as const)("Refresh on %s: %s", (state, offered) => {
		expect(offersPullRequestRefresh(pr({ state }))).toBe(offered);
	});

	it.each([
		["BLOCKED", "AUTHENTICATION_FAILED", true],
		["CLOSE_REQUESTED", "AUTHENTICATION_FAILED", true],
		// Reconnect is the AUTHENTICATION_FAILED action only; the
		// close-credentials copy already says what to do.
		["CLOSE_REQUESTED", "CLOSE_CREDENTIALS_UNAVAILABLE", false],
		["BLOCKED", "BRANCH_WRITE_REFUSED", false],
		["OPEN", "AUTHENTICATION_FAILED", false],
	] as const)("Reconnect on %s with %s: %s", (state, code, offered) => {
		expect(offersReconnect(pr({ state, failure: failure(code) }))).toBe(
			offered,
		);
	});

	it("holds Refresh for the server's one-minute ration after a press, as whole seconds left", () => {
		expect(REFRESH_COOLDOWN_MS).toBe(60_000);
		expect(refreshHoldSeconds(undefined, 1_000)).toBe(0);
		expect(refreshHoldSeconds(1_000 + REFRESH_COOLDOWN_MS, 1_000)).toBe(60);
		// Rounded up: a hold with 200 ms left still reads one second.
		expect(refreshHoldSeconds(1_200, 1_000)).toBe(1);
		expect(refreshHoldSeconds(1_000, 1_000)).toBe(0);
		expect(refreshHoldSeconds(900, 1_000)).toBe(0);
	});

	// The server is the boundary (spec §12): a refused Refresh
	// is TOO_MANY_REQUESTS with `data.retryAfter` in seconds, for its own
	// one-minute ration and for a provider's backoff alike.
	it.each([
		[
			{
				code: "TOO_MANY_REQUESTS",
				data: {
					reason: "PULL_REQUEST_REFRESH_COOLDOWN",
					retryAfter: 45,
				},
			},
			45,
		],
		[
			{
				code: "TOO_MANY_REQUESTS",
				data: {
					reason: "PULL_REQUEST_PROVIDER_RATE_LIMITED",
					retryAfter: 150,
				},
			},
			150,
		],
		[{ code: "TOO_MANY_REQUESTS", data: { retryAfter: 2.2 } }, 3],
		[{ code: "TOO_MANY_REQUESTS", data: { retryAfter: 0 } }, null],
		[{ code: "TOO_MANY_REQUESTS", data: { retryAfter: -4 } }, null],
		[{ code: "TOO_MANY_REQUESTS", data: { retryAfter: "45" } }, null],
		[{ code: "TOO_MANY_REQUESTS", data: { retryAfter: Number.NaN } }, null],
		[{ code: "TOO_MANY_REQUESTS" }, null],
		[{ code: "PRECONDITION_FAILED", data: { retryAfter: 45 } }, null],
		[null, null],
	] as const)("reads the server's wait from %j as %s", (error, seconds) => {
		expect(refreshRetryAfterSeconds(error)).toBe(seconds);
	});
});

describe("proposalListPollInterval", () => {
	const row = (
		proposalStatus: string,
		status: string,
		pullRequest: ProposalPullRequest | null,
	) => ({ proposalStatus, status, pullRequest });

	it("polls every 3 s while a proposal is being validated", () => {
		expect(
			proposalListPollInterval([row("PENDING", "VALIDATING", pr())]),
		).toBe(3_000);
	});

	it("polls every 10 s while a pull-request proposal is pending", () => {
		for (const state of [
			"QUEUED",
			"OPENING",
			"OPEN",
			"BLOCKED",
			"CLOSE_REQUESTED",
		] as const) {
			expect(
				proposalListPollInterval([
					row("PENDING", "READY", pr({ state })),
				]),
			).toBe(PULL_REQUEST_POLL_MS);
		}
		expect(PULL_REQUEST_POLL_MS).toBe(10_000);
	});

	it("keeps polling a MERGED proposal while its merge sync is requested, then stops", () => {
		expect(
			proposalListPollInterval([
				row(
					"MERGED",
					"READY",
					pr({
						state: "MERGED",
						mergeSync: {
							requestedAt: "2026-09-24T10:00:00.000Z",
							runId: null,
							runStatus: null,
						},
					}),
				),
			]),
		).toBe(PULL_REQUEST_POLL_MS);
		expect(
			proposalListPollInterval([
				row(
					"MERGED",
					"READY",
					pr({
						state: "MERGED",
						mergeSync: {
							requestedAt: null,
							runId: "run_1",
							runStatus: "SUCCEEDED",
						},
					}),
				),
			]),
		).toBe(false);
	});

	it("stops for settled states and for a FABRIC proposal waiting on a reviewer", () => {
		expect(
			proposalListPollInterval([
				row("CLOSED", "READY", pr({ state: "CLOSED" })),
				row("REJECTED", "READY", pr({ state: "CANCELED" })),
				row("PENDING", "READY", null),
			]),
		).toBe(false);
	});
});
