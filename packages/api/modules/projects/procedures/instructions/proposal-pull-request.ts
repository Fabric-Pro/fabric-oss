/**
 * A REPOSITORY proposal's pull request, as the API starts, reads, refreshes
 * and reports it (Fizzy #2563 spec §6, §12).
 *
 * Every admitted REPOSITORY proposal is a member branch proposal (Fizzy
 * #2738): it starts by joining its member's branch and waking that branch's
 * workflow (`startAdmittedBranchProposal`). #2563's per-proposal workflow,
 * its starts and its "Retry opening" were retired once its rows drained
 * (Fizzy #2748); a row it left is still read and reported here exactly as
 * before.
 *
 * Reads never touch the provider (spec §2.13): the row is the answer.
 *
 * Status and refresh are for the proposer or a reviewer (plan
 * Decision 8), checked live here on every call, under whatever the surface
 * already checked: the procedure's `INSTRUCTION_READ` gate, or the REST
 * route's key scope and live read check. The lookup itself goes through the
 * caller's visibility, as the proposal list does: a reviewer's reaches any
 * proposal in the project, anyone else's only their own. An invited guest
 * who asks about another member's proposal is told NOT_FOUND, the same
 * answer as for an id that does not exist.
 */
import { ORPCError } from "@orpc/client";
import {
	getInstructionProposal,
	getProposalOperation,
	getSyncRunReceiptByRunId,
	getSyncRunReceiptsByRunIds,
	type ProposalBranchAttachment,
	type ProposalOperationRow,
	type PullRequestFailure,
	proposalBranchIdOf,
	type RecordAuditInput,
	readProposalBranchAttachments,
	requestPullRequestRefresh,
} from "@repo/database";
import type { ProposalOperationInput } from "@repo/temporal/instruction-proposal-pull-request-types";
import { canReviewInstructionProposals } from "./proposal-authorization";
import {
	startAdmittedBranchProposal,
	wakeBranchAfterCommand,
} from "./proposal-branch";
import {
	type ProposalAppendView,
	type ProposalBranchView,
	proposalAppendView,
	proposalBranchView,
} from "./proposal-branch-view";

type ProposalPullRequestState = NonNullable<
	ProposalOperationRow["pullRequestState"]
>;

/**
 * The `pullRequest` block every surface returns (spec §5.3): what the row
 * says, and nothing a provider was asked. `failure` is the stored typed
 * failure, whose `params` hold safe values only; copy comes from `en.json`
 * by `code`.
 *
 * A member branch proposal (Fizzy #2738 spec §10) keeps these fields: its
 * `state` is the proposal's own, and `url` and `externalId` are its
 * branch's pull request. It adds `branch` and `append`, both null for any
 * other proposal.
 */
export type ProposalPullRequestView = {
	operationId: string;
	state: ProposalPullRequestState;
	url: string | null;
	externalId: string | null;
	failure: PullRequestFailure | null;
	lastCheckedAt: Date | null;
	branch: ProposalBranchView | null;
	append: ProposalAppendView | null;
};

/**
 * The start right after an admission commits (spec §5.1 step 9). Every
 * admitted REPOSITORY proposal is a member branch proposal (Fizzy #2738 spec
 * Decision 4): it joins its member's branch and wakes that branch's workflow
 * (`startAdmittedBranchProposal`). Never throws: the row is committed QUEUED,
 * which is the durable intent, and the sweeper's Attach joins a proposal
 * this start leaves unjoined. Failing the request here would tell the
 * proposer their suggestion was refused when it was accepted.
 *
 * A row whose context is not v2 is never joined (`joinProposalBranch`
 * answers `not_joinable`), so nothing here can act on a #2563 row: that
 * path's per-proposal workflow was retired (Fizzy #2748).
 */
export async function startAdmittedProposalPullRequest(
	input: ProposalOperationInput,
): Promise<void> {
	await startAdmittedBranchProposal({
		snapshotId: input.snapshotId,
		projectId: input.projectId,
		organizationId: input.organizationId,
	});
}

function failureOf(value: unknown): PullRequestFailure | null {
	if (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { code?: unknown }).code === "string"
	) {
		return value as PullRequestFailure;
	}
	return null;
}

/**
 * The `pullRequest` block from a row, or null for a row that is not an
 * operation. `attachment` is the row's member branch, when it is on one
 * (`readProposalBranchAttachments`): the branch's pull request then gives
 * `url` and `externalId`, and `branch` and `append` are filled.
 */
