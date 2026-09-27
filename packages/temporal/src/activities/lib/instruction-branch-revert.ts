/**
 * Withdrawal after append: the revert (Fizzy #2738 spec §6.8 "Revert",
 * §4.3 revert rows, Decision 10, 18).
 *
 * A revert restores each path's entry from before the proposal's append,
 * only where the branch still holds exactly that append's entry AND no
 * commit outside Fabric's established journal touched the path since the
 * append (per-path provenance, never equality alone). Anything else is
 * WITHDRAW_CONFLICT: the proposal returns to OPEN, its command cleared.
 *
 * Authority (Decision 18): the withdrawal was authorized once by its
 * procedure. The revert checks only the tenant, the live repository identity
 * against the frozen one (the credential), fencing and the per-file rule;
 * never the member's live permission, so a revoked member's authorized
 * withdrawal still runs.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	type BranchProposalRow,
	currentAppend,
	getBranchProposal,
	getProposalBranch,
	isTerminalBranchState,
	listBranchOperations,
	markForeignTip,
	recordBranchOperation,
	recordOperationOutcome,
} from "@repo/database";
import type { PullRequestContextV2 } from "@repo/instructions";
import { safeHeartbeat } from "./activity-liveness";
import {
	type BranchCredential,
	destinationOf,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	fetchBranchHead,
	initBranchWorkspace,
	isAncestor,
	pushFastForward,
	readTreeEntries,
} from "./instruction-branch-git";
import { reobserveAgainstTip } from "./instruction-branch-recovery";
import {
	commitDate,
	contextOf,
	establishedShas,
	firstLine,
	pathParams,
	pathUntouchedSince,
	provenanceOf,
	sameEntry,
} from "./instruction-branch-support";
import type { RevertBranchProposalResult } from "./instruction-branch-types";
import {
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import { buildBranchCommit } from "./instruction-proposal-commit";
import { gitCall } from "./instruction-proposal-operation";

type RevertOutcome = RevertBranchProposalResult["outcome"];

/** Spec §9: BRANCH_MOVED covers a revert's lease refusals too. */
const MAX_LEASE_REFUSALS = 3;
const MAX_PASSES = 8;

const REVERT = "revert" as const;

const fail = (
	code: ProposalStepFailure["code"],
	retryable: boolean,
	params?: Record<string, string | number | boolean>,
) => new ProposalStepFailure({ code, phase: REVERT, retryable, params });

/** The revert this activity runs, fenced on the attempt `CLOSE_REQUESTED` was read at. */
export type RevertInput = {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	proposalAttempt: number;
	signal: AbortSignal;
};

/**
 * Thrown when the push command itself did not answer (a transport failure
 * after the operation was recorded): the operation stays issued and the
 * loop's recovery decides it. Carries nothing but its cause's class.
 */
export class RevertPushUnanswered extends Error {
	constructor() {
		super("Revert push outcome unknown");
		this.name = "RevertPushUnanswered";
	}
}

function claimHolds(
	p: BranchProposalRow | null,
	i: Pick<RevertInput, "branchId" | "proposalAttempt">,
): p is BranchProposalRow {
	return (
		p !== null &&
		p.proposalBranchId === i.branchId &&
		p.pullRequestState === "CLOSE_REQUESTED" &&
		p.pullRequestAttempt === i.proposalAttempt
	);
}

/**
 * `revertBranchProposal`'s body (spec §6.8). Throws `ProposalStepFailure`
 * for the activity to record (a non-retryable one is the §4.3 revert-refused
 * row: OPEN, command cleared; a retryable one is failure-only on
 * CLOSE_REQUESTED); returns every other outcome itself.
 */
export async function runBranchRevert(i: RevertInput): Promise<RevertOutcome> {
	const ids = { branchId: i.branchId, organizationId: i.organizationId };
	const [branch, proposal, ops] = await Promise.all([
		getProposalBranch(ids),
		getBranchProposal({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
		}),
		listBranchOperations(ids),
	]);
	if (
		!branch ||
		branch.untracked ||
		isTerminalBranchState(branch.state) ||
		!claimHolds(proposal, i)
	) {
		return "stopped";
	}
	if (ops.some((op) => op.outcome === null)) {
		return "retry_later";
	}
	const context = contextOf(proposal.pullRequestContext, REVERT);
	destinationOf(branch, REVERT);
	return withBranchRepoCredential(
		{ branch, phase: REVERT, signal: i.signal },
		(credential) => revertUnder(i, credential, context),
	);
}

