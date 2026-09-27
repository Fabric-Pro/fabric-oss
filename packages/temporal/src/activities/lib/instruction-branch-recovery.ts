/**
 * Recovery of issued member-branch operations and re-observation of
 * `unknown` ones (Fizzy #2738 spec §6.2, and the no-op guard of §6.4 step 5 /
 * Decision 12).
 *
 * The verdict is ancestry in the ref's complete fetched history, never
 * object existence and never content: `isAncestor(sha, tip)` true is
 * `observed`, anything else is `unknown`. Recovery never concludes
 * `not_pushed`; only the push command's own definitive answer does, at push
 * time. Every verdict is written by `recordOperationOutcome`, which runs the
 * lifecycle reducer in the same transaction.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	type BranchOperationRow,
	getBranchOperation,
	getProposalBranch,
	listBranchOperations,
	recordOperationOutcome,
} from "@repo/database";
import { safeHeartbeat } from "./activity-liveness";
import { withBranchRepoCredential } from "./instruction-branch-credential";
import {
	fetchBranchHead,
	initBranchWorkspace,
	isAncestor,
	revListOutside,
} from "./instruction-branch-git";
import { establishedShas } from "./instruction-branch-support";
import { gitCall } from "./instruction-proposal-operation";
import type { GitCallBase } from "./instruction-sync-git";

export type OperationVerdict = {
	outcome: "observed" | "unknown";
	/** Spec §6.2 step 3: an unknown verdict, or a tip beyond `sha` with commits Fabric did not push. */
	foreignTip: boolean;
};

/**
 * Spec §6.2 step 2 against an already fetched tip (`null`: the ref is
 * absent). `observed` only on proven ancestry; the ref absent, the tip at
 * the parent, a descendant of the parent without `sha`, a rewrite that
 * dropped it and an `isAncestor` error are all `unknown`, which also sets
 * `foreignTipAt` (provenance unknown, deletion disabled). An observed
 * operation under a tip that carries commits outside the established
 * journal also sets it.
 */
export async function verdictAgainstTip(
	input: GitCallBase & {
		dir: string;
		sha: string;
		tip: string | null;
		known: ReadonlySet<string>;
	},
): Promise<OperationVerdict> {
	if (input.tip === null) {
		return { outcome: "unknown", foreignTip: true };
	}
	const ancestry = await isAncestor({
		dir: input.dir,
		ancestor: input.sha,
		descendant: input.tip,
		env: input.env,
		signal: input.signal,
	});
	if (ancestry !== "true") {
		return { outcome: "unknown", foreignTip: true };
	}
	if (input.tip === input.sha) {
		return { outcome: "observed", foreignTip: false };
	}
	const outside = await revListOutside({
		dir: input.dir,
		from: input.sha,
		to: input.tip,
		known: input.known,
		env: input.env,
		signal: input.signal,
	});
	return {
		outcome: "observed",
		foreignTip: outside.kind === "error" || outside.outside.length > 0,
	};
}

export type Reobserved = {
	operationId: string;
	snapshotId: string;
	/** The operation became `observed`. */
	observed: boolean;
	/** The reducer changed its proposal's lifecycle in the same transaction. */
	changed: boolean;
};

/**
 * Re-observation (spec §6.2 step 5, and the no-op guard of §6.4 step 5):
 * each given operation that is `unknown` or still issued is resolved once
 * more against the same fetched tip. Proven ancestry records `observed`
 * (audit `recovered: true`) and runs the reducer; `false` or `error` leaves
 * the operation as it is. Never writes `unknown` or `not_pushed`.
 */
export async function reobserveAgainstTip(
	input: GitCallBase & {
		dir: string;
		tip: string;
		known: ReadonlySet<string>;
		organizationId: string;
		ops: readonly BranchOperationRow[];
		foreignTip?: boolean;
	},
): Promise<Reobserved[]> {
	const results: Reobserved[] = [];
	for (const op of input.ops) {
		if (op.outcome !== null && op.outcome !== "unknown") {
			continue;
		}
		safeHeartbeat();
		const verdict = await verdictAgainstTip({
			dir: input.dir,
			sha: op.sha,
			tip: input.tip,
			known: input.known,
			env: input.env,
			signal: input.signal,
		});
		if (verdict.outcome !== "observed") {
			results.push({
				operationId: op.id,
				snapshotId: op.snapshotId,
				observed: false,
				changed: false,
			});
			continue;
		}
		const written = await recordOperationOutcome({
			operationId: op.id,
			organizationId: input.organizationId,
			outcome: "observed",
			foreignTip: verdict.foreignTip || input.foreignTip === true,
			audit: { actorUserId: null, recovered: true },
		});
		results.push({
			operationId: op.id,
			snapshotId: op.snapshotId,
			observed: written.applied,
			changed: written.reconcile.changed,
		});
	}
	return results;
}