export function pullRequestView(
	row: Pick<
		ProposalOperationRow,
		| "pullRequestOperationId"
		| "pullRequestState"
		| "pullRequestUrl"
		| "pullRequestExternalId"
		| "pullRequestFailure"
		| "pullRequestLastCheckedAt"
	>,
	attachment?: ProposalBranchAttachment | null,
): ProposalPullRequestView | null {
	if (!row.pullRequestOperationId || !row.pullRequestState) {
		return null;
	}
	const branch = attachment ? proposalBranchView(attachment.branch) : null;
	return {
		operationId: row.pullRequestOperationId,
		state: row.pullRequestState,
		url: attachment ? attachment.branch.pullRequestUrl : row.pullRequestUrl,
		externalId: attachment
			? attachment.branch.pullRequestExternalId
			: row.pullRequestExternalId,
		failure: failureOf(row.pullRequestFailure),
		lastCheckedAt: attachment
			? attachment.branch.lastCheckedAt
			: row.pullRequestLastCheckedAt,
		branch,
		append: attachment ? proposalAppendView(attachment) : null,
	};
}

/** Member branch attachments, by proposal id (Fizzy #2738 spec §10). */
export type ProposalBranchAttachments = ReadonlyMap<
	string,
	ProposalBranchAttachment
>;

/**
 * The branch attachments every operation row of a page needs, in one batch
 * of tenant-scoped queries rather than per row, as `readMergeSyncReceipts`.
 */
export function readBranchAttachments(
	rows: readonly { id?: string; pullRequestOperationId: string | null }[],
	scope: { organizationId: string },
): Promise<ProposalBranchAttachments> {
	return readProposalBranchAttachments({
		organizationId: scope.organizationId,
		snapshotIds: rows.flatMap((row) =>
			row.id && row.pullRequestOperationId ? [row.id] : [],
		),
	});
}

/** The row's `pullRequest` block, tenant-scoped; null when there is none. */
export async function readProposalPullRequest(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<ProposalPullRequestView | null> {
	const row = await getProposalOperation(i);
	if (!row || !row.pullRequestOperationId) {
		return row ? pullRequestView(row) : null;
	}
	const attachments = await readBranchAttachments([row], i);
	return pullRequestView(row, attachments.get(row.id));
}

// ---------------------------------------------------------------------------
// Status and refresh (plan Task 16; spec §12)
// ---------------------------------------------------------------------------

/**
 * What the provider last reported about where the pull request went, as the
 * card needs it: "Merged into <branch>, a different branch; Fabric did not
 * sync it" reads `targetRef` and `targetMismatch`.
 */
type ProposalPullRequestObservation = {
	targetRef: string | null;
	targetMismatch: boolean;
	mergedAt: string | null;
	closedAt: string | null;
};

/**
 * The merge sync a merged pull request requests (spec §9.1): pending while
 * `requestedAt` is set, then the run's receipt status once one is recorded.
 * A give-up is the row's `failure` with phase `merge_sync`.
 */
type ProposalMergeSync = {
	requestedAt: Date | null;
	runId: string | null;
	runStatus: string | null;
};

/**
 * The `pullRequest` block of a proposal row and of the status read: the
 * admission block plus the row's attempt, the observation and the merge
 * sync.
 */
export type ProposalPullRequestStatus = ProposalPullRequestView & {
	attempt: number;
	observation: ProposalPullRequestObservation | null;
	mergeSync: ProposalMergeSync | null;
};

type InstructionProposal = NonNullable<
	Awaited<ReturnType<typeof getInstructionProposal>>
>;

type StatusRow = Partial<Pick<InstructionProposal, "id">> &
	Pick<
		InstructionProposal,
		| "pullRequestOperationId"
		| "pullRequestState"
		| "pullRequestAttempt"
		| "pullRequestUrl"
		| "pullRequestExternalId"
		| "pullRequestFailure"
		| "pullRequestLastCheckedAt"
		| "pullRequestObservation"
		| "mergeSyncRequestedAt"
		| "mergeSyncRunId"
	>;

function observationOf(value: unknown): ProposalPullRequestObservation | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const o = value as Record<string, unknown>;
	const text = (v: unknown) => (typeof v === "string" ? v : null);
	return {
		targetRef: text(o.targetRef),
		targetMismatch: o.targetMismatch === true,
		mergedAt: text(o.mergedAt),
		closedAt: text(o.closedAt),
	};
}

