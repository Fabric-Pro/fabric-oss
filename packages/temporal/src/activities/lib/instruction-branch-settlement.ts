/**
 * Observation, classification, rehome, settlement, confirmations and merge
 * sync of a member proposal branch (Fizzy #2738 spec §6.6, §6.7, Decisions
 * 11, 14, 19; #2563 §6.2 and §9.1 on the branch).
 *
 * Authority (Decision 18): everything here runs under the branch's recorded
 * tenant and integration; the live repository identity is re-checked by the
 * credential (REPOSITORY_CHANGED, Decision 19). Every lifecycle write is
 * fenced on the attempt read here; the journal's memberships are facts,
 * written conditional only on the operation's identity. Every failure is
 * failure-only, with a backoff, so the loop never turns a failure into a
 * hot loop.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import path from "node:path";
import {
	type BranchOperationRow,
	type BranchWithClock,
	blockUnrehomableProposal,
	clearBranchMergeSyncRequest,
	commitBranchClassification,
	deferBranchClassification,
	deferBranchConfirmation,
	findMergeTriggeredRun,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	getProposalBranch,
	getSyncRunReceiptByRunId,
	listBranchOperations,
	type MergeSyncTuple,
	markBranchMergeSyncDispatched,
	membershipStatusOf,
	type ProposalBranchNaming,
	parseBranchDestination,
	readBranchWork,
	recordBranchConfirmation,
	recordBranchDeleted,
	recordBranchFailure,
	recordBranchMergeSyncRun,
	recordBranchObservation,
	recordBranchReceipt,
	recordBranchSettlement,
	refuseBranchStartOver,
	setOperationMembership,
	transferProposal,
	transitionBranch,
} from "@repo/database";
import { memberBranchRef } from "@repo/instructions/proposal-branch-ref";
import { instructionRepositorySyncWorkflowId } from "@repo/instructions/workflow-ids";
import {
	type PullRequestObservation,
	repositoryIdentity,
	repositoryKey,
	sourceHeadEvidence,
} from "@repo/integrations/instruction-pull-requests";
import { getTemporalClient } from "../../client";
import { safeHeartbeat } from "./activity-liveness";
import { deleteIfFabricOwned } from "./instruction-branch-create";
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
	establishedShas,
	lookupBranchRef,
	observationOf,
	provenanceOf,
} from "./instruction-branch-support";
import type {
	ClassifyBranchResult,
	ReconcileBranchResult,
	RehomeBranchProposalsResult,
	SettleBranchResult,
} from "./instruction-branch-types";
import { wakeBranchWorkflow } from "./instruction-branch-wake";
import {
	abandonMigrationOfBranch,
	settleMigrationForObservedBranch,
} from "./instruction-migration-settlement";
import {
	asJson,
	assertMayContinue,
	cancellationOf,
	failureJson,
	nextAttemptAt,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	branchMergeSyncTarget,
	classifyMergeSyncReceipt,
	mergeSyncBackoffMs,
	mergeSyncDispatchesBefore,
} from "./instruction-proposal-merge-sync";
import { gitCall, providerCall } from "./instruction-proposal-operation";
import { startAutomaticInstructionSync } from "./instruction-sync-start";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * A non-retryable settlement or confirmation failure is looked at again
 * every 6 h (as #2563's close keeps looking at REMOTE_REF_CONFLICT): a
 * CLOSE_REQUESTED branch is due whenever its `nextAttemptAt` is, so a null
 * backoff would be a hot loop.
 */
const NON_RETRYABLE_RETRY_MS = 6 * HOUR_MS;

/** The naming and identity port `transferProposal` takes (as the API's). */
export const BRANCH_NAMING: ProposalBranchNaming = {
	memberBranchRef,
	repositoryIdentity,
	repositoryKey,
};

type BranchIds = { branchId: string; organizationId: string };

type Failure = {
	code: string | null;
	phase: string | null;
};

