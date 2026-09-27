/**
 * A REPOSITORY proposal's pull request as the API reads, reports and
 * refreshes it (Fizzy #2563 spec §12). Reads are the row's, never the
 * provider's. A refresh wakes the member branch a proposal is on (Fizzy
 * #2738); #2563's per-proposal workflow, its starts and its Retry opening
 * were retired with that path (Fizzy #2748), so nothing here starts one.
 * The admission start is `proposal-branch-start.test.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getProposalOperation: vi.fn(),
	getInstructionProposal: vi.fn(),
	getSyncRunReceiptByRunId: vi.fn(),
	requestPullRequestRefresh: vi.fn(),
	transitionPullRequest: vi.fn(),
	proposalBranchIdOf: vi.fn(),
	wakeBranchAfterCommand: vi.fn(),
	canReviewInstructionProposals: vi.fn(),
	correlationId: null as string | null,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({ workflow: { start: m.start } }),
}));
vi.mock("@repo/database", () => ({
	getProposalOperation: (...a: unknown[]) => m.getProposalOperation(...a),
	getInstructionProposal: (...a: unknown[]) => m.getInstructionProposal(...a),
	getSyncRunReceiptByRunId: (...a: unknown[]) =>
		m.getSyncRunReceiptByRunId(...a),
	requestPullRequestRefresh: (...a: unknown[]) =>
		m.requestPullRequestRefresh(...a),
	transitionPullRequest: (...a: unknown[]) => m.transitionPullRequest(...a),
	// Reads see no member branch here (Fizzy #2738): those have their own
	// suite, `proposal-branch-procedures.test.ts`.
	readProposalBranchAttachments: async () => new Map(),
	proposalBranchIdOf: (...a: unknown[]) => m.proposalBranchIdOf(...a),
}));
vi.mock("../proposal-branch", async (importOriginal) => ({
	...(await importOriginal<typeof import("../proposal-branch")>()),
	wakeBranchAfterCommand: (...a: unknown[]) => m.wakeBranchAfterCommand(...a),
}));
vi.mock("../proposal-authorization", () => ({
	canReviewInstructionProposals: (...a: unknown[]) =>
		m.canReviewInstructionProposals(...a),
}));
vi.mock("../../../../../lib/correlation-id", () => ({
	getCorrelationIdFromContext: () => m.correlationId,
}));

import {
	getProposalPullRequestStatus,
	pullRequestView,
	readProposalPullRequest,
	refreshProposalPullRequest,
} from "../proposal-pull-request";

beforeEach(() => {
	for (const fn of [
		m.start,
		m.getProposalOperation,
		m.getInstructionProposal,
		m.getSyncRunReceiptByRunId,
		m.requestPullRequestRefresh,
		m.transitionPullRequest,
		m.proposalBranchIdOf,
		m.wakeBranchAfterCommand,
		m.canReviewInstructionProposals,
	]) {
		fn.mockReset();
	}
	m.correlationId = "corr_1";
	m.start.mockResolvedValue({ workflowId: "wf" });
	m.proposalBranchIdOf.mockResolvedValue(null);
	m.wakeBranchAfterCommand.mockResolvedValue(undefined);
	m.canReviewInstructionProposals.mockResolvedValue(false);
});

describe("reading the pull request", () => {
	const failure = {
		phase: "create",
		code: "PR_CREATION_REFUSED",
		retryable: false,
		at: "2026-09-24T12:00:00.000Z",
		params: {},
	};

	it("reports the row's fields and nothing from the frozen context", async () => {
		const checked = new Date("2026-09-24T12:05:00.000Z");
		m.getProposalOperation.mockResolvedValue({
			pullRequestOperationId: "op_1",
			pullRequestState: "BLOCKED",
			pullRequestUrl: null,
			pullRequestExternalId: null,
			pullRequestFailure: failure,
			pullRequestLastCheckedAt: checked,
			pullRequestContext: { author: { name: "Pat Example" } },
		});

		const view = await readProposalPullRequest({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
		});

		expect(view).toEqual({
			operationId: "op_1",
			state: "BLOCKED",
			url: null,
			externalId: null,
			failure,
			lastCheckedAt: checked,
			// Not on a member branch (Fizzy #2738 spec §10).
			branch: null,
			append: null,
		});
		expect(m.getProposalOperation).toHaveBeenCalledWith({
			snapshotId: "snap_1",
			projectId: "proj_1",
			organizationId: "org_1",
		});
	});

	it("is null for a row that is not an operation, and for no row", async () => {
		expect(
			pullRequestView({
				pullRequestOperationId: null,
				pullRequestState: null,
				pullRequestUrl: null,
				pullRequestExternalId: null,
				pullRequestFailure: null,
				pullRequestLastCheckedAt: null,
			}),
		).toBeNull();
		m.getProposalOperation.mockResolvedValue(null);
		expect(
			await readProposalPullRequest({
				snapshotId: "snap_1",
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Status and refresh (plan Task 16; spec §12; Decision 8)
// ---------------------------------------------------------------------------

function failureOf(code: string, retryable: boolean, phase = "create") {
	return {
		phase,
		code,
		retryable,
		at: "2026-09-24T12:00:00.000Z",
		params: {},
	};
}

/** What `getInstructionProposal` returns for a REPOSITORY proposal. */
function proposal(overrides: Record<string, unknown> = {}) {
	return {
		id: "snap_1",
		version: 8,
		userId: "user_1",
		user: { id: "user_1", name: "Pat Example" },
		proposalStatus: "PENDING",
		proposalDestination: "REPOSITORY",
		proposalNote: { title: "Tighten the lint rule" },
		pullRequestOperationId: "op_1",
		pullRequestState: "BLOCKED",
		pullRequestAttempt: 3,
		pullRequestUrl: null,
		pullRequestExternalId: null,
		pullRequestFailure: failureOf("PR_CREATION_REFUSED", false),
		pullRequestLastCheckedAt: null,
		pullRequestObservation: null,
		mergeSyncRequestedAt: null,
		mergeSyncRunId: null,
		...overrides,
	};
}

