/**
 * The classification of a closed member proposal branch (Fizzy #2738 spec
 * §6.6, Decision 14): which journal operations the pull request's final
 * history contains, and the evidence the settlement records while that
 * history is still reachable.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	type BranchOperationRow,
	type BranchWithClock,
	commitBranchClassification,
	deferBranchClassification,
	getProposalBranch,
	listBranchOperations,
	membershipStatusOf,
	recordBranchFailure,
	setOperationMembershipMany,
} from "@repo/database";
import { sourceHeadEvidence } from "@repo/integrations/instruction-pull-requests";
import { safeHeartbeat } from "./activity-liveness";
import {
	type BranchCredential,
	withBranchRepoCredential,
} from "./instruction-branch-credential";
import {
	fetchBranchHead,
	fetchPullRequestHead,
	initBranchWorkspace,
	isAncestor,
} from "./instruction-branch-git";
import {
	fetchTip,
	stepCredential,
	stepFailureOf,
} from "./instruction-branch-support";
import type { ClassifyBranchResult } from "./instruction-branch-types";
import { settleMigrationForObservedBranch } from "./instruction-migration-settlement";
import { failureJson } from "./instruction-proposal-boundary";
import { gitCall } from "./instruction-proposal-operation";

type BranchIds = { branchId: string; organizationId: string };

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Classification's backoff while the history cannot be fetched: 1, 5, 15, 60 min, then hourly. */
export function classificationBackoffMs(attempts: number): number {
	return [1, 5, 15, 60][Math.min(Math.max(attempts, 0), 3)] * MINUTE_MS;
}

type MembershipJson = { at?: unknown; attempts?: unknown };

/**
 * The final source history (spec §6.6 step 1, §7): the provider's head ref
 * at the observed `headSha`, or else the branch ref when its tip is exactly
 * that SHA. Complete and blobless, never shallow. False when neither is
 * available.
 */
async function fetchFinalHistory(
	credential: BranchCredential,
	branch: BranchWithClock,
	headSha: string,
): Promise<boolean> {
	const { env, signal } = credential;
	const dir = credential.workDir;
	await gitCall("reconcile", credential, () =>
		initBranchWorkspace({
			url: credential.url,
			targetRef: credential.destination.targetRef,
			dir,
			env,
			signal,
		}),
	);
	safeHeartbeat();
	const externalId = branch.pullRequestExternalId;
	if (externalId !== null) {
		const evidence = sourceHeadEvidence(
			credential.adapter,
			externalId,
			headSha,
		);
		if (!("kind" in evidence)) {
			const fetched = await gitCall("reconcile", credential, () =>
				fetchPullRequestHead({
					dir,
					ref: evidence.ref,
					sha: evidence.expectSha,
					env,
					signal,
				}),
			);
			if (fetched.kind === "ok") {
				return true;
			}
		}
	}
	safeHeartbeat();
	const tip = await gitCall("reconcile", credential, () =>
		fetchBranchHead({ dir, branch: branch.ref, env, signal }),
	);
	return tip.kind === "present" && tip.sha === headSha;
}

/** An established operation whose membership is still to be decided. */
function undecidedOps(ops: readonly BranchOperationRow[]) {
	return ops.filter(
		(op) =>
			(op.outcome === "acked" || op.outcome === "observed") &&
			op.membership !== "included",
	);
}

/**
 * Splits the undecided operations by the pull request's head. The head
 * commit is in its own history, so an operation at it is `included` without
 * a fetch, which a branch deleted without a provider head ref (Azure
 * DevOps) could not answer; the others need the history.
 */
export function partitionByHead(
	ops: readonly BranchOperationRow[],
	headSha: string | null,
): { atHead: BranchOperationRow[]; undecided: BranchOperationRow[] } {
	const atHead: BranchOperationRow[] = [];
	const undecided: BranchOperationRow[] = [];
	for (const op of undecidedOps(ops)) {
		(op.sha === headSha ? atHead : undecided).push(op);
	}
	return { atHead, undecided };
}

function writeMemberships(
	branch: BranchWithClock,
	ops: readonly BranchOperationRow[],
	membership: "included" | "unverified",
): Promise<number> {
	return setOperationMembershipMany({
		organizationId: branch.organizationId,
		entries: ops.map((op) => ({ operationId: op.id, membership })),
	});
}

/** The ids of the operations that are ancestors of `descendant` in the workspace. */
async function includedAmong(
	credential: BranchCredential,
	phase: "close" | "reconcile",
	ops: readonly BranchOperationRow[],
	descendant: string,
): Promise<Set<string>> {
	const included = new Set<string>();
	for (const op of ops) {
		safeHeartbeat();
		const ancestry = await gitCall(phase, credential, () =>
			isAncestor({
				dir: credential.workDir,
				ancestor: op.sha,
				descendant,
				env: credential.env,
				signal: credential.signal,
			}),
		);
		if (ancestry === "true") {
			included.add(op.id);
		}
	}
	return included;
}

/**
 * The classification evidence of a closed pull request, the one writer of
 * `included` before the classification runs. The classification
 * (`runClassify`) reads its final history from the provider's head ref, else
 * from the branch ref. Azure DevOps keeps no head ref, so once Fabric
 * deletes the branch that history is gone and the classification could only
 * wait out its 24 hours. Called while the branch is still there: operations
 * at the closed head, and those the branch's tip (verified equal to it)
 * contains, are recorded `included`, which leaves the classification
 * nothing to fetch. An operation not contained is left for the
 * classification to decide. One batch write, so a retried settlement
 * rewrites nothing it already decided.
 */
