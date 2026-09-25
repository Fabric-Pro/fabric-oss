/**
 * Settlement and its confirmations (Fizzy #2563 spec §6.2): the §1
 * reconciliation policy applied record by record, under the recorded tenant
 * and integration credential only, never the requester's access.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	applyPullRequestChange,
	type ProposalOperationRow,
	type PullRequestAttemptRecord,
	type PullRequestPhase,
	writeAttemptRecord,
} from "@repo/database";
import type { PullRequestObservation } from "@repo/integrations/instruction-pull-requests";
import { logger } from "@repo/logs";
import {
	asJson,
	assertMayContinue,
	cancellationOf,
	failureJson,
	nextAttemptAt,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	type ProposalCredential,
	withProposalRepoCredential,
} from "./instruction-proposal-credential";
import {
	confirmationDue,
	gitCall,
	identityOf,
	lookupRef,
	OPERATION_BRANCH_PREFIX,
	observedColumns,
	type PullRequestStateName,
	providerCall,
	reconciledAudit,
	recordFound,
	recordsOf,
	reloadOperation,
} from "./instruction-proposal-operation";
import {
	assertOperationBranch,
	deleteBranch,
	lsRemoteRef,
} from "./instruction-sync-git";

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

type SettlementResult =
	/** Close mode: the row reached this terminal state. */
	| { kind: "merged" | "closed" | "canceled" }
	/** Retry mode: a pull request was found and adopted; the retry ends. */
	| { kind: "adopted" }
	/** Retry mode: nothing found and everything settled; the open continues on `ref`. */
	| { kind: "reissued"; ref: string }
	/** A branch Fabric cannot prove it owns is still there (REMOTE_REF_CONFLICT recorded). */
	| { kind: "blocked" }
	/** Another actor moved the row first; nothing more was written. */
	| { kind: "moved" };

/** A record that may have left something on the remote. */
const pushed = (r: PullRequestAttemptRecord) =>
	Boolean(r.pushIssuedAt || r.pushAckedAt);

/**
 * Spec §6.2 steps 1 to 3. `attempt` is the attempt the caller claimed:
 * close's `claim`, or the retry's open claim. Close mode ends CLOSED when a
 * pull request was closed, CANCELED when none existed, MERGED when one was
 * merged; retry mode adopts anything it finds, and only when it finds
 * nothing appends the re-issue's record on `<branch>-<attempt>`. Failures
 * throw `ProposalStepFailure` for the caller to record (failure-only in
 * close, OPENING to BLOCKED in retry).
 */
