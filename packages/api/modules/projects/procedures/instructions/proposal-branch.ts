/**
 * Member proposal branches, as the API starts and wakes them (Fizzy #2738
 * spec §5, §6 "Identity" and "Start").
 *
 * One workflow per branch, `projectInstructionProposalBranchWorkflow`, owns
 * every git write on that branch. Commands are persisted in the database;
 * the workflow is signal-started to look again, so a wake while it runs is
 * a signal and a wake while none runs is a start. Every start here that
 * originates in a request carries its correlation memo (plan Decision 12);
 * the sweeper's Attach and wakes, which carry none, live in `@repo/temporal`.
 *
 * A failure here is never the proposer's failure: the admission committed
 * the proposal QUEUED, which is the durable intent, and the sweeper's Attach
 * joins a proposal left without a branch and wakes a branch with work.
 */
import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	type BranchCommandRequester,
	type BranchCommandResult,
	type BranchProjectionEntry,
	type BranchRow,
	closeProposalBranch,
	countLiveBranchChanges,
	getAcceptingBranchForMember,
	getInstructionFileByPath,
	getInstructionRepositorySyncForProposal,
	getMemberProposalBranch,
	getUsersByIds,
	joinProposalBranch,
	listMemberBranches,
	listProposalBranchOwnerIds,
	loadGitIntent,
	type ProposalBranchNaming,
	projectMemberBranch,
	proposeBranchProposalAgain,
	requestProposalBranchRefresh,
	requestProposalBranchRetry,
	startOverProposalBranch,
	stopTrackingBranch,
	tryBranchProposalAgain,
} from "@repo/database";
import { fileTypingFor } from "@repo/instructions";
import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import {
	repositoryIdentity,
	repositoryKey,
} from "@repo/integrations/instruction-pull-requests";
import { getStorageProvider } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal";
import { withCorrelationMemo } from "../../../../lib/temporal-correlation";
import {
	assertRepositoryProposalAccess,
	canReviewInstructionProposals,
} from "./proposal-authorization";
import { runProposalBranchRefreshWorkflow } from "./proposal-branch-refresh-workflow";
import {
	type ProposalBranchView,
	proposalBranchView,
} from "./proposal-branch-view";

/**
 * The instructions worker's queue. The #2563 operation workflow and the
 * member branch workflow share it with the snapshot workflow (spec §6
 * "Queues as #2563").
 */
export const PROPOSAL_WORKFLOW_TASK_QUEUE = "project-instructions";

/** The branch workflow's type (spec §6, exact). */
const PROPOSAL_BRANCH_WORKFLOW_TYPE =
	"projectInstructionProposalBranchWorkflow";

/** The signal that makes the branch workflow ask `nextBranchWork` again. */
const PROPOSAL_BRANCH_WAKE_SIGNAL = "wake";

/** The branch workflow's id (spec §6 "Identity", exact). */
function proposalBranchWorkflowId(branchId: string): string {
	return `project-instruction-proposal-branch-${branchId}`;
}

/**
 * The canonical naming and identity functions `@repo/database`'s branch
 * queries take as a port, because that package can depend on neither
 * `@repo/instructions` nor `@repo/integrations`.
 */
export const proposalBranchNaming: ProposalBranchNaming = {
	memberBranchRef,
	repositoryIdentity,
	repositoryKey,
};

/**
 * Wakes the branch's workflow: `signalWithStart` with `wake`, so a running
 * workflow is signaled and a finished or absent one is started with the
 * signal already delivered. The input is ids only; nothing else reaches
 * workflow history.
 *
 * `signaled` when a run was already open, `started` otherwise. The SDK's
 * `signalWithStart` does not say which it did, so an open run is signaled
 * first; only when there is none does the atomic `signalWithStart` run. Two
 * concurrent wakes can both reach `signalWithStart`, which Temporal
 * resolves to one run holding both signals.
 *
 * `correlation` is true for a wake that originates in a request: the start
 * then carries the request's correlation memo.
 */