/** Merge-sync run receipts already read for a page of rows, by run id. */
export type MergeSyncReceipts = ReadonlyMap<string, { status: string | null }>;

/**
 * The receipts every row of a page needs, in ONE tenant-scoped query rather
 * than one per row: the list is polled while a
 * dialog is open, and a page of merged rows would otherwise read a receipt
 * per row per poll. Only a row `pullRequestStatusOf` would read one for is
 * asked about: an operation with a run id.
 */
export function readMergeSyncReceipts(
	rows: readonly StatusRow[],
	scope: { projectId: string; organizationId: string },
	attachments?: ProposalBranchAttachments,
): Promise<MergeSyncReceipts> {
	return getSyncRunReceiptsByRunIds({
		projectId: scope.projectId,
		organizationId: scope.organizationId,
		runIds: rows.flatMap((row) => {
			const runId = mergeSyncSourceOf(
				row,
				row.id ? attachments?.get(row.id) : undefined,
			).mergeSyncRunId;
			return pullRequestView(row) && runId ? [runId] : [];
		}),
	});
}

/**
 * Where a row's observation and merge sync live: a member branch
 * proposal's are its branch's (Fizzy #2738 spec §4.1: the proposal's own
 * observation and merge-sync columns stay null), anyone else's its own.
 */
function mergeSyncSourceOf(
	row: StatusRow,
	attachment: ProposalBranchAttachment | undefined,
): Pick<
	StatusRow,
	"pullRequestObservation" | "mergeSyncRequestedAt" | "mergeSyncRunId"
> {
	return attachment
		? {
				pullRequestObservation:
					attachment.branch.pullRequestObservation,
				mergeSyncRequestedAt: attachment.branch.mergeSyncRequestedAt,
				mergeSyncRunId: attachment.branch.mergeSyncRunId,
			}
		: row;
}

/**
 * The status block of a proposal row read in `scope`, or null for a row that
 * is not an operation. The only read beyond the row is the merge-sync run's
 * receipt, in the same project and organization; never the provider. A page
 * passes the `receipts` it read in one query (`readMergeSyncReceipts`), and a
 * run absent from them reads exactly as a missing receipt; a single row
 * reads its own.
 */
export async function pullRequestStatusOf(
	row: StatusRow,
	scope: { projectId: string; organizationId: string },
	receipts?: MergeSyncReceipts,
	attachments?: ProposalBranchAttachments,
): Promise<ProposalPullRequestStatus | null> {
	if (!row.pullRequestOperationId || !row.pullRequestState) {
		return null;
	}
	const branchOf = attachments ?? (await readBranchAttachments([row], scope));
	const attachment = row.id ? branchOf.get(row.id) : undefined;
	const view = pullRequestView(row, attachment);
	if (!view) {
		return null;
	}
	const source = mergeSyncSourceOf(row, attachment);
	let mergeSync: ProposalMergeSync | null = null;
	if (source.mergeSyncRequestedAt || source.mergeSyncRunId) {
		const receipt = !source.mergeSyncRunId
			? null
			: receipts
				? (receipts.get(source.mergeSyncRunId) ?? null)
				: await getSyncRunReceiptByRunId({
						projectId: scope.projectId,
						organizationId: scope.organizationId,
						runId: source.mergeSyncRunId,
					});
		mergeSync = {
			requestedAt: source.mergeSyncRequestedAt,
			runId: source.mergeSyncRunId,
			runStatus: receipt?.status ?? null,
		};
	}
	return {
		...view,
		attempt: row.pullRequestAttempt,
		observation: observationOf(source.pullRequestObservation),
		mergeSync,
	};
}

/** Who is asking about which proposal, with the tenant already resolved. */
export type ProposalPullRequestCaller = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	userId: string;
};

/**
 * The proposal as the caller may see it (Decision 8). Reviewer capability is
 * decided first and the lookup is made through it: a reviewer's is the
 * project's, anyone else's is narrowed to proposals they made. So a proposal
 * the caller may not follow is not found rather than forbidden, and another
 * member's id answers exactly as a missing one does; a refusal that differed
 * would tell a guest which ids are real. Tenant-scoped too:
 * another project's or organization's proposal is NOT_FOUND.
 */
async function authorizedProposal(
	caller: ProposalPullRequestCaller,
): Promise<InstructionProposal> {
	const canReview = await canReviewInstructionProposals({
		projectId: caller.projectId,
		userId: caller.userId,
	});
	const proposal = await getInstructionProposal(
		caller.snapshotId,
		caller.projectId,
		caller.organizationId,
		canReview ? {} : { proposerUserId: caller.userId },
	);
	if (!proposal) {
		throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
	}
	return proposal;
}

