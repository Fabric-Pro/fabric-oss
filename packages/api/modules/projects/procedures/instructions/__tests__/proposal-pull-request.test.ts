/**
 * A REPOSITORY proposal's pull request as the API starts and reads it
 * (Fizzy #2563 spec §6, §12).
 *
 * The start is the operation workflow's, one per operation, on the
 * instructions queue, with `workflowIdConflictPolicy: "FAIL"` so a second
 * start is adoption; every start here originates in a request and carries
 * the request's correlation memo (plan Decision 12). Reads are the row's,
 * never the provider's.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	start: vi.fn(),
	getProposalOperation: vi.fn(),
	getInstructionProposal: vi.fn(),
	getSyncRunReceiptByRunId: vi.fn(),
	requestPullRequestRefresh: vi.fn(),
	transitionPullRequest: vi.fn(),
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
	retryProposalPullRequest,
	startAdmittedProposalPullRequest,
	startProposalPullRequestWorkflow,
} from "../proposal-pull-request";

const INPUT = {
	snapshotId: "snap_1",
	projectId: "proj_1",
	organizationId: "org_1",
	operationId: "op_1",
};

function alreadyStarted(): Error {
	const error = new Error("Workflow execution already started");
	error.name = "WorkflowExecutionAlreadyStartedError";
	return error;
}

beforeEach(() => {
	for (const fn of [
		m.start,
		m.getProposalOperation,
		m.getInstructionProposal,
		m.getSyncRunReceiptByRunId,
		m.requestPullRequestRefresh,
		m.transitionPullRequest,
		m.canReviewInstructionProposals,
	]) {
		fn.mockReset();
	}
	m.correlationId = "corr_1";
	m.start.mockResolvedValue({ workflowId: "wf" });
	m.canReviewInstructionProposals.mockResolvedValue(false);
});

describe("startProposalPullRequestWorkflow", () => {
	it("starts the operation's workflow with FAIL and the request's correlation memo", async () => {
		expect(await startProposalPullRequestWorkflow(INPUT)).toBe("started");

		expect(m.start).toHaveBeenCalledWith(
			"projectInstructionProposalPullRequestWorkflow",
			{
				taskQueue: "project-instructions",
				workflowId: "project-instruction-proposal-pull-request-op_1",
				workflowIdConflictPolicy: "FAIL",
				args: [INPUT],
				memo: { correlationId: "corr_1" },
			},
		);
	});

	it("passes a human retry's observed attempt and nothing else", async () => {
		await startProposalPullRequestWorkflow({
			...INPUT,
			retryCreate: { expectedAttempt: 3 },
			// A starter never sets the workflow's own continue-as-new carry.
			readiness: { deadlineMs: 1, wasFailed: true, pendingAnswers: 9 },
		} as Parameters<typeof startProposalPullRequestWorkflow>[0]);

		expect(m.start.mock.calls[0]![1].args).toEqual([
			{ ...INPUT, retryCreate: { expectedAttempt: 3 } },
		]);
	});

	it("reads an execution already running under the operation's id as adoption", async () => {
		m.start.mockRejectedValue(alreadyStarted());

		expect(await startProposalPullRequestWorkflow(INPUT)).toBe(
			"already_running",
		);
	});

	it("throws any other start failure", async () => {
		m.start.mockRejectedValue(new Error("unreachable"));

		await expect(startProposalPullRequestWorkflow(INPUT)).rejects.toThrow(
			"unreachable",
		);
	});
});

describe("startAdmittedProposalPullRequest", () => {
	it("logs a failed start and does not throw: the committed row is the durable intent", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.start.mockRejectedValue(new Error("unreachable"));

		await expect(startAdmittedProposalPullRequest(INPUT)).resolves.toBe(
			undefined,
		);
		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("sweeper"),
			{ snapshotId: "snap_1", operationId: "op_1" },
			expect.any(Error),
		);
		log.mockRestore();
	});

	it("is quiet about adoption", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.start.mockRejectedValue(alreadyStarted());

		await startAdmittedProposalPullRequest(INPUT);

		expect(log).not.toHaveBeenCalled();
		log.mockRestore();
	});
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
// Status, refresh and retry (plan Task 16; spec §12; Decision 8)
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

const REQUESTER = {
	actor: {
		type: "user" as const,
		userId: "user_1",
		emailSnapshot: ["pat", "example.com"].join("@"),
		nameSnapshot: "Pat Example",
		impersonatedById: null,
	},
	ipAddress: "203.0.113.7",
	userAgent: null,
	requestId: "req_1",
	sessionId: "sess_1",
	correlationId: "corr_1",
};

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
		[
			"a retry",
			(caller) =>
				retryProposalPullRequest({
					...caller,
					expectedAttempt: 3,
					requester: REQUESTER,
				}),
		],
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
	it.each([
		["QUEUED", null],
		["OPENING", null],
		["BLOCKED", failureOf("PROVIDER_TEMPORARY", true)],
	])(
		"asks for a fresh look and starts the operation's workflow for a %s row",
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
			expect(m.requestPullRequestRefresh).toHaveBeenCalledWith({
				snapshotId: "snap_1",
				projectId: "proj_1",
				organizationId: "org_1",
			});
			expect(m.start).toHaveBeenCalledWith(
				"projectInstructionProposalPullRequestWorkflow",
				expect.objectContaining({
					workflowIdConflictPolicy: "FAIL",
					args: [INPUT],
					memo: { correlationId: "corr_1" },
				}),
			);
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

	it("logs a failed start and still answers: the row is due and the sweeper restarts it", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.requestPullRequestRefresh.mockResolvedValue({
			admitted: true,
			state: "QUEUED",
			attempt: 3,
			failure: null,
		});
		m.start.mockRejectedValue(new Error("unreachable"));

		expect(await refreshProposalPullRequest(PROPOSER)).toEqual({
			refreshed: true,
		});
		expect(log).toHaveBeenCalled();
		log.mockRestore();
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

	it("starts the workflow once for rapid refreshes the database admits one of", async () => {
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
		expect(m.start).toHaveBeenCalledTimes(1);
	});
});

describe("retryProposalPullRequest", () => {
	it.each([
		[
			"a non-retryable CREATE_OUTCOME_UNKNOWN",
			failureOf("CREATE_OUTCOME_UNKNOWN", false),
		],
		["PR_CREATION_REFUSED", failureOf("PR_CREATION_REFUSED", false)],
		[
			"REMOTE_REF_CONFLICT",
			failureOf("REMOTE_REF_CONFLICT", false, "push"),
		],
	])(
		"records the request, then starts the workflow naming the attempt the card showed, on %s",
		async (_label, failure) => {
			m.getInstructionProposal.mockResolvedValue(
				proposal({ pullRequestFailure: failure }),
			);
			m.transitionPullRequest.mockResolvedValue({ ok: true, attempt: 3 });

			expect(
				await retryProposalPullRequest({
					...PROPOSER,
					expectedAttempt: 3,
					requester: REQUESTER,
				}),
			).toEqual({ retried: true });

			expect(m.transitionPullRequest).toHaveBeenCalledWith({
				snapshotId: "snap_1",
				organizationId: "org_1",
				event: "retry",
				from: ["BLOCKED"],
				expectedAttempt: 3,
				to: "unchanged",
				bumpAttempt: false,
				audit: {
					action: "project.instructions.pull_request_retry_requested",
					category: "project",
					actor: REQUESTER.actor,
					organizationId: "org_1",
					projectId: "proj_1",
					resource: {
						type: "project_instruction_snapshot",
						id: "snap_1",
						name: "v8",
					},
					metadata: { operationId: "op_1" },
					ipAddress: "203.0.113.7",
					userAgent: null,
					requestId: "req_1",
					sessionId: "sess_1",
					correlationId: "corr_1",
				},
			});
			expect(m.start).toHaveBeenCalledWith(
				"projectInstructionProposalPullRequestWorkflow",
				expect.objectContaining({
					workflowIdConflictPolicy: "FAIL",
					args: [{ ...INPUT, retryCreate: { expectedAttempt: 3 } }],
					memo: { correlationId: "corr_1" },
				}),
			);
			expect(
				m.transitionPullRequest.mock.invocationCallOrder[0],
			).toBeLessThan(m.start.mock.invocationCallOrder[0] as number);
		},
	);

	it("lets a reviewer retry another member's pull request", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.canReviewInstructionProposals.mockResolvedValue(true);
		m.transitionPullRequest.mockResolvedValue({ ok: true, attempt: 3 });

		expect(
			await retryProposalPullRequest({
				...REVIEWER,
				expectedAttempt: 3,
				requester: REQUESTER,
			}),
		).toEqual({ retried: true });
	});

	it.each([
		["an OPEN row", { pullRequestState: "OPEN", pullRequestFailure: null }],
		[
			"a retryable CREATE_OUTCOME_UNKNOWN",
			{ pullRequestFailure: failureOf("CREATE_OUTCOME_UNKNOWN", true) },
		],
		[
			"a failure the sweeper retries by itself",
			{ pullRequestFailure: failureOf("AUTHENTICATION_FAILED", true) },
		],
		[
			"a failure no retry can fix",
			{
				pullRequestFailure: failureOf(
					"ATTRIBUTION_REJECTED",
					false,
					"admission",
				),
			},
		],
	])("refuses %s, recording and starting nothing", async (_label, row) => {
		m.getInstructionProposal.mockResolvedValue(proposal(row));

		await expect(
			retryProposalPullRequest({
				...PROPOSER,
				expectedAttempt: 3,
				requester: REQUESTER,
			}),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: { reason: "PULL_REQUEST_NOT_RETRYABLE" },
		});
		expect(m.transitionPullRequest).not.toHaveBeenCalled();
		expect(m.start).not.toHaveBeenCalled();
	});

	it("refuses a retry the row has moved past since the card was drawn", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.transitionPullRequest.mockResolvedValue({ ok: false });

		await expect(
			retryProposalPullRequest({
				...PROPOSER,
				expectedAttempt: 2,
				requester: REQUESTER,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "PULL_REQUEST_CHANGED" },
		});
		expect(m.start).not.toHaveBeenCalled();
	});

	it("surfaces a start that failed after the retry was recorded", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.transitionPullRequest.mockResolvedValue({ ok: true, attempt: 3 });
		m.start.mockRejectedValue(new Error("unreachable"));

		await expect(
			retryProposalPullRequest({
				...PROPOSER,
				expectedAttempt: 3,
				requester: REQUESTER,
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			data: { reason: "PULL_REQUEST_START_FAILED" },
		});
		log.mockRestore();
	});

	it("reports a workflow still running for the operation as busy", async () => {
		m.getInstructionProposal.mockResolvedValue(proposal());
		m.transitionPullRequest.mockResolvedValue({ ok: true, attempt: 3 });
		m.start.mockRejectedValue(alreadyStarted());

		await expect(
			retryProposalPullRequest({
				...PROPOSER,
				expectedAttempt: 3,
				requester: REQUESTER,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: { reason: "PULL_REQUEST_BUSY" },
		});
	});
});