export async function wakeProposalBranchWorkflow(i: {
	branchId: string;
	projectId: string;
	organizationId: string;
	correlation: boolean;
}): Promise<"signaled" | "started"> {
	const workflowId = proposalBranchWorkflowId(i.branchId);
	const client = await getTemporalClient();
	try {
		await client.workflow
			.getHandle(workflowId)
			.signal(PROPOSAL_BRANCH_WAKE_SIGNAL);
		return "signaled";
	} catch (error) {
		// Matched by name: `@temporalio/client` is not a dependency of this
		// package (the rule `finalize.ts` follows). A closed run answers a
		// signal as not found, too.
		if (
			!(error instanceof Error && error.name === "WorkflowNotFoundError")
		) {
			throw error;
		}
	}
	const options = {
		taskQueue: PROPOSAL_WORKFLOW_TASK_QUEUE,
		workflowId,
		args: [
			{
				branchId: i.branchId,
				projectId: i.projectId,
				organizationId: i.organizationId,
			},
		],
		signal: PROPOSAL_BRANCH_WAKE_SIGNAL,
		signalArgs: [] as [],
	};
	await client.workflow.signalWithStart(
		PROPOSAL_BRANCH_WORKFLOW_TYPE,
		i.correlation ? withCorrelationMemo(options) : options,
	);
	return "started";
}

/**
 * The start right after a member branch proposal's admission commits (spec
 * §5 "After commit"): join the member's accepting branch, then wake its
 * workflow. Never throws. A proposal the join leaves unjoined (not joinable,
 * or BLOCKED CONFIGURATION_CHANGED by the join itself) wakes nothing; a
 * failed join or wake is logged and left to the sweeper's Attach.
 */