function failureOf(value: unknown): Failure {
	if (value === null || typeof value !== "object") {
		return { code: null, phase: null };
	}
	const f = value as { code?: unknown; phase?: unknown };
	return {
		code: typeof f.code === "string" ? f.code : null,
		phase: typeof f.phase === "string" ? f.phase : null,
	};
}

/** The workspace a step clones into: one directory per step, never reused. */
function stepCredential(
	credential: BranchCredential,
	step: string,
): BranchCredential {
	return { ...credential, workDir: path.join(credential.runDir, step) };
}

/** A blobless clone of the target, then the branch's tip, in `credential.workDir`. */
async function fetchTip(
	credential: BranchCredential,
	ref: string,
	phase: "close" | "reconcile",
): Promise<{ kind: "present"; sha: string } | { kind: "absent" }> {
	const { env, signal } = credential;
	const dir = credential.workDir;
	return gitCall(phase, credential, async () => {
		await initBranchWorkspace({
			url: credential.url,
			targetRef: credential.destination.targetRef,
			dir,
			env,
			signal,
		});
		safeHeartbeat();
		return fetchBranchHead({ dir, branch: ref, env, signal });
	});
}

/**
 * A failure on the branch, failure-only at the attempt read: its state
 * kept, its failure and next attempt written (a non-retryable one looked at
 * again in 6 h). REPOSITORY_CHANGED is written whatever the attempt
 * (Decision 19: it stops the branch). False when the branch moved first.
 */
async function recordStepFailure(
	branch: BranchWithClock,
	failure: ProposalStepFailure,
): Promise<boolean> {
	const next = nextAttemptAt(branch, {
		code: failure.code,
		retryable: failure.retryable,
		retryAfterSeconds: failure.retryAfterSeconds,
		nextAttemptDelayMs: failure.retryable
			? failure.nextAttemptDelayMs
			: NON_RETRYABLE_RETRY_MS,
	});
	if (failure.code === "REPOSITORY_CHANGED") {
		return recordBranchFailure({
			branchId: branch.id,
			organizationId: branch.organizationId,
			failure: failureJson(failure),
			nextAttemptAt: next,
		});
	}
	const moved = await transitionBranch({
		branchId: branch.id,
		organizationId: branch.organizationId,
		from: [branch.state],
		expectedAttempt: branch.attempt,
		to: "unchanged",
		bumpAttempt: false,
		data: {
			failure: asJson(failureJson(failure)),
			nextAttemptAt: next,
		},
	});
	return moved.ok;
}

/** Rethrows a stop; answers the step failure; rethrows anything else. */
function stepFailureOf(error: unknown): ProposalStepFailure {
	const stopped = cancellationOf(error);
	if (stopped) {
		throw stopped;
	}
	if (!(error instanceof ProposalStepFailure)) {
		throw error;
	}
	return error;
}

// ---------------------------------------------------------------------------
// Observation (spec §6.6 "Observation")
// ---------------------------------------------------------------------------

/**
 * `reconcileInstructionProposalBranch`: #2563's reconcile on an OPEN branch,
 * fenced on the attempt the sweeper read (or, without one, the attempt read
 * here). An open pull request records the check; a merged or closed one is
 * observed with its final `headSha`, membership `pending` and one
 * `pull_request_reconciled` (`recordBranchObservation`). A provider failure
 * is failure-only with its backoff; REPOSITORY_CHANGED stops the branch
 * (Decision 19). Answers the branch's state as it now stands.
 */