const PROPOSER = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
	userId: "user_1",
};
const REVIEWER = { ...PROPOSER, userId: "reviewer_1" };
const GUEST = { ...PROPOSER, userId: "guest_1" };

describe("getProposalPullRequestStatus", () => {
	it("reports the row's pull request to its proposer, from the row alone", async () => {
		const checked = new Date("2026-09-24T12:05:00.000Z");
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				pullRequestState: "OPEN",
				pullRequestFailure: null,
				pullRequestUrl:
					"https://example.com/example-org/example-repo/pull/7",
				pullRequestExternalId: "7",
				pullRequestLastCheckedAt: checked,
				pullRequestObservation: {
					targetRef: "main",
					headSha: "a".repeat(40),
					mergedAt: null,
					closedAt: null,
					mergeCommitSha: null,
					targetMismatch: false,
				},
			}),
		);

		expect(await getProposalPullRequestStatus(PROPOSER)).toEqual({
			operationId: "op_1",
			state: "OPEN",
			url: "https://example.com/example-org/example-repo/pull/7",
			externalId: "7",
			failure: null,
			lastCheckedAt: checked,
			branch: null,
			append: null,
			attempt: 3,
			observation: {
				targetRef: "main",
				targetMismatch: false,
				mergedAt: null,
				closedAt: null,
			},
			mergeSync: null,
		});
		// Reviewer capability is decided first; a proposer who cannot review
		// reads through their own proposals only. No workflow, no provider.
		expect(m.canReviewInstructionProposals).toHaveBeenCalledWith({
			projectId: "proj_1",
			userId: "user_1",
		});
		expect(m.getInstructionProposal).toHaveBeenCalledWith(
			"snap_1",
			"proj_1",
			"org_1",
			{ proposerUserId: "user_1" },
		);
		expect(m.start).not.toHaveBeenCalled();
		expect(m.getSyncRunReceiptByRunId).not.toHaveBeenCalled();
	});

	it("reports a merged row's sync with its run's status, read in the proposal's tenant", async () => {
		const requestedAt = new Date("2026-09-24T12:10:00.000Z");
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				pullRequestState: "MERGED",
				proposalStatus: "MERGED",
				pullRequestFailure: null,
				mergeSyncRequestedAt: requestedAt,
				mergeSyncRunId: "run_1",
			}),
		);
		m.getSyncRunReceiptByRunId.mockResolvedValue({
			id: "sync_1:run_1",
			status: "SUCCEEDED",
		});

		expect(
			(await getProposalPullRequestStatus(PROPOSER))?.mergeSync,
		).toEqual({ requestedAt, runId: "run_1", runStatus: "SUCCEEDED" });
		expect(m.getSyncRunReceiptByRunId).toHaveBeenCalledWith({
			projectId: "proj_1",
			organizationId: "org_1",
			runId: "run_1",
		});
	});

	it("lets a reviewer read another member's pull request", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.canReviewInstructionProposals.mockResolvedValue(true);

		expect(await getProposalPullRequestStatus(REVIEWER)).toMatchObject({
			state: "BLOCKED",
			failure: failureOf("PR_CREATION_REFUSED", false),
		});
		expect(m.canReviewInstructionProposals).toHaveBeenCalledWith({
			projectId: "proj_1",
			userId: "reviewer_1",
		});
		// A reviewer's lookup is the project's, not narrowed to a proposer.
		expect(m.getInstructionProposal).toHaveBeenCalledWith(
			"snap_1",
			"proj_1",
			"org_1",
			{},
		);
	});

	it("is NOT_FOUND outside the caller's project or organization, and null for a FABRIC proposal", async () => {
		m.getInstructionProposal.mockResolvedValue(null);
		await expect(
			getProposalPullRequestStatus(PROPOSER),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		m.getInstructionProposal.mockResolvedValue(
			proposal({
				proposalDestination: "FABRIC",
				pullRequestOperationId: null,
				pullRequestState: null,
				pullRequestFailure: null,
			}),
		);
		expect(await getProposalPullRequestStatus(PROPOSER)).toBeNull();
	});
});