export async function startAdmittedBranchProposal(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<void> {
	try {
		const joined = await joinProposalBranch({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
			naming: proposalBranchNaming,
		});
		if (joined.kind !== "joined" && joined.kind !== "already") {
			return;
		}
		await wakeProposalBranchWorkflow({
			branchId: joined.branchId,
			projectId: i.projectId,
			organizationId: i.organizationId,
			correlation: true,
		});
	} catch (error) {
		console.error(
			"[instructions] could not join or wake the member proposal branch; the sweeper will attach it",
			{ snapshotId: i.snapshotId },
			error,
		);
	}
}

// ---------------------------------------------------------------------------
// The member's branch: reads and commands (Fizzy #2738 spec §10 "Tab",
// "Editor", "Procedures"; §4.3 "Try again", "Propose again"; §4.4; Decisions
// 11, 14, 17, 18, 19)
//
// Authorization, checked live on every call under the procedure's
// `INSTRUCTION_READ` gate (plan Decision 8, spec §10):
// - reads (`myBranch`, `myBranchFile`) and Stop tracking: the branch's
//   owner, or a reviewer (`canReviewInstructionProposals`);
// - Close: the owner, as a withdrawal is (spec Decision 18: authorized once,
//   by its procedure);
// - Start over, Retry opening, Try again, Propose again, which lead to new
//   pushes or a new pull request: the owner, who must still be allowed to
//   propose to the repository (`assertRepositoryProposalAccess`, readers
//   included under `allowReaderProposals`).
// Anyone else, an invited guest included, is told NOT_FOUND for a branch or
// proposal id, the answer a missing id gets, so ids cannot be probed.
//
// Every command commits first, then wakes the branch's workflow. A lost wake
// is logged and left to the sweeper, which wakes a branch whose database
// shows work (spec §8): the command is durable either way.
// ---------------------------------------------------------------------------

const BUCKET = config.storage.bucketNames.skills;
const BRANCH_FILE_DEFAULT_MAX = 50_000;

/** Who is asking, with the tenant already resolved from the project. */
export type ProposalBranchCaller = {
	projectId: string;
	organizationId: string;
	userId: string;
};

/** Wakes a branch after its command committed; never throws. */
async function wakeAfterCommit(
	branchId: string,
	caller: ProposalBranchCaller,
): Promise<void> {
	try {
		await wakeProposalBranchWorkflow({
			branchId,
			projectId: caller.projectId,
			organizationId: caller.organizationId,
			correlation: true,
		});
	} catch (error) {
		console.error(
			"[instructions] could not wake the member proposal branch; the sweeper will",
			{ branchId },
			error,
		);
	}
}

/**
 * The branch wake a procedure outside this module owes after it committed a
 * command on a member branch: the cancel procedure's withdrawal (spec §6.8:
 * a revert, a branch close or a queue that moved on) and a Refresh. Never
 * throws; a null branch wakes nothing.
 */
export async function wakeBranchAfterCommand(
	branchId: string | null,
	caller: ProposalBranchCaller,
): Promise<void> {
	if (branchId !== null) {
		await wakeAfterCommit(branchId, caller);
	}
}

function branchNotFound(): never {
	throw new ORPCError("NOT_FOUND", { message: "Branch not found" });
}

function branchChanged(): never {
	throw new ORPCError("CONFLICT", {
		message: "The branch changed just now. Refresh and try again.",
		data: { reason: "BRANCH_CHANGED" },
	});
}

function refreshRefusal(refused: {
	reason: "cooldown" | "provider_rate_limited";
	retryAfterSeconds: number;
}): never {
	const retryAfter = refused.retryAfterSeconds;
	throw new ORPCError("TOO_MANY_REQUESTS", {
		message:
			refused.reason === "provider_rate_limited"
				? `The repository's provider asked Fabric to wait before trying again. Fabric will try again by itself; you can refresh in ${retryAfter} seconds.`
				: `This pull request was refreshed a moment ago. Try again in ${retryAfter} seconds.`,
		data: {
			reason:
				refused.reason === "provider_rate_limited"
					? "PULL_REQUEST_PROVIDER_RATE_LIMITED"
					: "PULL_REQUEST_REFRESH_COOLDOWN",
			retryAfter,
		},
	});
}

/** The branch, for its owner or a reviewer; NOT_FOUND for anyone else. */
async function readableBranch(
	caller: ProposalBranchCaller & { branchId: string },
): Promise<BranchRow> {
	const branch = await getMemberProposalBranch({
		branchId: caller.branchId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
	});
	if (!branch) {
		return branchNotFound();
	}
	if (branch.userId === caller.userId) {
		return branch;
	}
	if (
		await canReviewInstructionProposals({
			projectId: caller.projectId,
			userId: caller.userId,
		})
	) {
		return branch;
	}
	return branchNotFound();
}

/**
 * Runs one authorized, bounded provider observation of an OPEN branch.
 * Display polling stays database-only; this is only the explicit action.
 */
export async function refreshProposalBranch(
	caller: ProposalBranchCaller & {
		branchId: string;
		expectedAttempt: number;
	},
): Promise<{ refreshed: boolean; pending: boolean }> {
	const branch = await readableBranch(caller);
	if (branch.attempt !== caller.expectedAttempt) {
		return branchChanged();
	}
	const admission = await requestProposalBranchRefresh({
		branchId: branch.id,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		expectedAttempt: caller.expectedAttempt,
	});
	if (admission === null) {
		const current = await readableBranch(caller);
		if (current.attempt !== caller.expectedAttempt) {
			return branchChanged();
		}
		return { refreshed: false, pending: false };
	}
	if (!admission.admitted) {
		return refreshRefusal(admission);
	}
	const outcome = await runProposalBranchRefreshWorkflow({
		branchId: branch.id,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		expectedAttempt: admission.attempt,
	});
	return { refreshed: true, pending: outcome.kind === "pending" };
}

/**
 * The individual suggestion's Refresh on an OPEN member-branch proposal: the
 * branch's own Refresh for the branch the proposal is on, so the same
 * authorization, cooldown, provider-backoff and attempt fences apply and a
 * terminal provider fact settles the suggestion at once. A branch that is no
 * longer OPEN is left to the sweeper.
 */
export async function refreshBranchOfProposal(
	caller: ProposalBranchCaller & { branchId: string },
): Promise<void> {
	const branch = await readableBranch(caller);
	await refreshProposalBranch({ ...caller, expectedAttempt: branch.attempt });
}

/** The branch, for its owner only; NOT_FOUND for anyone else. */
async function ownedBranch(
	caller: ProposalBranchCaller & { branchId: string },
): Promise<BranchRow> {
	const branch = await getMemberProposalBranch({
		branchId: caller.branchId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
	});
	if (!branch || branch.userId !== caller.userId) {
		return branchNotFound();
	}
	return branch;
}

/**
 * The live proposer check (spec Decision 18, §10): the caller may still
 * propose to the project's repository, `INSTRUCTION_CREATE`, or
 * `INSTRUCTION_READ` while the project allows reader proposals.
 */
async function assertProposerLive(caller: ProposalBranchCaller): Promise<void> {
	const sync = await getInstructionRepositorySyncForProposal(
		caller.projectId,
		caller.organizationId,
	);
	await assertRepositoryProposalAccess({
		projectId: caller.projectId,
		userId: caller.userId,
		allowReaders: sync?.allowReaderProposals === true,
	});
}

/** One branch in the panel, with its live change count (spec §10 "Tab"). */
type ProposalBranchPanelEntry = {
	branch: ProposalBranchView;
	liveChanges: number;
};

/** `proposals.myBranch`'s answer. */
export type MyProposalBranch = {
	/** The member's accepting branch, whose projection `files` is. */
	branch: ProposalBranchView | null;
	/** The accepting branch's live changes (spec §4.1 `live`). */
	liveChanges: number;
	/** What the accepting branch holds per path, as Fabric can prove it. */
	files: BranchProjectionEntry[];
	/** Every branch the panel shows: the accepting one plus any retired, closing, classifying or BLOCKED one. */
	branches: ProposalBranchPanelEntry[];
};

const REVIEWER_ONLY_MESSAGE = "Only a reviewer can see another member's branch";

/**
 * One member's `MyProposalBranch` view: the accepting branch, its live
 * change count and projection, and every branch the panel shows. No
 * authorization of its own — every caller here has already been checked,
 * either `readMyProposalBranch` (a caller reading their own, or a reviewer
 * reading one named member's) or `readProposalBranchesForReviewer` (a
 * reviewer reading every tracked member's, one call per owner).
 */
async function branchViewForMember(member: {
	projectId: string;
	userId: string;
	organizationId: string;
}): Promise<MyProposalBranch> {
	const [accepting, listed] = await Promise.all([
		getAcceptingBranchForMember(member),
		listMemberBranches(member),
	]);
	const ids = [
		...new Set([
			...listed.map((b) => b.id),
			...(accepting ? [accepting.id] : []),
		]),
	];
	const [live, files] = await Promise.all([
		countLiveBranchChanges({
			organizationId: member.organizationId,
			branchIds: ids,
		}),
		accepting
			? projectMemberBranch({
					branchId: accepting.id,
					organizationId: member.organizationId,
				})
			: Promise.resolve([] as BranchProjectionEntry[]),
	]);
	return {
		branch: accepting ? proposalBranchView(accepting) : null,
		liveChanges: accepting ? (live.get(accepting.id) ?? 0) : 0,
		files,
		branches: listed.map((b) => ({
			branch: proposalBranchView(b),
			liveChanges: live.get(b.id) ?? 0,
		})),
	};
}

/**
 * The member's branch (spec §10 "Tab", "Editor"). `forUserId` names another
 * member, for a reviewer only; omitted, it is the caller's own.
 */
export async function readMyProposalBranch(
	caller: ProposalBranchCaller & { forUserId?: string },
): Promise<MyProposalBranch> {
	const memberId = caller.forUserId ?? caller.userId;
	if (
		memberId !== caller.userId &&
		!(await canReviewInstructionProposals({
			projectId: caller.projectId,
			userId: caller.userId,
		}))
	) {
		throw new ORPCError("FORBIDDEN", { message: REVIEWER_ONLY_MESSAGE });
	}
	return branchViewForMember({
		projectId: caller.projectId,
		userId: memberId,
		organizationId: caller.organizationId,
	});
}

/** `readProposalBranchesForReviewer`'s page size when the caller asks for none. */
const PROPOSAL_BRANCH_OWNERS_DEFAULT_LIMIT = 20;
/**
 * The most owners `readProposalBranchesForReviewer` will ever return in one
 * page. Exported so the procedure's own `limit` input can cap at the same
 * number, rather than duplicating it as an unrelated magic number.
 */
export const PROPOSAL_BRANCH_OWNERS_MAX_LIMIT = 50;

/** One owner's branch, as `proposals.branches` returns it for a reviewer. */
export type ProposalBranchOwnerView = MyProposalBranch & {
	userId: string;
	userName: string | null;
};

/**
 * Every OTHER member with a tracked branch in the project, read-only, one
 * cursor-paged page at a time, independent of the proposal list's own
 * pagination (Fizzy #2738 spec §10 "Reviewers see every member's branches
 * read-only"): a member whose proposals are not on the tab's current page
 * still gets a panel here. Reviewer-only, refused with the same error
 * `readMyProposalBranch` gives for one named member's branch. The caller's
 * own branch, if they have one, is excluded — `readMyProposalBranch`'s
 * ownerless call already covers it, and a reviewer who is also proposing
 * would otherwise see it twice.
 *
 * Owner discovery is `listProposalBranchOwnerIds`, a query bounded and
 * cursor-paged IN THE DATABASE (round-3 review finding: the previous version
 * read every tracked branch in the project and capped the owner list in
 * memory, silently dropping the rest past the cap) — branches are then read
 * only for THIS page's owners, via the same `branchViewForMember`
 * `readMyProposalBranch` uses, rather than a second read path.
 */
export async function readProposalBranchesForReviewer(
	caller: ProposalBranchCaller & { cursor?: string; limit?: number },
): Promise<{ owners: ProposalBranchOwnerView[]; nextCursor: string | null }> {
	if (
		!(await canReviewInstructionProposals({
			projectId: caller.projectId,
			userId: caller.userId,
		}))
	) {
		throw new ORPCError("FORBIDDEN", { message: REVIEWER_ONLY_MESSAGE });
	}
	const limit = Math.min(
		caller.limit ?? PROPOSAL_BRANCH_OWNERS_DEFAULT_LIMIT,
		PROPOSAL_BRANCH_OWNERS_MAX_LIMIT,
	);
	const { ownerIds, nextCursor } = await listProposalBranchOwnerIds({
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		excludeUserId: caller.userId,
		...(caller.cursor !== undefined ? { cursor: caller.cursor } : {}),
		limit,
	});
	if (ownerIds.length === 0) {
		return { owners: [], nextCursor };
	}
	const [views, users] = await Promise.all([
		Promise.all(
			ownerIds.map(async (userId) => {
				const view = await branchViewForMember({
					projectId: caller.projectId,
					userId,
					organizationId: caller.organizationId,
				});
				return [userId, view] as const;
			}),
		),
		getUsersByIds(ownerIds),
	]);
	const viewByOwner = new Map(views);
	return {
		owners: ownerIds.flatMap((userId) => {
			const view = viewByOwner.get(userId);
			return view
				? [
						{
							userId,
							userName: users.get(userId)?.name ?? null,
							...view,
						},
					]
				: [];
		}),
		nextCursor,
	};
}

function branchFileNotFound(): never {
	throw new ORPCError("NOT_FOUND", {
		message: "This file is not on the branch as Fabric wrote it",
		data: { reason: "BRANCH_FILE_UNAVAILABLE" },
	});
}

/**
 * One `written` path's bytes on a branch, from the proposal whose stored
 * file Fabric wrote there (spec §10 `myBranchFile`), paged like `getFile`:
 * text as a body, a binary as a short-lived signed URL. A path Fabric does
 * not hold the bytes of (`restored_unavailable`, deleted, never written) is
 * NOT_FOUND, never other content: the stored file must be the one the
 * journal recorded, by sha256.
 */
export async function readMyProposalBranchFile(
	caller: ProposalBranchCaller & {
		branchId: string;
		path: string;
		offset: number;
		maxLength?: number;
	},
) {
	const branch = await readableBranch(caller);
	const projection = await projectMemberBranch({
		branchId: branch.id,
		organizationId: caller.organizationId,
	});
	const entry = projection.find((e) => e.path === caller.path);
	if (!entry || entry.state !== "written" || entry.snapshotId === null) {
		return branchFileNotFound();
	}
	const intent = await loadGitIntent({
		snapshotId: entry.snapshotId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
	});
	const changed =
		intent?.status === "READY"
			? intent.gitIntentEntries.find(
					(file) =>
						file.path === caller.path && file.operation === "PUT",
				)
			: undefined;
	const file = intent
		? changed &&
			changed.storageKey !== null &&
			changed.sha256 !== null &&
			changed.size !== null
			? {
					projectId: caller.projectId,
					path: changed.path,
					sha256: changed.sha256,
					storageKey: changed.storageKey,
					size: changed.size,
					mimeType:
						changed.mimeType ??
						fileTypingFor(changed.path).mimeType,
					isText: changed.isText,
					mode: changed.mode,
				}
			: null
		: await getInstructionFileByPath(
				entry.snapshotId,
				caller.organizationId,
				caller.path,
			);
	if (
		!file ||
		file.projectId !== caller.projectId ||
		(entry.sha256 !== null && file.sha256 !== entry.sha256)
	) {
		return branchFileNotFound();
	}
	const storage = getStorageProvider();
	const base = {
		branchId: branch.id,
		path: file.path,
		snapshotId: entry.snapshotId,
		sha256: file.sha256,
		size: file.size,
		mimeType: file.mimeType,
		isText: file.isText,
		mode: file.mode,
	};
	if (!file.isText) {
		const url = await storage.getSignedUrl(file.storageKey, {
			bucket: BUCKET,
			expiresIn: 300,
		});
		return {
			...base,
			body: null,
			offset: 0,
			nextOffset: null,
			truncated: false,
			url,
		};
	}
	const { data } = await storage.downloadFile(file.storageKey, {
		bucket: BUCKET,
	});
	const chars = Array.from(data.toString("utf8"));
	const maxLength = caller.maxLength ?? BRANCH_FILE_DEFAULT_MAX;
	const end = caller.offset + maxLength;
	const truncated = end < chars.length;
	return {
		...base,
		body: chars.slice(caller.offset, end).join(""),
		offset: caller.offset,
		nextOffset: truncated ? end : null,
		truncated,
		url: null,
	};
}

type BranchCommandCaller = ProposalBranchCaller & {
	branchId: string;
	expectedAttempt: number;
	requester: BranchCommandRequester;
};

/** A branch command's refusal, in words the tab can show. */
function branchCommandRefusal(
	result: Exclude<BranchCommandResult, { kind: "done" }>,
	notApplicable: string,
): never {
	switch (result.kind) {
		case "not_found":
			return branchNotFound();
		case "stale":
			throw new ORPCError("CONFLICT", {
				message:
					"Your branch changed since the page was loaded. Refresh and try again.",
				data: { reason: "BRANCH_CHANGED" },
			});
		case "not_applicable":
			throw new ORPCError("PRECONDITION_FAILED", {
				message: notApplicable,
				data: { reason: "BRANCH_ACTION_NOT_AVAILABLE" },
			});
	}
}

/** The answer every branch command gives. */
export type BranchCommandAnswer = { changed: boolean; attempt: number };

async function runBranchCommand(
	caller: BranchCommandCaller,
	run: (i: {
		branchId: string;
		projectId: string;
		organizationId: string;
		expectedAttempt: number;
		requester: BranchCommandRequester;
	}) => Promise<BranchCommandResult>,
	notApplicable: string,
): Promise<BranchCommandAnswer> {
	const result = await run({
		branchId: caller.branchId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		expectedAttempt: caller.expectedAttempt,
		requester: caller.requester,
	});
	if (result.kind !== "done") {
		return branchCommandRefusal(result, notApplicable);
	}
	if (result.changed) {
		await wakeAfterCommit(caller.branchId, caller);
	}
	return { changed: result.changed, attempt: result.attempt };
}

/**
 * Close pull request (spec Decision 11): withdraws every change on the
 * branch; settlement closes the pull request and deletes the branch only if
 * Fabric made every commit on it.
 */
export async function closeMyProposalBranch(
	caller: BranchCommandCaller,
): Promise<BranchCommandAnswer> {
	await ownedBranch(caller);
	return runBranchCommand(
		caller,
		closeProposalBranch,
		"This branch is already closed or settling.",
	);
}

/**
 * Start over on a new branch (spec Decision 11): only a branch whose pull
 * request Fabric could not confirm opening for 24 h, with no commits made
 * outside Fabric.
 */
export async function startOverMyProposalBranch(
	caller: BranchCommandCaller,
): Promise<BranchCommandAnswer> {
	await ownedBranch(caller);
	await assertProposerLive(caller);
	return runBranchCommand(
		caller,
		startOverProposalBranch,
		"Start over is offered only when Fabric could not confirm opening the pull request and the branch has no commits made outside Fabric.",
	);
}

/** Retry opening (spec Decision 17): only after PR_CREATION_REFUSED. */
export async function retryMyProposalBranch(
	caller: BranchCommandCaller,
): Promise<BranchCommandAnswer> {
	await ownedBranch(caller);
	await assertProposerLive(caller);
	return runBranchCommand(
		caller,
		requestProposalBranchRetry,
		"Only a pull request the repository refused to open can be retried.",
	);
}

/**
 * Stop tracking (spec Decision 19): a branch whose repository connection now
 * points elsewhere (REPOSITORY_CHANGED), by its owner or a reviewer. The
 * branch becomes CLOSED and untracked and its open changes CANCELED; nothing
 * is done in the repository.
 */
export async function stopTrackingMyProposalBranch(
	caller: BranchCommandCaller,
): Promise<BranchCommandAnswer> {
	const branch = await readableBranch(caller);
	if (branch.untracked) {
		return { changed: false, attempt: branch.attempt };
	}
	const code =
		branch.failure !== null && typeof branch.failure === "object"
			? (branch.failure as { code?: unknown }).code
			: null;
	if (code !== "REPOSITORY_CHANGED") {
		return branchCommandRefusal(
			{ kind: "not_applicable" },
			"Stop tracking is offered only when the repository connection points at another repository.",
		);
	}
	if (branch.attempt !== caller.expectedAttempt) {
		return branchCommandRefusal({ kind: "stale" }, "");
	}
	const stopped = await stopTrackingBranch({
		branchId: branch.id,
		organizationId: caller.organizationId,
		actorUserId: caller.userId,
	});
	if (!stopped.ok) {
		return branchCommandRefusal({ kind: "stale" }, "");
	}
	await wakeAfterCommit(branch.id, caller);
	return { changed: true, attempt: branch.attempt + 1 };
}

type ProposalCommandCaller = ProposalBranchCaller & {
	snapshotId: string;
	requester: BranchCommandRequester;
};

function proposalNotFound(): never {
	throw new ORPCError("NOT_FOUND", { message: "Proposal not found" });
}

/**
 * Try again (spec §4.3): a BLOCKED change with BRANCH_CONFLICT,
 * SUPERSEDED_BY_LATER_CHANGE or PUSH_OUTCOME_UNKNOWN, by its author, at the
 * attempt the card showed. `OPEN` when its commit turned out to be on the
 * branch already; otherwise `QUEUED` at the end of the branch, and the
 * branch workflow re-checks an unconfirmed push before appending again.
 */
export async function retryMyBranchConflict(
	caller: ProposalCommandCaller & { expectedAttempt: number },
): Promise<{ state: "OPEN" | "QUEUED"; attempt: number }> {
	await assertProposerLive(caller);
	const result = await tryBranchProposalAgain({
		snapshotId: caller.snapshotId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		proposerUserId: caller.userId,
		expectedAttempt: caller.expectedAttempt,
		requester: caller.requester,
	});
	switch (result.kind) {
		case "not_found":
			return proposalNotFound();
		case "stale":
			throw new ORPCError("CONFLICT", {
				message:
					"This change moved since the page was loaded. Refresh and try again.",
				data: { reason: "PROPOSAL_CHANGED" },
			});
		case "not_applicable":
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Try again is offered only for a change Fabric could not add to your branch.",
				data: { reason: "PROPOSAL_NOT_RETRYABLE" },
			});
		case "branch_not_accepting":
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Your branch no longer takes new changes. Close its pull request, then suggest the change again.",
				data: { reason: "BRANCH_NOT_ACCEPTING" },
			});
		case "open":
			await wakeAfterCommit(result.branchId, caller);
			return { state: "OPEN", attempt: result.attempt };
		case "queued":
			await wakeAfterCommit(result.branchId, caller);
			return { state: "QUEUED", attempt: result.attempt };
	}
}