export async function runReconcile(
	i: BranchIds & { expectedAttempt?: number; signal: AbortSignal },
): Promise<ReconcileBranchResult["state"]> {
	const branch = await getProposalBranch(i);
	if (!branch) {
		return null;
	}
	const externalId = branch.pullRequestExternalId;
	const expected = i.expectedAttempt ?? branch.attempt;
	if (
		branch.untracked ||
		branch.state !== "OPEN" ||
		externalId === null ||
		branch.attempt !== expected
	) {
		return branch.state;
	}
	let observation: PullRequestObservation;
	try {
		observation = await withBranchRepoCredential(
			{ branch, phase: "reconcile", signal: i.signal },
			(credential) =>
				providerCall("reconcile", credential, () =>
					credential.adapter.get({
						...credential.target,
						externalId,
					}),
				),
		);
	} catch (error) {
		await recordStepFailure(branch, stepFailureOf(error));
		return branch.state;
	}
	if (observation.state === "OPEN") {
		const f = failureOf(branch.failure);
		await transitionBranch({
			branchId: branch.id,
			organizationId: branch.organizationId,
			from: ["OPEN"],
			expectedAttempt: expected,
			to: "unchanged",
			bumpAttempt: false,
			data: {
				lastCheckedAt: branch.databaseNow,
				pullRequestUrl: observation.url,
				nextAttemptAt: null,
				...(f.phase === "reconcile" ? { failure: null } : {}),
			},
		});
		return "OPEN";
	}
	const observed = await recordBranchObservation({
		branchId: branch.id,
		organizationId: branch.organizationId,
		observation: observationOf(observation),
		expectedAttempt: expected,
	});
	if (observed.observed) {
		return observation.state;
	}
	return (await getProposalBranch(i))?.state ?? null;
}

// ---------------------------------------------------------------------------
// Classification (spec §6.6, Decision 14)
// ---------------------------------------------------------------------------

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

/**
 * `classifyBranch` (spec §6.6, Decision 14), only when no journal operation
 * lacks an outcome, at the `factsRevision` the loop read:
 *
 * 1. the final history (`fetchFinalHistory`);
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
	const undecided = ops.filter(
		(op) =>
			(op.outcome === "acked" || op.outcome === "observed") &&
			op.membership !== "included",
	);
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
		for (const op of undecided) {
			await setOperationMembership({
				operationId: op.id,
				organizationId: branch.organizationId,
				membership: "unverified",
			});
		}
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
	const headSha = headShaOf(branch.pullRequestObservation);
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
				for (const op of undecided) {
					safeHeartbeat();
					const ancestry = await gitCall(
						"reconcile",
						credential,
						() =>
							isAncestor({
								dir: credential.workDir,
								ancestor: op.sha,
								descendant: headSha,
								env: credential.env,
								signal: credential.signal,
							}),
					);
					await setOperationMembership({
						operationId: op.id,
						organizationId: branch.organizationId,
						membership:
							ancestry === "true" ? "included" : "unverified",
					});
				}
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

// ---------------------------------------------------------------------------
// Rehome (spec §6.6 "Rehome", §4.3 "Rehome", Decision 15)
// ---------------------------------------------------------------------------

/**
 * `rehomeBranchProposals`: each rehomable proposal, in sequence order, is
 * transferred with `transferProposal` to its member's accepting branch
 * (its intent order kept), and that branch's workflow is woken. A proposal
 * the transfer will not move (`not_joinable`, or a stale destination the
 * transfer itself did not block) is BLOCKED CONFIGURATION_CHANGED in phase
 * admission (`blockUnrehomableProposal`), so the loop never offers it to
 * rehome again.
 */
export async function runRehome(
	i: BranchIds & { snapshotIds: readonly string[]; signal: AbortSignal },
): Promise<RehomeBranchProposalsResult> {
	const branch = await getProposalBranch(i);
	if (!branch || branch.untracked) {
		return { moved: 0, wakeBranchIds: [] };
	}
	let moved = 0;
	const wake = new Set<string>();
	for (const snapshotId of i.snapshotIds) {
		assertMayContinue(i.signal);
		safeHeartbeat();
		const r = await transferProposal({
			snapshotId,
			organizationId: i.organizationId,
			expectedBranchId: i.branchId,
			newIntentOrder: false,
			naming: BRANCH_NAMING,
		});
		if (r.kind === "joined" || r.kind === "already") {
			if (r.branchId !== i.branchId) {
				moved++;
				wake.add(r.branchId);
			}
			continue;
		}
		await blockUnrehomableProposal({
			branchId: i.branchId,
			organizationId: i.organizationId,
			snapshotId,
		});
	}
	for (const branchId of wake) {
		assertMayContinue(i.signal);
		await wakeBranchWorkflow(
			{
				branchId,
				projectId: branch.projectId,
				organizationId: i.organizationId,
			},
			i.signal,
		);
	}
	return { moved, wakeBranchIds: [...wake] };
}