function withoutPullRequest(): never {
	throw new ORPCError("NOT_FOUND", {
		message: "This suggestion has no pull request",
	});
}

/** The status block for the proposer or a reviewer; null for a FABRIC proposal. */
export async function getProposalPullRequestStatus(
	caller: ProposalPullRequestCaller,
): Promise<ProposalPullRequestStatus | null> {
	const proposal = await authorizedProposal(caller);
	return pullRequestStatusOf(proposal, caller);
}

function isRetryableBlocked(state: string, failure: unknown): boolean {
	return state === "BLOCKED" && failureOf(failure)?.retryable === true;
}

/**
 * A refused Refresh: TOO_MANY_REQUESTS with `retryAfter`
 * in seconds, as the RPC rate limiter answers, and a reason that says whose
 * clock it is.
 */
function refreshRefusal(refused: {
	reason: "cooldown" | "provider_rate_limited";
	retryAfterSeconds: number;
}): ORPCError<"TOO_MANY_REQUESTS", { reason: string; retryAfter: number }> {
	const retryAfter = refused.retryAfterSeconds;
	return refused.reason === "provider_rate_limited"
		? new ORPCError("TOO_MANY_REQUESTS", {
				message: `The repository's provider asked Fabric to wait before trying again. Fabric will try again by itself; you can refresh in ${retryAfter} seconds.`,
				data: {
					reason: "PULL_REQUEST_PROVIDER_RATE_LIMITED",
					retryAfter,
				},
			})
		: new ORPCError("TOO_MANY_REQUESTS", {
				message: `This pull request was refreshed a moment ago. Try again in ${retryAfter} seconds.`,
				data: { reason: "PULL_REQUEST_REFRESH_COOLDOWN", retryAfter },
			});
}

/**
 * Refresh (spec §12): asks for a fresh look without touching the provider
 * here. The row's check time is nulled and a retryable BLOCKED row made due
 * (`requestPullRequestRefresh`); then, for a row its branch's workflow
 * moves (QUEUED, OPENING, a retryable BLOCKED) on a member branch, that
 * workflow is woken now rather than on the sweeper's next tick. A proposal
 * not yet on a branch is left to the sweeper's Attach, an OPEN row to
 * Observe, CLOSE_REQUESTED to Close, and a non-retryable BLOCKED row to a
 * human. `refreshed: false` means the row is already settled.
 *
 * Rationed on the server: the database admits one Refresh
 * per operation a minute, atomically, and never one that would override a
 * provider's rate-limit deadline. A refused Refresh is TOO_MANY_REQUESTS
 * with `retryAfter` and wakes nothing; a workflow is woken only for an
 * admitted one.
 */
export async function refreshProposalPullRequest(
	caller: ProposalPullRequestCaller,
): Promise<{ refreshed: boolean }> {
	const proposal = await authorizedProposal(caller);
	if (!proposal.pullRequestOperationId || !proposal.pullRequestState) {
		return withoutPullRequest();
	}
	const refreshed = await requestPullRequestRefresh({
		snapshotId: caller.snapshotId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
	});
	if (!refreshed) {
		return { refreshed: false };
	}
	if (!refreshed.admitted) {
		throw refreshRefusal(refreshed);
	}
	if (
		refreshed.state === "QUEUED" ||
		refreshed.state === "OPENING" ||
		isRetryableBlocked(refreshed.state, refreshed.failure)
	) {
		// A member branch proposal's git writes belong to its branch's
		// workflow (Fizzy #2738 spec Decision 9): wake it. A proposal on no
		// branch yet is the sweeper's Attach to join; nothing else may act on
		// it (#2563's per-proposal workflow was retired, Fizzy #2748).
		const branchId = await proposalBranchIdOf({
			snapshotId: caller.snapshotId,
			organizationId: caller.organizationId,
		});
		if (branchId !== null) {
			await wakeBranchAfterCommand(branchId, caller);
		}
	}
	return { refreshed: true };
}

/** The request half of a cancel's audit rows, built by the surface from its request. */
export type ProposalPullRequestRequester = Pick<
	RecordAuditInput,
	| "actor"
	| "ipAddress"
	| "userAgent"
	| "requestId"
	| "sessionId"
	| "correlationId"
>;