/**
 * `recoverBranchOperation` (spec §6.2 steps 1-4): one issued operation,
 * resolved from the complete fetched history of the ref it pushed to and
 * written with `recordOperationOutcome` (audit `recovered: true`), whose
 * reducer then moves the proposal (an observed append OPEN, an observed
 * revert CANCELED, an unknown append BLOCKED PUSH_OUTCOME_UNKNOWN, an
 * unknown revert OPEN WITHDRAW_OUTCOME_UNKNOWN). An operation that already
 * has an outcome is reported as it stands. A fetch that fails throws; it is
 * never a verdict.
 */
export async function recoverOperation(i: {
	branchId: string;
	organizationId: string;
	operationId: string;
	signal: AbortSignal;
}): Promise<"observed" | "unknown" | "retry_later"> {
	const op = await getBranchOperation({
		operationId: i.operationId,
		organizationId: i.organizationId,
	});
	if (!op || op.branchId !== i.branchId) {
		return "retry_later";
	}
	if (op.outcome !== null) {
		return op.outcome === "acked" || op.outcome === "observed"
			? "observed"
			: "unknown";
	}
	const branch = await getProposalBranch({
		branchId: i.branchId,
		organizationId: i.organizationId,
	});
	if (!branch) {
		return "retry_later";
	}
	const ops = await listBranchOperations({
		branchId: i.branchId,
		organizationId: i.organizationId,
	});
	return withBranchRepoCredential(
		{ branch, phase: "recover", signal: i.signal },
		async (credential) => {
			const { env, signal } = credential;
			const dir = credential.workDir;
			const fetched = await gitCall("recover", credential, async () => {
				await initBranchWorkspace({
					url: credential.url,
					targetRef: credential.destination.targetRef,
					dir,
					env,
					signal,
				});
				safeHeartbeat();
				return fetchBranchHead({ dir, branch: op.ref, env, signal });
			});
			safeHeartbeat();
			const verdict = await gitCall("recover", credential, () =>
				verdictAgainstTip({
					dir,
					sha: op.sha,
					tip: fetched.kind === "present" ? fetched.sha : null,
					known: establishedShas(ops),
					env,
					signal,
				}),
			);
			await recordOperationOutcome({
				operationId: op.id,
				organizationId: i.organizationId,
				outcome: verdict.outcome,
				foreignTip: verdict.foreignTip,
				audit: { actorUserId: null, recovered: true },
			});
			return verdict.outcome;
		},
	);
}

/**
 * `reobserveProposalOperations` (spec §6.2 step 5): before any new issuance
 * for a proposal (Try again, withdraw-again), its `unknown` operations on
 * this branch are resolved once more. Each ref they pushed to is fetched
 * complete; proven ancestry records `observed`. `changed` when the reducer
 * changed the proposal's lifecycle.
 */
export async function reobserveProposal(i: {
	branchId: string;
	organizationId: string;
	snapshotId: string;
	signal: AbortSignal;
}): Promise<{ changed: boolean }> {
	const branch = await getProposalBranch({
		branchId: i.branchId,
		organizationId: i.organizationId,
	});
	if (!branch) {
		return { changed: false };
	}
	const ops = await listBranchOperations({
		branchId: i.branchId,
		organizationId: i.organizationId,
	});
	const targets = ops.filter(
		(op) => op.snapshotId === i.snapshotId && op.outcome === "unknown",
	);
	if (targets.length === 0) {
		return { changed: false };
	}
	return withBranchRepoCredential(
		{ branch, phase: "recover", signal: i.signal },
		async (credential) => {
			const { env, signal } = credential;
			const dir = credential.workDir;
			await gitCall("recover", credential, () =>
				initBranchWorkspace({
					url: credential.url,
					targetRef: credential.destination.targetRef,
					dir,
					env,
					signal,
				}),
			);
			let changed = false;
			for (const ref of new Set(targets.map((op) => op.ref))) {
				safeHeartbeat();
				const fetched = await gitCall("recover", credential, () =>
					fetchBranchHead({ dir, branch: ref, env, signal }),
				);
				if (fetched.kind !== "present") {
					continue;
				}
				const results = await gitCall("recover", credential, () =>
					reobserveAgainstTip({
						dir,
						tip: fetched.sha,
						known: establishedShas(ops),
						organizationId: i.organizationId,
						ops: targets.filter((op) => op.ref === ref),
						env,
						signal,
					}),
				);
				changed ||= results.some(
					(r) => r.snapshotId === i.snapshotId && r.changed,
				);
			}
			return { changed };
		},
	);
}