// ---------------------------------------------------------------------------
// Settlement (spec §6.7, Decision 11)
// ---------------------------------------------------------------------------

type SettleOutcome = SettleBranchResult["outcome"];

/**
 * `settleBranch` (spec §6.7) on a CLOSE_REQUESTED branch at the attempt the
 * loop read:
 *
 * 0. With START_OVER only: a fresh tip, `isAncestor(headSha, tip)` and
 *    `revListOutside(startSha..tip)` empty; any finding (and an absent ref)
 *    refuses before every effect (`START_OVER_REFUSED`), a foreign finding
 *    also setting `foreignTipAt`.
 * 1. Lookup by receipt and on the ref: START_OVER adopts what it finds;
 *    otherwise MERGED wins, an open pull request is closed.
 * 2. `deleteIfFabricOwned` (leased at the verified `headSha`); its success
 *    is checkpointed (`deletedAt`, `settlementPhase = deleted`) before step
 *    3. Azure DevOps's refusal for an active pull request closes it and
 *    deletes once more. START_OVER without a deletion refuses.
 * 3. Lookup once more, as step 1.
 * 4. Record: a pull request found makes the branch CLOSED or MERGED, whose
 *    classification the loop runs next; none makes it CANCELED with the
 *    withdrawn proposals. START_OVER's live proposals are then rehomed.
 *
 * A settlement resumed at `settlementPhase = deleted` skips steps 0-2.
 * Every failure is failure-only with its backoff (`retry_later`).
 */
export async function runSettle(
	i: BranchIds & { branchAttempt: number; signal: AbortSignal },
): Promise<SettleOutcome> {
	const branch = await getProposalBranch(i);
	if (
		!branch ||
		branch.untracked ||
		branch.state !== "CLOSE_REQUESTED" ||
		branch.attempt !== i.branchAttempt
	) {
		return "moved";
	}
	const ops = await listBranchOperations(i);
	let outcome: SettleOutcome;
	try {
		outcome = await withBranchRepoCredential(
			{ branch, phase: "close", signal: i.signal },
			(credential) => settleUnder(credential, branch, ops),
		);
	} catch (error) {
		const recorded = await recordStepFailure(branch, stepFailureOf(error));
		return recorded ? "retry_later" : "moved";
	}
	if (outcome === "canceled" && branch.closeIntent !== "START_OVER") {
		// Fabric closed the pull request (a withdrawal): a move it carried is
		// canceled with it (Fizzy #2878 §9). A start over keeps the move, whose
		// proposal is rehomed below.
		await abandonMigrationOfBranch(branch, "canceled");
	}
	if (outcome !== "canceled" || branch.closeIntent !== "START_OVER") {
		return outcome;
	}
	// Step 4, START_OVER: the ref was deleted (or settlement would have
	// refused), so the live proposals move to the member's new branch.
	const settled = await getProposalBranch(i);
	const live = await listLiveForRehome(settled);
	if (live.length > 0) {
		await runRehome({ ...i, snapshotIds: live });
	}
	return "rehomed";
}

/** The proposals a START_OVER settlement rehomes: the loop's own `rehome` item's list. */
async function listLiveForRehome(
	branch: BranchWithClock | null,
): Promise<string[]> {
	if (!branch) {
		return [];
	}
	const read = await readBranchWork({
		branchId: branch.id,
		organizationId: branch.organizationId,
	});
	return read.work.kind === "rehome" ? read.work.snapshotIds : [];
}