export async function recordClassificationEvidence(
	credential: BranchCredential,
	branch: BranchWithClock,
	ops: readonly BranchOperationRow[],
	closedHead: string,
): Promise<void> {
	const { atHead, undecided } = partitionByHead(ops, closedHead);
	const included = atHead.map((op) => op.id);
	if (undecided.length > 0 && branch.headSha === closedHead) {
		const tip = await fetchTip(credential, branch.ref, "close");
		if (tip.kind === "present" && tip.sha === closedHead) {
			included.push(
				...(await includedAmong(
					credential,
					"close",
					undecided,
					tip.sha,
				)),
			);
		}
	}
	await setOperationMembershipMany({
		organizationId: branch.organizationId,
		entries: included.map((operationId) => ({
			operationId,
			membership: "included",
		})),
	});
}

/**
 * `classifyBranch` (spec §6.6, Decision 14), only when no journal operation
 * lacks an outcome, at the `factsRevision` the loop read:
 *
 * 0. an established operation whose commit is the pull request's head takes
 *    `included` without a fetch;
 * 1. the final history (`fetchFinalHistory`), when any other remains;
 * 2. each established operation not already `included` takes `included`
 *    when `isAncestor(sha, headSha)` holds, `unverified` otherwise (a
 *    false or an error alike);
 * 3. `commitBranchClassification` applies Decision 14 to the proposals,
 *    conditional on `factsRevision`.
 *
 * History that cannot be fetched is retried with backoff
 * (`deferBranchClassification`, `retry_later`); 24 h after the membership
 * became pending, every established operation not already included is
 * marked unverified and the branch's membership becomes `unverified`.
 */
export async function runClassify(
	i: BranchIds & { factsRevision: number; signal: AbortSignal },
): Promise<ClassifyBranchResult["outcome"]> {
	const branch = await getProposalBranch(i);
	if (
		!branch ||
		branch.untracked ||
		membershipStatusOf(branch.membership) !== "pending" ||
		(branch.state !== "MERGED" && branch.state !== "CLOSED")
	) {
		return "stale_revision";
	}
	if (branch.factsRevision !== i.factsRevision) {
		return "stale_revision";
	}
	const ops = await listBranchOperations(i);
	if (ops.some((op) => op.outcome === null)) {
		return "stale_revision";
	}
	// Before the classification can ask for the merge-triggered sync: a pull
	// request that moved a project's uploads into the repository switches the
	// project over first, so that sync finds a repository-backed project; one
	// that ended without its files landing ends the move (Fizzy #2878 §9).
	await settleMigrationForObservedBranch(branch);
	const commit = async (
		status: "done" | "unverified",
	): Promise<ClassifyBranchResult["outcome"]> => {
		const committed = await commitBranchClassification({
			branchId: branch.id,
			organizationId: branch.organizationId,
			factsRevision: i.factsRevision,
			status,
		});
		return committed.kind === "done" ? status : "stale_revision";
	};
	const headSha = headShaOf(branch.pullRequestObservation);
	const { atHead, undecided } = partitionByHead(ops, headSha);
	await writeMemberships(branch, atHead, "included");
	if (undecided.length === 0) {
		return commit("done");
	}
	const membership = (branch.membership ?? {}) as MembershipJson;
	const pendingSince =
		typeof membership.at === "string"
			? Date.parse(membership.at)
			: Number.NaN;
	const expired =
		Number.isFinite(pendingSince) &&
		branch.databaseNow.getTime() - pendingSince >= DAY_MS;
	const unverifiedAll = async () => {
		await writeMemberships(branch, undecided, "unverified");
		return commit("unverified");
	};
	const defer = async (): Promise<ClassifyBranchResult["outcome"]> => {
		if (expired) {
			return unverifiedAll();
		}
		await deferBranchClassification({
			branchId: branch.id,
			organizationId: branch.organizationId,
			factsRevision: i.factsRevision,
			delayMs: classificationBackoffMs(
				typeof membership.attempts === "number"
					? membership.attempts
					: 0,
			),
		});
		return "retry_later";
	};
	if (headSha === null) {
		return defer();
	}
	try {
		return await withBranchRepoCredential(
			{ branch, phase: "reconcile", signal: i.signal },
			async (base) => {
				const credential = stepCredential(base, "classify");
				if (!(await fetchFinalHistory(credential, branch, headSha))) {
					return defer();
				}
				const included = await includedAmong(
					credential,
					"reconcile",
					undecided,
					headSha,
				);
				await setOperationMembershipMany({
					organizationId: branch.organizationId,
					entries: undecided.map((op) => ({
						operationId: op.id,
						membership: included.has(op.id)
							? "included"
							: "unverified",
					})),
				});
				return commit("done");
			},
		);
	} catch (error) {
		const failure = stepFailureOf(error);
		if (failure.code === "REPOSITORY_CHANGED") {
			await recordBranchFailure({
				branchId: branch.id,
				organizationId: branch.organizationId,
				failure: failureJson(failure),
			});
		}
		return defer();
	}
}

function headShaOf(observation: unknown): string | null {
	if (observation === null || typeof observation !== "object") {
		return null;
	}
	const sha = (observation as { headSha?: unknown }).headSha;
	return typeof sha === "string" && sha.length > 0 ? sha : null;
}