export async function settleInstructionProposalBranch(i: {
	mode: "close" | "retry";
	row: ProposalOperationRow;
	credential: ProposalCredential;
	attempt: number;
}): Promise<SettlementResult> {
	const { mode, credential, attempt } = i;
	const { context, signal } = credential;
	const phase: PullRequestPhase = mode === "close" ? "close" : "recover";
	const from: PullRequestStateName =
		mode === "close" ? "CLOSE_REQUESTED" : "OPENING";
	let row = i.row;
	let closed: PullRequestObservation | null = null;

	const reload = async () => {
		const next = await reloadOperation(row);
		if (!next) {
			return false;
		}
		row = next;
		return (
			row.pullRequestState === from && row.pullRequestAttempt === attempt
		);
	};

	/** Close mode's terminal write: every unsettled record settled, one audit row. */
	const settle = async (
		to: "MERGED" | "CLOSED" | "CANCELED",
		observation: PullRequestObservation | null,
	): Promise<SettlementResult> => {
		if (!(await reload())) {
			return { kind: "moved" };
		}
		const now = row.databaseNow.toISOString();
		const changed = await applyPullRequestChange({
			snapshotId: row.id,
			organizationId: row.organizationId,
			records: recordsOf(row)
				.filter((r) => !r.settledAt)
				.map((r) => ({
					identity: identityOf(r),
					expect: { settledAt: null },
					patch: {
						settledAt: now,
						confirmations: 0,
						outcome: "settled",
					},
				})),
			transition: {
				event: "settled",
				from: ["CLOSE_REQUESTED"],
				expectedAttempt: attempt,
				to,
				bumpAttempt: false,
				data: observation
					? observedColumns(row, observation, context, to)
					: {
							pullRequestFailure: null,
							pullRequestNextAttemptAt: null,
						},
				audit: reconciledAudit(
					row,
					to === "MERGED"
						? "merged"
						: to === "CLOSED"
							? "closed"
							: "canceled",
					observation !== null &&
						observation.targetRef !== context.targetRef,
				),
			},
		});
		if (!changed.ok) {
			return { kind: "moved" };
		}
		return {
			kind:
				to === "MERGED"
					? "merged"
					: to === "CLOSED"
						? "closed"
						: "canceled",
		};
	};

	/** Steps 1 and 3: look up every pushed or marked ref, then close or adopt. */
	const lookUpAndAct = async (): Promise<SettlementResult | null> => {
		if (!(await reload())) {
			return { kind: "moved" };
		}
		const seen = new Map<string, PullRequestObservation>();
		if (row.pullRequestExternalId) {
			const externalId = row.pullRequestExternalId;
			const got = await providerCall(phase, credential, () =>
				credential.adapter.get({ ...credential.target, externalId }),
			);
			seen.set(got.externalId, got);
		}
		for (const r of recordsOf(row)) {
			if (r.settledAt || !(pushed(r) || r.createIssuedAt)) {
				continue;
			}
			const found = await lookupRef(credential, r.ref, phase);
			if (found.kind === "inconclusive") {
				throw found.failure;
			}
			if (found.kind === "found") {
				seen.set(found.observation.externalId, found.observation);
			}
		}
		for (const observation of seen.values()) {
			if (mode === "retry") {
				const adopted = await recordFound(row, context, observation, {
					event: "adopt",
					from: "OPENING",
					expectedAttempt: attempt,
					adopted: true,
				});
				return { kind: adopted ? "adopted" : "moved" };
			}
			if (observation.state === "MERGED") {
				return settle("MERGED", observation); // MERGED wins; no deletion
			}
			if (observation.state === "OPEN") {
				const after = await providerCall(phase, credential, () =>
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

	/** Step 2: delete only an acknowledged record's branch, only at its SHA. */
	const deleteOwned = async (): Promise<{
		conflicts: PullRequestAttemptRecord[];
		activePullRequest: boolean;
	}> => {
		const conflicts: PullRequestAttemptRecord[] = [];
		let activePullRequest = false;
		for (const r of recordsOf(row)) {
			if (r.settledAt || !pushed(r)) {
				continue; // nothing of ours reached the remote
			}
			if (!r.ref.startsWith(OPERATION_BRANCH_PREFIX)) {
				conflicts.push(r);
				continue;
			}
			const head = await gitCall(phase, credential, () =>
				lsRemoteRef({
					cwd: credential.runDir,
					url: credential.url,
					branch: r.ref,
					env: credential.env,
					signal,
				}),
			);
			if (head.kind === "missing") {
				continue;
			}
			if (!r.pushAckedAt || head.sha !== r.sha) {
				// Unknown ownership, or a tip Fabric did not write: never deleted.
				conflicts.push(r);
				continue;
			}
			const deleted = await gitCall(phase, credential, () =>
				deleteBranch({
					cwd: credential.runDir,
					url: credential.url,
					branch: r.ref,
					sha: r.sha,
					env: credential.env,
					signal,
				}),
			);
			if (deleted.kind === "stale") {
				conflicts.push(r);
			} else if (deleted.kind === "refused") {
				if (!deleted.activePullRequest) {
					throw new ProposalStepFailure({
						code: "BRANCH_WRITE_REFUSED",
						phase,
						retryable: true,
					});
				}
				activePullRequest = true;
			}
		}
		return { conflicts, activePullRequest };
	};

	let outcome = await lookUpAndAct();
	if (outcome) {
		return outcome;
	}
	let deletion = await deleteOwned();
	if (deletion.activePullRequest) {
		// Azure DevOps refuses to delete a branch an active pull request
		// uses: close it (step 1) and delete once more.
		outcome = await lookUpAndAct();
		if (outcome) {
			return outcome;
		}
		deletion = await deleteOwned();
		if (deletion.activePullRequest) {
			throw new ProposalStepFailure({
				code: "BRANCH_WRITE_REFUSED",
				phase,
				retryable: true,
			});
		}
	}
	// Step 3: a create that landed between the lookup and the deletion.
	outcome = await lookUpAndAct();
	if (outcome) {
		return outcome;
	}
	if (deletion.conflicts.length > 0) {
		return recordConflicts(deletion.conflicts);
	}
	if (mode === "close") {
		return settle(closed ? "CLOSED" : "CANCELED", closed);
	}
	return reissue();

	async function recordConflicts(
		conflicts: PullRequestAttemptRecord[],
	): Promise<SettlementResult> {
		if (!(await reload())) {
			return { kind: "moved" };
		}
		const failure = new ProposalStepFailure({
			code: "REMOTE_REF_CONFLICT",
			phase,
			retryable: false,
			// A cancel keeps looking every 6 h; a retry waits for a human.
			...(mode === "close" ? { nextAttemptDelayMs: SIX_HOURS_MS } : {}),
		});
		const changed = await applyPullRequestChange({
			snapshotId: row.id,
			organizationId: row.organizationId,
			records: conflicts
				.filter((r) => r.outcome !== "conflict")
				.map((r) => ({
					identity: identityOf(r),
					expect: { settledAt: null },
					patch: { outcome: "conflict" },
				})),
			transition: {
				event: "settle_blocked",
				from: [from],
				expectedAttempt: attempt,
				to: mode === "close" ? "unchanged" : "BLOCKED",
				bumpAttempt: false,
				data: {
					pullRequestFailure: asJson(failureJson(failure)),
					pullRequestNextAttemptAt: nextAttemptAt(row, failure),
				},
			},
		});
		return { kind: changed.ok ? "blocked" : "moved" };
	}

	async function reissue(): Promise<SettlementResult> {
		if (!(await reload())) {
			return { kind: "moved" };
		}
		const ref = `${context.branch}-${attempt}`;
		assertOperationBranch(ref);
		const now = row.databaseNow.toISOString();
		const settled = recordsOf(row)
			.filter((r) => !r.settledAt)
			.map((r) => ({
				identity: identityOf(r),
				expect: { settledAt: null } as const,
				patch: {
					settledAt: now,
					confirmations: 0,
					outcome: "settled" as const,
				},
			}));
		const headSha = row.pullRequestHeadSha;
		const changed = await applyPullRequestChange({
			snapshotId: row.id,
			organizationId: row.organizationId,
			records: [
				...settled,
				// The re-issue's record; without a stored SHA (nothing was
				// ever built) the push appends it.
				...(headSha
					? [
							{
								identity: { attempt, ref },
								expect: {},
								patch: { sha: headSha },
								row: { states: ["OPENING" as const], attempt },
								append: true,
							},
						]
					: []),
			],
			transition: {
				event: "reissue",
				from: ["OPENING"],
				expectedAttempt: attempt,
				to: "unchanged",
				bumpAttempt: false,
				data: { pullRequestRef: ref },
			},
		});
		return changed.ok ? { kind: "reissued", ref } : { kind: "moved" };
	}
}

/**
 * The current record of a BLOCKED row that no step will ever settle: its
 * push was acknowledged, then a failure a human must clear stopped the
 * open before any create marker. Recover (2) and Restart take only a
 * retryable BLOCKED row, and no human retry may come (a revoked proposer
 * cannot retry), so without a release the pushed branch has no owner. Null
 * unless the row has no pull request and no outstanding marker, and its
 * current record (`pullRequestRef`) is acknowledged, unsettled, unmarked
 * and has no outcome. The Close sub-batch's abandoned-push clause selects
 * exactly these rows.
 */
export function abandonedPush(
	row: Pick<
		ProposalOperationRow,
		| "pullRequestState"
		| "pullRequestFailure"
		| "pullRequestExternalId"
		| "pullRequestRef"
		| "pullRequestAttempts"
	>,
): PullRequestAttemptRecord | null {
	const failure = row.pullRequestFailure as { retryable?: unknown } | null;
	if (
		row.pullRequestState !== "BLOCKED" ||
		failure?.retryable !== false ||
		row.pullRequestExternalId ||
		!row.pullRequestRef ||
		recordsOf(row).some((r) => r.createIssuedAt && !r.settledAt)
	) {
		return null;
	}
	const record = recordsOf(row)
		.filter((r) => r.ref === row.pullRequestRef)
		.at(-1);
	if (
		!record?.pushAckedAt ||
		record.settledAt ||
		record.createIssuedAt ||
		record.outcome
	) {
		return null;
	}
	return record;
}

/**
 * Releases an abandoned push (`abandonedPush`) under the recorded
 * credential, as settlement treats one record: the source ref is looked up
 * first and a pull request found on it is adopted, as recovery adopts one
 * (spec §6.1 step 3); otherwise only the acknowledged SHA is deleted, only
 * under the operation namespace, and the record is settled, which schedules
 * its 1 h and 24 h confirmations. A tip Fabric did not write is never
 * deleted: the record takes outcome `conflict`. The row keeps its state and
 * the failure a human must see; every write is fenced on BLOCKED at the
 * attempt read here, so a human retry or cancel that lands first wins.
 * Idempotent: a branch already gone is settled as released. Failures throw
 * `ProposalStepFailure` for the caller, which records none of them.
 */
export async function releaseAbandonedPush(i: {
	row: ProposalOperationRow;
	credential: ProposalCredential;
	phase: PullRequestPhase;
}): Promise<"released" | "adopted" | "conflict" | "moved" | "none"> {
	const { credential, phase } = i;
	const { context, signal } = credential;
	const row = (await reloadOperation(i.row)) ?? i.row;
	const record = abandonedPush(row);
	if (!record) {
		return "none";
	}
	const attempt = row.pullRequestAttempt;
	const found = await lookupRef(credential, record.ref, phase);
	if (found.kind === "inconclusive") {
		throw found.failure;
	}
	if (found.kind === "found") {
		const adopted = await recordFound(row, context, found.observation, {
			event: "adopt",
			from: "BLOCKED",
			expectedAttempt: attempt,
			adopted: true,
		});
		return adopted ? "adopted" : "moved";
	}
	let conflict = !record.ref.startsWith(OPERATION_BRANCH_PREFIX);
	if (!conflict) {
		const head = await gitCall(phase, credential, () =>
			lsRemoteRef({
				cwd: credential.runDir,
				url: credential.url,
				branch: record.ref,
				env: credential.env,
				signal,
			}),
		);
		if (head.kind === "found" && head.sha !== record.sha) {
			conflict = true;
		} else if (head.kind === "found") {
			const deleted = await gitCall(phase, credential, () =>
				deleteBranch({
					cwd: credential.runDir,
					url: credential.url,
					branch: record.ref,
					sha: record.sha,
					env: credential.env,
					signal,
				}),
			);
			if (deleted.kind === "stale") {
				conflict = true;
			} else if (deleted.kind === "refused") {
				// Retried later. On Azure DevOps an active pull request that
				// uses the branch refuses it; the next release adopts that one.
				throw new ProposalStepFailure({
					code: "BRANCH_WRITE_REFUSED",
					phase,
					retryable: true,
				});
			}
		}
	}
	const now = (await reloadOperation(row)) ?? row;
	const written = await writeAttemptRecord({
		snapshotId: row.id,
		organizationId: row.organizationId,
		identity: identityOf(record),
		expect: {
			pushAckedAt: "set",
			createIssuedAt: null,
			settledAt: null,
			outcome: null,
		},
		patch: conflict
			? { outcome: "conflict" }
			: {
					settledAt: now.databaseNow.toISOString(),
					confirmations: 0,
					outcome: "settled",
				},
		row: { states: ["BLOCKED"], attempt },
	});
	if (!written) {
		return "moved";
	}
	return conflict ? "conflict" : "released";
}

/**
 * Spec §6.2 step 4, run first by every activity that takes a row (plan
 * Decision 14): for each record whose 1 h or 24 h confirmation is due on the
 * database clock, look up its ref and close any open pull request other than
 * the adopted one; a cancelled row becomes CLOSED, or MERGED when one merged.
 * Each confirmation is conditional on that record's identity and count only,
 * never on the row's attempt, and touches no other record; the second
 * clears the record's create marker. A lookup that fails leaves the record
 * due for the next tick and writes nothing else. Returns the row as it now
 * stands and the integration a provider rate-limited, if one did.
 */
export async function runDueConfirmations(
	row: ProposalOperationRow,
	signal: AbortSignal,
): Promise<{ row: ProposalOperationRow; rateLimitedIntegrationId?: string }> {
	if (
		row.pullRequestState === null ||
		!recordsOf(row).some((r) => confirmationDue(r, row.databaseNow))
	) {
		// The caller's row read may itself have crossed the deadline; its
		// next step is a claim write that must not start past it.
		assertMayContinue(signal);
		return { row };
	}
	let rateLimitedIntegrationId: string | undefined;
	try {
		await withProposalRepoCredential(
			{
				row,
				phase: "close",
				unavailable: "CLOSE_CREDENTIALS_UNAVAILABLE",
				signal,
			},
			async (credential) => {
				const due = recordsOf(row).filter((r) =>
					confirmationDue(r, row.databaseNow),
				);
				for (const r of due) {
					try {
						await confirmRecord(row, credential, r);
					} catch (error) {
						// A stop is rethrown before any failure is read: a
						// cancelled or expired attempt is never a deferral.
						const stopped = cancellationOf(error);
						if (stopped) {
							throw stopped;
						}
						if (!(error instanceof ProposalStepFailure)) {
							throw error;
						}
						if (error.code === "PROVIDER_RATE_LIMITED") {
							rateLimitedIntegrationId = credential.integrationId;
							return;
						}
						logger.info(
							{
								event: "instruction_proposal.confirmation_deferred",
								code: error.code,
							},
							"Instruction proposal confirmation deferred",
						);
					}
				}
			},
		);
	} catch (error) {
		const stopped = cancellationOf(error);
		if (stopped) {
			throw stopped;
		}
		if (!(error instanceof ProposalStepFailure)) {
			throw error;
		}
		logger.info(
			{
				event: "instruction_proposal.confirmation_deferred",
				code: error.code,
			},
			"Instruction proposal confirmation deferred",
		);
	}
	const after = await reloadOperation(row);
	// Every caller's next step is a claim or a transition: none once the
	// attempt must stop.
	assertMayContinue(signal);
	return {
		row: after ?? row,
		...(rateLimitedIntegrationId ? { rateLimitedIntegrationId } : {}),
	};
}

async function confirmRecord(
	loaded: ProposalOperationRow,
	credential: ProposalCredential,
	due: PullRequestAttemptRecord,
): Promise<void> {
	const row = (await reloadOperation(loaded)) ?? loaded;
	const record = recordsOf(row).find(
		(r) => r.attempt === due.attempt && r.ref === due.ref,
	);
	if (
		!record ||
		!record.settledAt ||
		record.confirmations !== due.confirmations
	) {
		return; // another confirmer counted it first
	}
	const found = await lookupRef(credential, record.ref, "close");
	if (found.kind === "inconclusive") {
		throw found.failure;
	}
	// A pull request other than the adopted one: close it if open. Only a
	// cancelled row changes state, to CLOSED for one Fabric closed here or
	// MERGED for one that merged; an adopted row keeps its own.
	let observation: PullRequestObservation | null = null;
	let to: "unchanged" | "CLOSED" | "MERGED" = "unchanged";
	if (
		found.kind === "found" &&
		found.observation.externalId !== row.pullRequestExternalId
	) {
		observation = found.observation;
		let closedHere = false;
		if (observation.state === "OPEN") {
			const externalId = observation.externalId;
			observation = await providerCall("close", credential, () =>
				credential.adapter.close({ ...credential.target, externalId }),
			);
			closedHere = true;
		}
		if (row.pullRequestState === "CANCELED") {
			if (observation.state === "MERGED") {
				to = "MERGED";
			} else if (closedHere) {
				to = "CLOSED";
			}
		}
	}
	const count = record.confirmations + 1;
	const changed = await applyPullRequestChange({
		snapshotId: row.id,
		organizationId: row.organizationId,
		records: [
			{
				identity: identityOf(record),
				expect: {
					settledAt: "set",
					confirmations: record.confirmations,
				},
				patch: {
					confirmations: count,
					...(count >= 2 ? { createIssuedAt: null } : {}),
				},
			},
		],
		...(to === "unchanged" || observation === null
			? {}
			: {
					transition: {
						event: "confirmation" as const,
						from: ["CANCELED" as const],
						expectedAttempt: null,
						to,
						bumpAttempt: false,
						data: observedColumns(
							row,
							observation,
							credential.context,
							to,
						),
						audit: reconciledAudit(
							row,
							to === "MERGED" ? "merged" : "closed",
							observation.targetRef !==
								credential.context.targetRef,
						),
					},
				}),
	});
	if (!changed.ok) {
		logger.info(
			{ event: "instruction_proposal.confirmation_raced" },
			"Instruction proposal confirmation lost a race",
		);
	}
}