async function settleUnder(
	credential: BranchCredential,
	branch: BranchWithClock,
	ops: readonly BranchOperationRow[],
): Promise<SettleOutcome> {
	const ids = {
		branchId: branch.id,
		organizationId: branch.organizationId,
	};
	const attempt = branch.attempt;
	const startOver = branch.closeIntent === "START_OVER";
	const resumed =
		branch.settlementPhase === "deleted" && branch.deletedAt !== null;
	let closed: PullRequestObservation | null = null;

	const refuse = async (foreign: boolean): Promise<SettleOutcome> => {
		const refused = await refuseBranchStartOver({
			...ids,
			expectedAttempt: attempt,
			foreign,
		});
		return refused ? "start_over_refused" : "moved";
	};

	const settle = async (
		to: "MERGED" | "CLOSED" | "CANCELED",
		observation: PullRequestObservation | null,
	): Promise<SettleOutcome> => {
		const recorded = await recordBranchSettlement({
			...ids,
			expectedAttempt: attempt,
			outcome: to,
			...(observation ? { observation: observationOf(observation) } : {}),
		});
		if (!recorded.ok) {
			return "moved";
		}
		return to === "MERGED"
			? "merged"
			: to === "CLOSED"
				? "closed"
				: "canceled";
	};

	/** Steps 1 and 3: by receipt, then on the ref; adopt (START_OVER), or close, MERGED winning. */
	const lookUpAndAct = async (): Promise<SettleOutcome | null> => {
		const seen = new Map<string, PullRequestObservation>();
		const externalId = branch.pullRequestExternalId;
		if (externalId !== null) {
			const got = await providerCall("close", credential, () =>
				credential.adapter.get({ ...credential.target, externalId }),
			);
			seen.set(got.externalId, got);
		}
		const found = await lookupBranchRef(credential, branch.ref, "close");
		if (found.kind === "inconclusive") {
			throw found.failure;
		}
		if (found.kind === "found") {
			seen.set(found.observation.externalId, found.observation);
		}
		for (const observation of seen.values()) {
			if (startOver) {
				const adopted = await recordBranchReceipt({
					...ids,
					expectedAttempt: attempt,
					from: ["CLOSE_REQUESTED"],
					observation: observationOf(observation),
					adopted: true,
					endsSettlement: true,
				});
				return adopted.kind === "moved" ? "adopted" : "moved";
			}
			if (observation.state === "MERGED") {
				return settle("MERGED", observation); // MERGED wins; no deletion
			}
			if (observation.state === "OPEN") {
				const after = await providerCall("close", credential, () =>
					credential.adapter.close({
						...credential.target,
						externalId: observation.externalId,
					}),
				);
				if (after.state === "MERGED") {
					return settle("MERGED", after);
				}
				closed = after;
			} else {
				closed = observation;
			}
		}
		return null;
	};

	if (!resumed) {
		// Step 0: START_OVER's fresh provenance check, before every effect.
		if (startOver) {
			const headSha = branch.headSha;
			const startSha = branch.startSha;
			if (headSha === null || startSha === null) {
				return refuse(false);
			}
			const check = stepCredential(credential, "provenance");
			const tip = await fetchTip(check, branch.ref, "close");
			if (tip.kind !== "present") {
				return refuse(false);
			}
			const ancestry = await gitCall("close", check, () =>
				isAncestor({
					dir: check.workDir,
					ancestor: headSha,
					descendant: tip.sha,
					env: check.env,
					signal: check.signal,
				}),
			);
			const provenance = await gitCall("close", check, () =>
				provenanceOf({
					dir: check.workDir,
					env: check.env,
					signal: check.signal,
					from: startSha,
					tip: tip.sha,
					known: establishedShas(ops),
				}),
			);
			if (ancestry !== "true" || provenance.foreign) {
				return refuse(true);
			}
		}
		// Step 1.
		const first = await lookUpAndAct();
		if (first) {
			return first;
		}
		// Step 2: delete only what Fabric alone made, leased at the tip.
		safeHeartbeat();
		let deleted = await deleteIfFabricOwned(
			stepCredential(credential, "delete-1"),
			branch,
			ops,
		);
		if (deleted === "refused") {
			// Azure DevOps refuses to delete a branch an active pull request
			// uses: close it (step 1) and delete once more.
			const again = await lookUpAndAct();
			if (again) {
				return again;
			}
			deleted = await deleteIfFabricOwned(
				stepCredential(credential, "delete-2"),
				branch,
				ops,
			);
			if (deleted === "refused") {
				throw new ProposalStepFailure({
					code: "BRANCH_WRITE_REFUSED",
					phase: "close",
					retryable: true,
				});
			}
		}
		if (deleted === "deleted") {
			// The checkpoint: a resumed settlement skips steps 0-2.
			const marked = await recordBranchDeleted({
				...ids,
				expectedAttempt: attempt,
			});
			if (!marked) {
				return "moved";
			}
		} else if (startOver) {
			// No leased delete at the verified head: the restart aborts and
			// nothing is rehomed.
			return refuse(false);
		}
	}
	// Step 3: a create that landed between the lookup and the deletion.
	safeHeartbeat();
	const last = await lookUpAndAct();
	if (last) {
		return last;
	}
	// Step 4.
	return closed ? settle("CLOSED", closed) : settle("CANCELED", null);
}