async function revertUnder(
	i: RevertInput,
	credential: BranchCredential,
	context: PullRequestContextV2,
): Promise<RevertOutcome> {
	const { env, signal } = credential;
	const dir = credential.workDir;
	await gitCall(REVERT, credential, () =>
		initBranchWorkspace({
			url: credential.url,
			targetRef: credential.destination.targetRef,
			dir,
			env,
			signal,
		}),
	);
	safeHeartbeat();
	let leaseRefusals = 0;
	for (let pass = 0; pass < MAX_PASSES; pass++) {
		assertMayContinue(signal);
		const result = await revertPass(i, credential, context);
		if (result === "restart") {
			continue;
		}
		if (result === "lease") {
			leaseRefusals++;
			if (leaseRefusals >= MAX_LEASE_REFUSALS) {
				throw fail("BRANCH_MOVED", true);
			}
			continue;
		}
		return result;
	}
	throw new Error("Branch revert exceeded its restarts");
}

async function revertPass(
	i: RevertInput,
	credential: BranchCredential,
	context: PullRequestContextV2,
): Promise<RevertOutcome | "restart" | "lease"> {
	const { env, signal } = credential;
	const dir = credential.workDir;
	const git = { dir, env, signal };
	const ids = { branchId: i.branchId, organizationId: i.organizationId };
	const [branch, proposal, ops] = await Promise.all([
		getProposalBranch(ids),
		getBranchProposal({
			snapshotId: i.snapshotId,
			organizationId: i.organizationId,
		}),
		listBranchOperations(ids),
	]);
	if (
		!branch ||
		branch.untracked ||
		isTerminalBranchState(branch.state) ||
		!claimHolds(proposal, i)
	) {
		return "stopped";
	}
	// Spec §6 loop item 1, on every pass: an operation issued since the
	// entry check (an overlapping attempt) is recovered by the loop first.
	if (ops.some((op) => op.outcome === null)) {
		return "retry_later";
	}

	// §6.4 step 1: the tip. A revert needs a branch to write to.
	const fetched = await gitCall(REVERT, credential, () =>
		fetchBranchHead({ ...git, branch: branch.ref }),
	);
	safeHeartbeat();
	if (fetched.kind === "absent") {
		throw fail("WITHDRAW_CONFLICT", false);
	}
	const T = fetched.sha;

	// §6.2 step 5 (withdraw-again): `unknown` operations on this ref are
	// resolved once more first. An earlier revert proven present completes
	// the withdrawal without issuing anything.
	const unresolved = ops.filter(
		(op) => op.ref === branch.ref && op.outcome === "unknown",
	);
	if (unresolved.length > 0) {
		const results = await gitCall(REVERT, credential, () =>
			reobserveAgainstTip({
				...git,
				tip: T,
				known: establishedShas(ops),
				organizationId: i.organizationId,
				ops: unresolved,
			}),
		);
		if (results.some((r) => r.snapshotId === i.snapshotId && r.changed)) {
			const after = await getBranchProposal({
				snapshotId: i.snapshotId,
				organizationId: i.organizationId,
			});
			return after?.pullRequestState === "CANCELED"
				? "canceled_by_evidence"
				: "stopped";
		}
		if (results.some((r) => r.observed)) {
			return "restart";
		}
	}

	// The append this withdrawal reverts: the current append, established.
	// The evidence helpers read one proposal's operations; the branch's
	// other proposals share its assignment numbers.
	const append = currentAppend(
		ops.filter((op) => op.snapshotId === i.snapshotId),
		{ branchId: i.branchId, assignment: proposal.proposalAssignment },
	);
	const appendOp = append ? ops.find((op) => op.id === append.id) : undefined;
	if (
		!appendOp ||
		appendOp.kind !== "APPEND" ||
		(appendOp.outcome !== "acked" && appendOp.outcome !== "observed")
	) {
		return "stopped";
	}

	// §6.4 step 4: provenance of the whole branch, recorded when foreign.
	const known = establishedShas(ops);
	if (branch.startSha !== null) {
		const startSha = branch.startSha;
		const p = await gitCall(REVERT, credential, () =>
			provenanceOf({ ...git, from: startSha, tip: T, known }),
		);
		if (p.foreign) {
			await markForeignTip(ids);
		}
	}

	// §6.8 step 2: every written path must still hold the append's own
	// entry AND carry no commit outside the journal since the append.
	const entries = appendOp.entries;
	const tipEntries = await gitCall(REVERT, credential, () =>
		readTreeEntries({
			...git,
			sha: T,
			rawPaths: entries.map((e) => e.rawPath),
		}),
	);
	const appendAncestry = await gitCall(REVERT, credential, () =>
		isAncestor({ ...git, ancestor: appendOp.sha, descendant: T }),
	);
	const conflicts: string[] = [];
	for (const e of entries) {
		safeHeartbeat();
		const laterWrite = ops.some(
			(op) =>
				(op.outcome === "acked" || op.outcome === "observed") &&
				op.executionSeq > appendOp.executionSeq &&
				op.entries.some((x) => x.rawPath === e.rawPath),
		);
		if (
			laterWrite ||
			!sameEntry(tipEntries.get(e.rawPath) ?? null, e.after) ||
			!(await gitCall(REVERT, credential, () =>
				pathUntouchedSince({
					...git,
					from: appendOp.sha,
					tip: T,
					known,
					rawPath: e.rawPath,
					ancestry: appendAncestry,
				}),
			))
		) {
			conflicts.push(e.path);
		}
	}
	if (conflicts.length > 0) {
		throw fail("WITHDRAW_CONFLICT", false, pathParams(conflicts));
	}

	// §6.8 step 3: restore each `before` (null = delete), mode included.
	const built = await gitCall(REVERT, credential, () =>
		buildBranchCommit({
			...git,
			parent: T,
			plan: entries.map((e) => ({ rawPath: e.rawPath, after: e.before })),
			author: context.author,
			committer: context.committer,
			message: `Withdraw: ${firstLine(context.message)}\n\nFabric-Withdraw: ${proposal.pullRequestOperationId ?? proposal.id}`,
			date: commitDate(branch.databaseNow),
		}),
	);
	if (!built.ok) {
		throw fail("GIT_FAILED", false);
	}
	assertMayContinue(signal);

	// §6.4 steps 8-10 with kind REVERT: the operation stores the reverted
	// append's entries unchanged.
	const recorded = await recordBranchOperation({
		...ids,
		snapshotId: i.snapshotId,
		proposalAttempt: i.proposalAttempt,
		kind: "REVERT",
		ref: branch.ref,
		parentSha: T,
		sha: built.sha,
		entries,
	});
	if (!recorded.ok) {
		return recorded.unresolved ? "retry_later" : "stopped";
	}
	let pushed: Awaited<ReturnType<typeof pushFastForward>>;
	try {
		pushed = await gitCall(REVERT, credential, () =>
			pushFastForward({
				...git,
				parentSha: T,
				sha: built.sha,
				branch: branch.ref,
			}),
		);
	} catch (error) {
		if (signal.aborted) {
			throw error;
		}
		// No definitive answer: the operation stays issued for recovery.
		throw new RevertPushUnanswered();
	}
	const notPushed = () =>
		recordOperationOutcome({
			operationId: recorded.operationId,
			organizationId: i.organizationId,
			outcome: "not_pushed",
		});
	if (pushed.kind === "stale") {
		const r = await notPushed();
		return r.reconcile.changed ? "stopped" : "lease";
	}
	if (pushed.kind === "refused") {
		await notPushed();
		throw fail("BRANCH_WRITE_REFUSED", true);
	}
	// The reducer completes the withdrawal: CANCELED ("Withdrawn from your
	// branch"). A foreign tip was already recorded above.
	await recordOperationOutcome({
		operationId: recorded.operationId,
		organizationId: i.organizationId,
		outcome: "acked",
		audit: { actorUserId: proposal.userId, recovered: false },
	});
	return "reverted";
}