/**
 * Propose again (spec Decision 14): a finished change Fabric could not
 * confirm was in the pull request, by its author. It moves to the member's
 * current branch, which Fabric opens if there is none, with a new intent
 * order.
 */
export async function proposeMyBranchChangeAgain(
	caller: ProposalCommandCaller,
): Promise<{ branchId: string; sequence: number }> {
	await assertProposerLive(caller);
	const result = await proposeBranchProposalAgain({
		snapshotId: caller.snapshotId,
		projectId: caller.projectId,
		organizationId: caller.organizationId,
		proposerUserId: caller.userId,
		naming: proposalBranchNaming,
		requester: caller.requester,
	});
	switch (result.kind) {
		case "not_found":
			return proposalNotFound();
		case "configuration_changed":
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"The project's repository settings changed since this change was suggested. Suggest it again from the current version.",
				data: { reason: "CONFIGURATION_CHANGED" },
			});
		case "not_applicable":
		case "not_joinable":
			throw new ORPCError("PRECONDITION_FAILED", {
				message:
					"Propose again is offered only for a finished change Fabric could not confirm was in the pull request.",
				data: { reason: "PROPOSAL_NOT_PROPOSABLE" },
			});
		case "joined":
		case "already":
			await wakeAfterCommit(result.branchId, caller);
			return { branchId: result.branchId, sequence: result.sequence };
	}
}