// ---------------------------------------------------------------------------
// Confirmations (spec §6.7 step 4, #2563 §6.2 step 4)
// ---------------------------------------------------------------------------

/**
 * `runBranchConfirmations`: a settled branch's due confirmation (1 h, then
 * 24 h after `settledAt`). The ref is looked up; a pull request other than
 * the branch's own is closed when open, and a CANCELED branch becomes
 * MERGED (one that merged) or CLOSED (one closed, here or earlier), to be
 * classified: replay-safe when the attempt that closed it died before
 * recording.
 * The count is conditional on the count read, never on the attempt. A
 * lookup that cannot answer moves only the due time (15 min; 6 h for a
 * non-retryable failure).
 */
export async function runConfirmations(
	i: BranchIds & { signal: AbortSignal },
): Promise<"confirmed" | "deferred" | "not_due"> {
	const branch = await getProposalBranch(i);
	if (
		!branch ||
		branch.untracked ||
		branch.settledAt === null ||
		branch.confirmationDueAt === null ||
		branch.confirmationDueAt.getTime() > branch.databaseNow.getTime()
	) {
		return "not_due";
	}
	const confirmations = branch.confirmations;
	try {
		await withBranchRepoCredential(
			{ branch, phase: "close", signal: i.signal },
			async (credential) => {
				const found = await lookupBranchRef(
					credential,
					branch.ref,
					"close",
				);
				if (found.kind === "inconclusive") {
					throw found.failure;
				}
				let late:
					| {
							observation: ReturnType<typeof observationOf>;
							to: "CLOSED" | "MERGED" | "unchanged";
					  }
					| undefined;
				if (
					found.kind === "found" &&
					found.observation.externalId !==
						branch.pullRequestExternalId
				) {
					let observation = found.observation;
					let closedHere = false;
					if (observation.state === "OPEN") {
						const externalId = observation.externalId;
						observation = await providerCall(
							"close",
							credential,
							() =>
								credential.adapter.close({
									...credential.target,
									externalId,
								}),
						);
						closedHere = true;
					}
					// As settlement's own lookup (spec §6.7 steps 1 and 4): a pull
					// request found on the ref makes a CANCELED branch MERGED when it
					// merged, CLOSED when it is closed, whoever closed it. A retry
					// whose earlier attempt closed it and died before recording
					// sees it already CLOSED and must converge the same way.
					let to: "CLOSED" | "MERGED" | "unchanged" = "unchanged";
					if (branch.state === "CANCELED") {
						if (observation.state === "MERGED") {
							to = "MERGED";
						} else if (
							observation.state === "CLOSED" ||
							closedHere
						) {
							to = "CLOSED";
						}
					}
					late = { observation: observationOf(observation), to };
				}
				await recordBranchConfirmation({
					branchId: branch.id,
					organizationId: branch.organizationId,
					confirmations,
					...(late ? { found: late } : {}),
				});
			},
		);
		return "confirmed";
	} catch (error) {
		const failure = stepFailureOf(error);
		if (failure.code === "REPOSITORY_CHANGED") {
			await recordBranchFailure({
				branchId: branch.id,
				organizationId: branch.organizationId,
				failure: failureJson(failure),
			});
		}
		await deferBranchConfirmation({
			branchId: branch.id,
			organizationId: branch.organizationId,
			confirmations,
			delayMs: failure.retryable
				? 15 * MINUTE_MS
				: NON_RETRYABLE_RETRY_MS,
		});
		return "deferred";
	}
}