/**
 * `getInstructionProposal` as the database answers it over one stored row:
 * tenant-scoped, and narrowed to a proposer when `proposerUserId` is given.
 */
function storeProposal(row: ReturnType<typeof proposal>) {
	m.getInstructionProposal.mockImplementation(
		async (
			id: string,
			projectId: string,
			organizationId: string,
			options: { proposerUserId?: string } = {},
		) =>
			id === row.id &&
			projectId === "proj_1" &&
			organizationId === "org_1" &&
			(options.proposerUserId === undefined ||
				options.proposerUserId === row.userId)
				? row
				: null,
	);
}

/** Everything a caller can observe of a refusal. */
async function refusalOf(pending: Promise<unknown>) {
	const error = await pending.then(
		() => {
			throw new Error("expected a refusal");
		},
		(reason: unknown) => reason,
	);
	const { code, status, message, data } = error as {
		code: unknown;
		status: unknown;
		message: unknown;
		data: unknown;
	};
	return { code, status, message, data };
}

describe("an invited guest who is neither proposer nor reviewer", () => {
	const asks: Array<[string, (caller: typeof GUEST) => Promise<unknown>]> = [
		["the status", (caller) => getProposalPullRequestStatus(caller)],
		["a refresh", (caller) => refreshProposalPullRequest(caller)],
	];

	it.each(asks)(
		"cannot tell another member's proposal from a missing one when asking for %s, and nothing is written or started",
		async (_label, ask) => {
			storeProposal(proposal());
			m.canReviewInstructionProposals.mockResolvedValue(false);

			const hidden = await refusalOf(ask(GUEST));
			const absent = await refusalOf(
				ask({ ...GUEST, snapshotId: "snap_absent" }),
			);

			expect(hidden).toEqual(absent);
			expect(hidden).toMatchObject({
				code: "NOT_FOUND",
				status: 404,
				message: "Proposal not found",
			});
			expect(m.getInstructionProposal).toHaveBeenCalledWith(
				"snap_1",
				"proj_1",
				"org_1",
				{ proposerUserId: "guest_1" },
			);
			expect(m.requestPullRequestRefresh).not.toHaveBeenCalled();
			expect(m.transitionPullRequest).not.toHaveBeenCalled();
			expect(m.wakeBranchAfterCommand).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it("still follows a proposal of their own", async () => {
		storeProposal(proposal({ userId: "guest_1" }));
		m.canReviewInstructionProposals.mockResolvedValue(false);

		expect(await getProposalPullRequestStatus(GUEST)).toMatchObject({
			operationId: "op_1",
			state: "BLOCKED",
		});
	});
});

describe("refreshProposalPullRequest", () => {
	const MOVABLE = [
		["QUEUED", null],
		["OPENING", null],
		["BLOCKED", failureOf("PROVIDER_TEMPORARY", true)],
	] as const;

	it.each(MOVABLE)(
		"asks for a fresh look and wakes the member branch a %s row is on",
		async (state, failure) => {
			m.getInstructionProposal.mockResolvedValue(proposal());
			m.requestPullRequestRefresh.mockResolvedValue({
				admitted: true,
				state,
				attempt: 3,
				failure,
			});
			m.proposalBranchIdOf.mockResolvedValue("branch_1");

			expect(await refreshProposalPullRequest(PROPOSER)).toEqual({
				refreshed: true,
			});
			expect(m.requestPullRequestRefresh).toHaveBeenCalledWith({
				snapshotId: "snap_1",
				projectId: "proj_1",
				organizationId: "org_1",
			});
			expect(m.proposalBranchIdOf).toHaveBeenCalledWith({
				snapshotId: "snap_1",
				organizationId: "org_1",
			});
			expect(m.wakeBranchAfterCommand).toHaveBeenCalledWith(
				"branch_1",
				PROPOSER,
			);
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it.each(MOVABLE)(
		"leaves a %s row on no branch to the sweeper's Attach, starting nothing",
		async (state, failure) => {
			m.getInstructionProposal.mockResolvedValue(proposal());
			m.requestPullRequestRefresh.mockResolvedValue({
				admitted: true,
				state,
				attempt: 3,
				failure,
			});

			expect(await refreshProposalPullRequest(PROPOSER)).toEqual({
				refreshed: true,
			});
			expect(m.wakeBranchAfterCommand).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it.each([
		["OPEN", null],
		["CLOSE_REQUESTED", null],
		["BLOCKED", failureOf("PR_CREATION_REFUSED", false)],
	])(
		"starts nothing for a %s row: Observe, Close or a human retry moves it",
		async (state, failure) => {
			m.getInstructionProposal.mockResolvedValue(proposal());
			m.requestPullRequestRefresh.mockResolvedValue({
				admitted: true,
				state,
				attempt: 3,
				failure,
			});

			expect(await refreshProposalPullRequest(PROPOSER)).toEqual({
				refreshed: true,
			});
			expect(m.proposalBranchIdOf).not.toHaveBeenCalled();
			expect(m.wakeBranchAfterCommand).not.toHaveBeenCalled();
			expect(m.start).not.toHaveBeenCalled();
		},
	);

	it("refreshes nothing on a row that is already settled", async () => {
		m.getInstructionProposal.mockResolvedValue(
			proposal({ pullRequestState: "MERGED", proposalStatus: "MERGED" }),
		);
		m.requestPullRequestRefresh.mockResolvedValue(null);

		expect(await refreshProposalPullRequest(PROPOSER)).toEqual({
			refreshed: false,
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("is NOT_FOUND for a proposal with no pull request, and writes nothing", async () => {
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				proposalDestination: "FABRIC",
				pullRequestOperationId: null,
				pullRequestState: null,
			}),
		);

		await expect(
			refreshProposalPullRequest(PROPOSER),
		).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(m.requestPullRequestRefresh).not.toHaveBeenCalled();
	});

	it("refuses a Refresh the database did not admit inside the cooldown with TOO_MANY_REQUESTS and retryAfter, and starts nothing", async () => {
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				pullRequestFailure: failureOf("PROVIDER_TEMPORARY", true),
			}),
		);
		m.requestPullRequestRefresh.mockResolvedValue({
			admitted: false,
			reason: "cooldown",
			retryAfterSeconds: 42,
		});

		await expect(
			refreshProposalPullRequest(PROPOSER),
		).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
			message:
				"This pull request was refreshed a moment ago. Try again in 42 seconds.",
			data: { reason: "PULL_REQUEST_REFRESH_COOLDOWN", retryAfter: 42 },
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("refuses a Refresh of a rate-limited row with the provider's seconds, and starts nothing", async () => {
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				pullRequestFailure: failureOf("PROVIDER_RATE_LIMITED", true),
			}),
		);
		m.requestPullRequestRefresh.mockResolvedValue({
			admitted: false,
			reason: "provider_rate_limited",
			retryAfterSeconds: 600,
		});

		await expect(
			refreshProposalPullRequest(PROPOSER),
		).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
			data: {
				reason: "PULL_REQUEST_PROVIDER_RATE_LIMITED",
				retryAfter: 600,
			},
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("wakes the branch once for rapid refreshes the database admits one of", async () => {
		m.getInstructionProposal.mockResolvedValue(
			proposal({
				pullRequestFailure: failureOf("PROVIDER_TEMPORARY", true),
			}),
		);
		const blocked = {
			admitted: true,
			state: "BLOCKED",
			attempt: 3,
			failure: failureOf("PROVIDER_TEMPORARY", true),
		};
		const cooling = {
			admitted: false,
			reason: "cooldown",
			retryAfterSeconds: 60,
		};
		m.requestPullRequestRefresh
			.mockResolvedValueOnce(blocked)
			.mockResolvedValue(cooling);
		m.proposalBranchIdOf.mockResolvedValue("branch_1");

		const answers = await Promise.allSettled([
			refreshProposalPullRequest(PROPOSER),
			refreshProposalPullRequest(PROPOSER),
			refreshProposalPullRequest(PROPOSER),
		]);

		expect(answers.filter((a) => a.status === "fulfilled")).toEqual([
			{ status: "fulfilled", value: { refreshed: true } },
		]);
		for (const refused of answers.filter((a) => a.status === "rejected")) {
			expect(refused).toMatchObject({
				reason: { code: "TOO_MANY_REQUESTS" },
			});
		}
		expect(m.requestPullRequestRefresh).toHaveBeenCalledTimes(3);
		expect(m.wakeBranchAfterCommand).toHaveBeenCalledTimes(1);
		expect(m.start).not.toHaveBeenCalled();
	});
});