// ---------------------------------------------------------------------------
// Merge sync (spec §6.6 "Merge sync", #2563 §9.1)
// ---------------------------------------------------------------------------

function mergeSyncTupleOf(value: unknown): MergeSyncTuple | null {
	const v = value as { syncId?: unknown; generation?: unknown } | null;
	return typeof v?.syncId === "string" && typeof v.generation === "number"
		? { syncId: v.syncId, generation: v.generation }
		: null;
}

/** Temporal client calls under the attempt's signal (as #2563's dispatcher). */
async function withClientSignal<T>(
	signal: AbortSignal,
	fn: (client: Awaited<ReturnType<typeof getTemporalClient>>) => Promise<T>,
): Promise<T> {
	assertMayContinue(signal);
	const client = await getTemporalClient();
	return client.withAbortSignal(signal, () => fn(client));
}

/** Whether the sync workflow's run `runId` is still running; unknown counts as running. */
async function syncRunRunning(
	projectId: string,
	runId: string,
	signal: AbortSignal,
): Promise<boolean> {
	try {
		const description = await withClientSignal(signal, (client) =>
			client.workflow
				.getHandle(
					instructionRepositorySyncWorkflowId(projectId),
					runId,
				)
				.describe(),
		);
		return description.status.name === "RUNNING";
	} catch (error) {
		const stopped = cancellationOf(error);
		if (stopped) {
			throw stopped;
		}
		return !(
			error instanceof Error && error.name === "WorkflowNotFoundError"
		);
	}
}

export type BranchMergeSyncResult =
	| "idle"
	| "waiting"
	| "acknowledged"
	| "dispatched"
	| "failed"
	| "gave_up"
	| "moved";

/**
 * `dispatchBranchMergeSync`: #2563 §9.1 steps 1-5 once per MERGED branch
 * with a merge-sync request (set by classification unless `targetMismatch`):
 * give up after 24 h or when the destination changed; adopt the run it
 * dispatched (by run id, else the newest merge-triggered run for the tuple);
 * acknowledge a consuming receipt, wait on one in flight, and re-dispatch
 * on a retaining receipt or none with the 5, 15, then 60 minute backoff.
 */
export async function runBranchMergeSync(
	i: BranchIds & { signal: AbortSignal },
): Promise<BranchMergeSyncResult> {
	const branch = await getProposalBranch(i);
	const requestedAt = branch?.mergeSyncRequestedAt ?? null;
	if (
		!branch ||
		branch.untracked ||
		requestedAt === null ||
		branch.state !== "MERGED"
	) {
		return "idle";
	}
	const ids = { branchId: branch.id, organizationId: branch.organizationId };
	const expected = mergeSyncTupleOf(branch.mergeSyncExpected);
	const giveUp = async (
		code: "CONFIGURATION_CHANGED" | "MERGE_SYNC_FAILED",
	): Promise<BranchMergeSyncResult> => {
		const cleared = await clearBranchMergeSyncRequest({
			kind: "gave_up",
			...ids,
			expected,
			failure: {
				phase: "merge_sync",
				code,
				retryable: false,
				at: branch.databaseNow.toISOString(),
				params: {},
			},
		});
		return cleared ? "gave_up" : "moved";
	};
	const elapsed = branch.databaseNow.getTime() - requestedAt.getTime();
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(
			branch.projectId,
			branch.organizationId,
		),
		getProjectInstructionSettings(branch.projectId, branch.organizationId),
	]);
	const target = branchMergeSyncTarget({
		elapsedMs: elapsed,
		destination: parseBranchDestination(branch.destination),
		sync: sync
			? {
					id: sync.id,
					generation: sync.generation,
					repositoryIntegrationId: sync.repositoryIntegrationId,
					ref: sync.ref,
					rootPath: sync.rootPath,
				}
			: null,
		sourceOfTruth: settings.sourceOfTruth,
	});
	if (target.kind === "give_up") {
		return giveUp(target.code);
	}
	const current = target.tuple;

	// Step 2: adopt what was dispatched.
	if (branch.mergeSyncDispatchedAt && expected) {
		const receipt = branch.mergeSyncRunId
			? await getSyncRunReceiptByRunId({
					projectId: branch.projectId,
					organizationId: branch.organizationId,
					runId: branch.mergeSyncRunId,
				})
			: await findMergeTriggeredRun({
					projectId: branch.projectId,
					organizationId: branch.organizationId,
					syncId: expected.syncId,
					generation: expected.generation,
					startedAtOrAfter: requestedAt,
				});
		if (receipt) {
			const verdict = classifyMergeSyncReceipt(receipt, {
				projectId: branch.projectId,
				syncId: expected.syncId,
				generation: expected.generation,
				requestedAt,
			});
			if (verdict === "wait") {
				return "waiting";
			}
			if (verdict === "consuming") {
				const acknowledged = await clearBranchMergeSyncRequest({
					kind: "acknowledged",
					...ids,
					expected: {
						syncId: receipt.syncId,
						generation: receipt.generation,
					},
					audit: {
						action: "project.instructions.pull_request_merge_sync_requested",
						category: "project",
						actor: { type: "system" },
						organizationId: branch.organizationId,
						projectId: branch.projectId,
						resource: {
							type: "project_instruction_proposal_branch",
							id: branch.id,
							name: `#${branch.number}`,
						},
						metadata: {
							branchId: branch.id,
							syncRunKey: receipt.id,
						},
					},
				});
				return acknowledged ? "acknowledged" : "moved";
			}
		} else if (
			branch.mergeSyncRunId &&
			(await syncRunRunning(
				branch.projectId,
				branch.mergeSyncRunId,
				i.signal,
			))
		) {
			return "waiting"; // started, no receipt yet
		}
	}

	// Step 3: dispatch, after one conditional write.
	const backoff = mergeSyncBackoffMs(mergeSyncDispatchesBefore(elapsed));
	const nextAttempt = new Date(branch.databaseNow.getTime() + backoff);
	assertMayContinue(i.signal);
	const marked = await markBranchMergeSyncDispatched({
		...ids,
		lastExpected: expected,
		next: current,
		dispatchedAt: branch.databaseNow,
		nextAttemptAt: nextAttempt,
	});
	if (!marked) {
		return "moved";
	}
	let runId: string;
	try {
		({ runId } = await withClientSignal(i.signal, () =>
			startAutomaticInstructionSync({
				projectId: branch.projectId,
				organizationId: branch.organizationId,
				trigger: "PULL_REQUEST_MERGED",
				expected: current,
			}),
		));
	} catch (error) {
		const cancelled = cancellationOf(error);
		if (cancelled) {
			throw cancelled;
		}
		// The outcome is unknown: the dispatch mark stays, so the next tick
		// adopts a run the server did start before starting another.
		const failed = new ProposalStepFailure({
			code: "SYNC_START_FAILED",
			phase: "merge_sync",
			retryable: true,
		});
		await transitionBranch({
			...ids,
			from: ["MERGED"],
			expectedAttempt: branch.attempt,
			to: "unchanged",
			bumpAttempt: false,
			data: {
				failure: asJson(failureJson(failed)),
				nextAttemptAt: nextAttempt,
			},
		});
		return "failed";
	}
	await recordBranchMergeSyncRun({ ...ids, expected: current, runId });
	return "dispatched";
}
