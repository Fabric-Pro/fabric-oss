/**
 * Coding Instructions proposal pull-request activities (Fizzy #2563 spec §6,
 * §6.1, §6.2). The activities barrel re-exports this module, so EVERY export
 * here becomes a schedulable activity: helpers stay unexported or live in
 * ./lib.
 *
 * Authority (spec §13.2): recovery, adoption, settlement and close act under
 * the recorded tenant and integration only; the creation checks, re-read
 * before every new push or create, guard only those effects. Every write is
 * conditional (Task 5): a zero-row answer means another actor moved first,
 * and nothing after it runs.
 */
import {
	applyPullRequestChange,
	canCreateProjectInstructions,
	canReadProjectInstructions,
	claimPullRequestOpen,
	clearMergeSyncRequest,
	deferProposalOperation,
	findMergeTriggeredRun,
	getInstructionRepositorySyncForProposal,
	getProjectInstructionSettings,
	getProposalOperation,
	getSyncRunReceiptByRunId,
	type InstructionPullRequestFailureCode,
	listInstructionFiles,
	type MergeSyncTuple,
	markMergeSyncDispatched,
	type ProposalOperationRow,
	type PullRequestAttemptRecord,
	recordMergeSyncRun,
	selectDueProposalOperations,
	storePullRequestHeadSha,
	transitionPullRequest,
	writeAttemptRecord,
} from "@repo/database";
import {
	type PullRequestContext,
	pullRequestContextSchema,
} from "@repo/instructions";
import {
	instructionProposalPullRequestWorkflowId,
	instructionRepositorySyncWorkflowId,
} from "@repo/instructions/workflow-ids";
import {
	InstructionPullRequestError,
	type PullRequestObservation,
	repositoryIdentity,
	sameRepository,
} from "@repo/integrations/instruction-pull-requests";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { WorkflowExecutionAlreadyStartedError } from "@temporalio/client";
import { getTemporalClient } from "../client";
import type {
	CloseProposalInput,
	CloseProposalResult,
	DispatchProposalInput,
	DispatchProposalResult,
	DueProposalSweep,
	MergeSyncDispatchInput,
	MergeSyncDispatchResult,
	OpenProposalOperationInput,
	OpenProposalResult,
	ProposalOperationInput,
	ProposalReadinessInput,
	ProposalReadinessResult,
	ProposalSweepLimits,
	ReconcileProposalInput,
	ReconcileProposalResult,
	RecoverProposalInput,
	RecoverProposalResult,
} from "../lib/instruction-proposal-pull-request-types";
import {
	activityCancellationSignal,
	asJson,
	assertMayContinue,
	type BoundaryScope,
	cancellationOf,
	errorClassName,
	failureJson,
	nextAttemptAt,
	ProposalStepFailure,
	proposalActivityBoundary,
	recordProposalFailure,
	withProposalDeadline,
} from "./lib/instruction-proposal-boundary";
import {
	buildProposalCommit,
	computeEffectiveDelta,
	type FileRow,
} from "./lib/instruction-proposal-commit";
import {
	type ProposalCredential,
	withProposalRepoCredential,
} from "./lib/instruction-proposal-credential";
import {
	classifyMergeSyncReceipt,
	mergeSyncBackoffMs,
	mergeSyncDispatchesBefore,
} from "./lib/instruction-proposal-merge-sync";
import {
	currentRefOf,
	gitCall,
	identityOf,
	lookupRef,
	movedKind,
	observedColumns,
	providerCall,
	reconciledAudit,
	recordFound,
	recordOnRef,
	recordsOf,
	reloadOperation,
} from "./lib/instruction-proposal-operation";
import {
	abandonedPush,
	releaseAbandonedPush,
	runDueConfirmations,
	settleInstructionProposalBranch,
} from "./lib/instruction-proposal-settlement";
import { INSTRUCTIONS_BUCKET } from "./lib/instruction-prune";
import {
	assertOperationBranch,
	cloneTreeless,
	fetchPinnedCommit,
	GitCommandError,
	listTreeRaw,
	lsRemoteRef,
	MAX_INVENTORY_ENTRIES,
	pushCreateOnly,
	revParseHead,
} from "./lib/instruction-sync-git";
import { startAutomaticInstructionSync } from "./lib/instruction-sync-start";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** The operation workflow's queue (spec §6), as PR 1's snapshot workflows use. */
const PROJECT_INSTRUCTIONS_TASK_QUEUE = "project-instructions";
const DAY_MS = 24 * HOUR_MS;

type State = NonNullable<ProposalOperationRow["pullRequestState"]>;

function integrationIdOf(row: ProposalOperationRow): string | undefined {
	const context = row.pullRequestContext as {
		integrationId?: unknown;
	} | null;
	return typeof context?.integrationId === "string"
		? context.integrationId
		: undefined;
}

function failureCodeOf(
	row: ProposalOperationRow,
): InstructionPullRequestFailureCode | null {
	const failure = row.pullRequestFailure as { code?: unknown } | null;
	return typeof failure?.code === "string"
		? (failure.code as InstructionPullRequestFailureCode)
		: null;
}

const rateLimited = (
	row: ProposalOperationRow,
	failure: ProposalStepFailure,
	earlier?: string,
) =>
	failure.code === "PROVIDER_RATE_LIMITED" && integrationIdOf(row)
		? { rateLimitedIntegrationId: integrationIdOf(row) as string }
		: earlier
			? { rateLimitedIntegrationId: earlier }
			: {};

// ---------------------------------------------------------------------------
// Readiness (spec §6 step 1)
// ---------------------------------------------------------------------------

const STOP = { kind: "stop" } as const;

/** The abandonment reaper's rejection entry (`rejectAbandonedInstructionSnapshot`). */
function rejectedAsAbandoned(row: ProposalOperationRow): boolean {
	return (
		Array.isArray(row.rejection) &&
		row.rejection.some(
			(r) =>
				typeof r === "object" &&
				r !== null &&
				(r as { path?: unknown }).path === "(upload)" &&
				(r as { reason?: unknown }).reason === "abandoned",
		)
	);
}

/**
 * A REJECTED snapshot whose operation is still pre-create (spec §4.4
 * "Validation REJECTED" and "Abandonment"): the verdict's own transaction
 * cancels it (`cancelRepositoryProposalForVerdict`), so reaching this means
 * that write never happened. Left QUEUED, the sweeper's Restart sub-batch
 * would start this workflow for it on every tick and readiness would stop
 * every time, so readiness applies the same transition: `CANCELED`, attempt
 * + 1, `VALIDATION_REJECTED`, one `pull_request_reconciled` (canceled) row,
 * fenced on the attempt read here. Only a row nothing was pushed or created
 * on: a head SHA or an issued push or create belongs to settlement.
 */
async function cancelForRejectedSnapshot(
	row: ProposalOperationRow,
	state: "QUEUED" | "OPENING" | "BLOCKED",
): Promise<void> {
	if (
		row.pullRequestHeadSha !== null ||
		recordsOf(row).some((r) => r.pushIssuedAt || r.createIssuedAt)
	) {
		return;
	}
	const abandoned = rejectedAsAbandoned(row);
	const failure = new ProposalStepFailure({
		code: "VALIDATION_REJECTED",
		phase: "validation",
		retryable: false,
		...(abandoned ? { params: { reason: "abandoned" } } : {}),
	});
	await transitionPullRequest({
		snapshotId: row.id,
		organizationId: row.organizationId,
		event: abandoned ? "abandoned" : "validation_rejected",
		from: [state],
		expectedAttempt: row.pullRequestAttempt,
		to: "CANCELED",
		bumpAttempt: true,
		data: {
			pullRequestFailure: asJson(failureJson(failure)),
			pullRequestNextAttemptAt: null,
		},
		audit: reconciledAudit(row, "canceled", false, "VALIDATION_REJECTED"),
	});
}

/**
 * The snapshot's validation verdict for the workflow's readiness loop. READY
 * and PENDING is `ready` with the attempt read alongside it (plan Decision
 * 7); RECEIVING and VALIDATING are `pending`; FAILED is `pending` with
 * `VALIDATION_FAILED` recorded once (spec §4.4); REJECTED, a missing or
 * mismatched row and every state an open cannot start from are `stop`; a
 * REJECTED snapshot's still pre-create operation is canceled first
 * (`cancelForRejectedSnapshot`). With `deadlineReached`, a still-pending
 * QUEUED row is moved to BLOCKED (`VALIDATION_TIMEOUT`) and the answer is
 * `stop`.
 */
export const checkInstructionProposalReadiness = proposalActivityBoundary<
	ProposalReadinessInput,
	ProposalReadinessResult
>("validation", STOP, async (input) => {
	const row = await getProposalOperation(input);
	if (
		!row ||
		row.proposalDestination !== "REPOSITORY" ||
		row.pullRequestOperationId !== input.operationId
	) {
		return STOP;
	}
	const state = row.pullRequestState;
	if (state !== "QUEUED" && state !== "OPENING" && state !== "BLOCKED") {
		return STOP;
	}
	const fence = {
		snapshotId: row.id,
		organizationId: row.organizationId,
		expectedAttempt: row.pullRequestAttempt,
		bumpAttempt: false,
	} as const;
	if (row.status === "READY") {
		if (row.proposalStatus !== "PENDING") {
			return STOP;
		}
		if (state === "QUEUED" && failureCodeOf(row) === "VALIDATION_FAILED") {
			await transitionPullRequest({
				...fence,
				event: "validation_ready",
				from: ["QUEUED"],
				to: "unchanged",
				data: {
					pullRequestFailure: null,
					pullRequestNextAttemptAt: null,
				},
			});
		}
		return { kind: "ready", attempt: row.pullRequestAttempt };
	}
	if (row.status === "REJECTED") {
		await cancelForRejectedSnapshot(row, state);
		return STOP;
	}
	if (
		row.status !== "RECEIVING" &&
		row.status !== "VALIDATING" &&
		row.status !== "FAILED"
	) {
		return STOP;
	}
	const validationFailed = row.status === "FAILED";
	if (input.deadlineReached) {
		if (state === "QUEUED") {
			const timeout = new ProposalStepFailure({
				code: "VALIDATION_TIMEOUT",
				phase: "validation",
				retryable: true,
			});
			await transitionPullRequest({
				...fence,
				event: "deadline",
				from: ["QUEUED"],
				to: "BLOCKED",
				data: {
					pullRequestFailure: asJson(failureJson(timeout)),
					pullRequestNextAttemptAt: nextAttemptAt(row, timeout),
				},
			});
		}
		return STOP;
	}
	if (
		validationFailed &&
		state === "QUEUED" &&
		failureCodeOf(row) !== "VALIDATION_FAILED"
	) {
		const failed = new ProposalStepFailure({
			code: "VALIDATION_FAILED",
			phase: "validation",
			retryable: true,
		});
		await transitionPullRequest({
			...fence,
			event: "validation_failed",
			from: ["QUEUED"],
			to: "unchanged",
			data: {
				pullRequestFailure: asJson(failureJson(failed)),
				pullRequestNextAttemptAt: nextAttemptAt(row, failed),
			},
		});
	}
	return { kind: "pending", validationFailed };
});

// ---------------------------------------------------------------------------
// Recovery (spec §6.1 step 3), shared by open and recover
// ---------------------------------------------------------------------------

type Recovery =
	| { kind: "adopted"; to: State | "unchanged" }
	/** Nothing to adopt; `ownedSha` when the current ref is ours, acknowledged at its SHA. */
	| { kind: "continue"; ownedSha?: string }
	/** A conflict was recorded (the row is BLOCKED, or failure-only in recover). */
	| { kind: "blocked" }
	| { kind: "moved" };

/**
 * Spec §6.1 step 3, under recorded authority only. `attempt` fences every
 * write: the claimed attempt in open, the attempt read at load in recover.
 * Recover never re-points the branch (a re-issue takes `<branch>-<attempt>`
 * and only a claimed attempt is new), so it records a push outcome and
 * hands the row to Restart.
 */
async function recoverOperation(
	row: ProposalOperationRow,
	credential: ProposalCredential,
	o: { mode: "open" | "recover"; attempt: number; retryCreate: boolean },
): Promise<Recovery> {
	const { context } = credential;
	const phase = "recover" as const;
	const state = row.pullRequestState as State;

	const adopt = async (
		observation: PullRequestObservation,
	): Promise<Recovery> => {
		const adopted = await recordFound(row, context, observation, {
			event: "adopt",
			from: state,
			expectedAttempt: o.attempt,
			adopted: true,
		});
		return adopted
			? {
					kind: "adopted",
					to:
						state === "CLOSE_REQUESTED"
							? "unchanged"
							: observation.state,
				}
			: { kind: "moved" };
	};

	// (a) A recorded pull request.
	if (row.pullRequestExternalId) {
		const externalId = row.pullRequestExternalId;
		const observation = await providerCall(phase, credential, () =>
			credential.adapter.get({ ...credential.target, externalId }),
		);
		return adopt(observation);
	}

	// (b) Every record with a create marker, else the current record.
	const markers = recordsOf(row).filter(
		(r) => r.createIssuedAt && !r.settledAt,
	);
	const currentRef = currentRefOf(row, context);
	const refs =
		markers.length > 0
			? [...new Set(markers.map((r) => r.ref))]
			: [currentRef];
	let inconclusive: ProposalStepFailure | null = null;
	for (const ref of refs) {
		const found = await lookupRef(credential, ref, phase);
		if (found.kind === "found") {
			return adopt(found.observation);
		}
		if (found.kind === "inconclusive") {
			inconclusive ??= found.failure;
		}
	}
	if (markers.length > 0) {
		if (o.retryCreate && !inconclusive) {
			return retrySettlement();
		}
		if (inconclusive?.code === "PROVIDER_RATE_LIMITED") {
			throw inconclusive;
		}
		throw createOutcomeUnknown(row, markers);
	}
	if (inconclusive) {
		throw inconclusive;
	}
	if (o.retryCreate) {
		return retrySettlement();
	}

	// (c) Ownership of the current ref comes from its record alone.
	const record = recordOnRef(row, currentRef);
	const head = await gitCall(phase, credential, () =>
		lsRemoteRef({
			cwd: credential.runDir,
			url: credential.url,
			branch: currentRef,
			env: credential.env,
			signal: credential.signal,
		}),
	);
	const conflict = () =>
		new ProposalStepFailure({
			code: "REMOTE_REF_CONFLICT",
			phase,
			retryable: false,
		});
	if (!record || (!record.pushIssuedAt && !record.pushAckedAt)) {
		if (head.kind === "found") {
			throw conflict(); // no push issued, yet the ref exists
		}
		return { kind: "continue" };
	}
	if (record.pushAckedAt) {
		if (head.kind === "found" && head.sha === record.sha) {
			return { kind: "continue", ownedSha: record.sha };
		}
		throw conflict(); // acknowledged, then moved or removed
	}
	// Issued and never acknowledged: ownership is unknown whatever the tip.
	if (record.outcome === "conflict") {
		throw conflict();
	}
	if (record.outcome === "push_unknown_absent") {
		return o.mode === "open"
			? reissueAfterUnknownPush(record, false)
			: { kind: "continue" };
	}
	if (head.kind === "missing") {
		if (o.mode === "open") {
			return reissueAfterUnknownPush(record, true);
		}
		const written = await writeAttemptRecord({
			snapshotId: row.id,
			organizationId: row.organizationId,
			identity: identityOf(record),
			expect: { pushAckedAt: null, outcome: null },
			patch: { outcome: "push_unknown_absent" },
		});
		return written ? { kind: "continue" } : { kind: "moved" };
	}
	return recordUnknownPushConflict(record);

	async function retrySettlement(): Promise<Recovery> {
		const settled = await settleInstructionProposalBranch({
			mode: "retry",
			row,
			credential,
			attempt: o.attempt,
		});
		switch (settled.kind) {
			case "adopted":
				return { kind: "adopted", to: "OPEN" };
			case "reissued":
				return { kind: "continue" };
			case "blocked":
				return { kind: "blocked" };
			default:
				return { kind: "moved" };
		}
	}

	/** Ref absent after an unacknowledged push: a new record on `<branch>-<attempt>`, and the open continues there. */
	async function reissueAfterUnknownPush(
		record: PullRequestAttemptRecord,
		withOutcome: boolean,
	): Promise<Recovery> {
		const ref = `${context.branch}-${o.attempt}`;
		assertOperationBranch(ref);
		const changed = await applyPullRequestChange({
			snapshotId: row.id,
			organizationId: row.organizationId,
			records: [
				...(withOutcome
					? [
							{
								identity: identityOf(record),
								expect: { pushAckedAt: null, outcome: null },
								patch: {
									outcome: "push_unknown_absent" as const,
								},
							},
						]
					: []),
				{
					identity: { attempt: o.attempt, ref },
					expect: {},
					patch: { sha: row.pullRequestHeadSha ?? record.sha },
					row: { states: ["OPENING" as const], attempt: o.attempt },
					append: true,
				},
			],
			transition: {
				event: "push_unknown",
				from: ["OPENING"],
				expectedAttempt: o.attempt,
				to: "unchanged",
				bumpAttempt: false,
				data: { pullRequestRef: ref },
			},
		});
		return changed.ok ? { kind: "continue" } : { kind: "moved" };
	}

	/** Ref present after an unacknowledged push: outcome `conflict`, never deleted or created on. */
	async function recordUnknownPushConflict(
		record: PullRequestAttemptRecord,
	): Promise<Recovery> {
		const failure = conflict();
		const data = {
			pullRequestFailure: asJson(failureJson(failure)),
			pullRequestNextAttemptAt: nextAttemptAt(row, failure),
		};
		const changed = await applyPullRequestChange({
			snapshotId: row.id,
			organizationId: row.organizationId,
			records: [
				{
					identity: identityOf(record),
					expect: { pushAckedAt: null, outcome: null },
					patch: { outcome: "conflict" },
				},
			],
			transition:
				state === "OPENING"
					? {
							event: "push_unknown",
							from: ["OPENING"],
							expectedAttempt: o.attempt,
							to: "BLOCKED",
							bumpAttempt: false,
							data,
						}
					: {
							event: "failure",
							from: [state],
							expectedAttempt: o.attempt,
							to: "unchanged",
							bumpAttempt: false,
							data,
						},
		});
		return changed.ok ? { kind: "blocked" } : { kind: "moved" };
	}
}

/**
 * A create marker with no pull request found (spec §6.1): retryable with
 * the 1, 5, 15, 60 min then hourly backoff, counted in `params.recoveries`,
 * until 24 h after the oldest marker on the database clock.
 */
function createOutcomeUnknown(
	row: ProposalOperationRow,
	markers: PullRequestAttemptRecord[],
): ProposalStepFailure {
	const oldest = Math.min(
		...markers.map((r) => Date.parse(r.createIssuedAt as string)),
	);
	const markerAgeMs = Number.isNaN(oldest)
		? 0
		: row.databaseNow.getTime() - oldest;
	const failure = row.pullRequestFailure as {
		code?: unknown;
		params?: { recoveries?: unknown };
	} | null;
	const previous =
		failure?.code === "CREATE_OUTCOME_UNKNOWN" &&
		typeof failure.params?.recoveries === "number"
			? failure.params.recoveries
			: 0;
	const expired = markerAgeMs >= DAY_MS;
	return new ProposalStepFailure({
		code: "CREATE_OUTCOME_UNKNOWN",
		phase: "recover",
		retryable: !expired,
		markerAgeMs,
		recoveries: previous,
		params: { recoveries: previous + 1 },
		// No time bound clears the marker: after 24 h recovery still looks hourly.
		...(expired ? { nextAttemptDelayMs: HOUR_MS } : {}),
	});
}

// ---------------------------------------------------------------------------
// Open (spec §6.1)
// ---------------------------------------------------------------------------

type CreationCheck =
	| { kind: "ok"; row: ProposalOperationRow }
	| { kind: "moved"; row: ProposalOperationRow | null }
	| {
			kind: "refused";
			code:
				| "PERMISSION_REVOKED"
				| "CONFIGURATION_CHANGED"
				| "AUTHENTICATION_FAILED";
	  };

/**
 * The exhaustive guard of the creation check's status switch: `never` at
 * compile time, and a thrown error (the boundary's retryable UNEXPECTED) for
 * a value this code does not know yet.
 */
function unhandledIntegrationStatus(status: never): never {
	throw new Error(
		`Unhandled repository integration status: ${String(status)}`,
	);
}

/**
 * Spec §6.1 step 4, re-read on every call: before the build, immediately
 * before `pushCreateOnly`, and immediately before the marker that precedes
 * `adapter.open`. `moved` (the row is no longer OPENING at the claimed
 * attempt) writes nothing.
 */
async function checkCreationAuthority(
	input: OpenProposalOperationInput,
	attempt: number,
	context: PullRequestContext,
): Promise<CreationCheck> {
	const row = await getProposalOperation(input);
	if (
		!row ||
		row.pullRequestState !== "OPENING" ||
		row.pullRequestAttempt !== attempt
	) {
		return { kind: "moved", row };
	}
	if (
		row.proposalDestination !== "REPOSITORY" ||
		row.status !== "READY" ||
		row.proposalStatus !== "PENDING"
	) {
		return { kind: "refused", code: "CONFIGURATION_CHANGED" };
	}
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(
			row.projectId,
			row.organizationId,
		),
		getProjectInstructionSettings(row.projectId, row.organizationId),
	]);
	if (
		!sync ||
		settings.sourceOfTruth !== "REPOSITORY" ||
		sync.id !== context.syncId ||
		sync.generation !== context.syncGeneration ||
		sync.repositoryIntegrationId !== context.integrationId ||
		sync.ref !== context.targetRef ||
		sync.rootPath !== context.rootPath ||
		sync.repositoryIntegration.projectId !== row.projectId
	) {
		return { kind: "refused", code: "CONFIGURATION_CHANGED" };
	}
	// The integration's URL can be re-pointed under the same id and
	// generation, so the live URL must still name the frozen repository.
	const live = repositoryIdentity(
		sync.repositoryIntegration.provider,
		sync.repositoryIntegration.repositoryUrl,
	);
	if (live === null || !sameRepository(live, context.repository)) {
		return { kind: "refused", code: "CONFIGURATION_CHANGED" };
	}
	// Spec §6.1: creation requires an ACTIVE integration. TOKEN_EXPIRED is the
	// one status a reconnect fixes, so it is a retryable AUTHENTICATION_FAILED
	// and the card offers reconnect. REPO_UNAVAILABLE (the credential cannot
	// read this repository, which reconnecting does not change), ERROR and
	// DISCONNECTED are a changed configuration a human must resolve. The
	// switch is exhaustive: a new status fails the type-check here, and one a
	// newer database returns before this code knows it throws (UNEXPECTED,
	// retryable) rather than being read as any verdict.
	const status = sync.repositoryIntegration.status;
	switch (status) {
		case "ACTIVE":
			break;
		case "TOKEN_EXPIRED":
			return { kind: "refused", code: "AUTHENTICATION_FAILED" };
		case "REPO_UNAVAILABLE":
		case "ERROR":
		case "DISCONNECTED":
			return { kind: "refused", code: "CONFIGURATION_CHANGED" };
		default:
			return unhandledIntegrationStatus(status);
	}
	const allowed =
		(await canCreateProjectInstructions(row.projectId, row.userId)) ||
		(sync.allowReaderProposals &&
			(await canReadProjectInstructions(row.projectId, row.userId)));
	if (!allowed) {
		return { kind: "refused", code: "PERMISSION_REVOKED" };
	}
	return { kind: "ok", row };
}

const toFileRow = (r: {
	path: string;
	sha256: string;
	mode: number | null;
	storageKey: string;
}): FileRow => ({
	path: r.path,
	sha256: r.sha256,
	mode: r.mode,
	storageKey: r.storageKey,
});

/** Spec §6.1 step 5 and §7: build the frozen commit and store its SHA. */
async function buildAndStoreHeadSha(
	row: ProposalOperationRow,
	credential: ProposalCredential,
	attempt: number,
): Promise<{ kind: "sha"; sha: string } | { kind: "moved" }> {
	const { context, env, signal } = credential;
	const dir = credential.workDir;
	const listed = await gitCall("prepare", credential, async () => {
		await cloneTreeless({
			cwd: credential.runDir,
			url: credential.url,
			ref: context.targetRef,
			dir,
			env,
			signal,
		});
		await fetchPinnedCommit({
			dir,
			sha: context.baseCommitSha,
			env,
			signal,
		});
		if (
			(await revParseHead({ dir, env, signal })) !== context.baseCommitSha
		) {
			throw new GitCommandError("exit", 0, "", "rev-parse");
		}
		return listTreeRaw({
			dir,
			sha: context.baseCommitSha,
			rootPath: context.rootPath,
			maxEntries: MAX_INVENTORY_ENTRIES,
			env,
			signal,
		});
	});
	if (!listed.ok) {
		throw new ProposalStepFailure({
			code: "LIMITS_EXCEEDED",
			phase: "prepare",
			retryable: false,
		});
	}
	const [baseRows, proposalRows] = await Promise.all([
		row.baseSnapshotId
			? listInstructionFiles(row.baseSnapshotId, row.organizationId)
			: Promise.resolve([]),
		listInstructionFiles(row.id, row.organizationId),
	]);
	const storage = getStorageProvider();
	const built = await gitCall("prepare", credential, () =>
		buildProposalCommit({
			dir,
			env,
			signal,
			context,
			delta: computeEffectiveDelta(
				baseRows.map(toFileRow),
				proposalRows.map(toFileRow),
			),
			entries: listed.entries,
			readBytes: async (key) =>
				(
					await storage.downloadFile(key, {
						bucket: INSTRUCTIONS_BUCKET,
					})
				).data,
		}),
	);
	if (!built.ok) {
		throw new ProposalStepFailure({
			code: built.code,
			phase: "prepare",
			retryable: built.code === "STORAGE_FAILED",
		});
	}
	const stored = await storePullRequestHeadSha({
		snapshotId: row.id,
		organizationId: row.organizationId,
		attempt,
		sha: built.sha,
		ref: currentRefOf(row, context),
	});
	if (stored === "mismatch") {
		// A reproducible build never yields a second SHA.
		throw new ProposalStepFailure({
			code: "GIT_FAILED",
			phase: "prepare",
			retryable: false,
		});
	}
	return stored === "stored"
		? { kind: "sha", sha: built.sha }
		: { kind: "moved" };
}

/**
 * Spec §6.1 step 6: issue, push create-only, acknowledge. Only the push's
 * own success for exactly this ref writes `pushAckedAt`; a ref that exists,
 * even at our SHA, is a conflict with no deletion and no pull request.
 */
async function pushCurrentRecord(
	row: ProposalOperationRow,
	credential: ProposalCredential,
	attempt: number,
	sha: string,
): Promise<"created" | "blocked" | "moved"> {
	const ref = currentRefOf(row, credential.context);
	const existing = recordOnRef(row, ref);
	const identity = existing ? identityOf(existing) : { attempt, ref };
	const issuedAt = row.databaseNow.toISOString();
	const fence = {
		snapshotId: row.id,
		organizationId: row.organizationId,
		row: { states: ["OPENING" as const], attempt },
	};
	const issued = existing
		? !existing.pushIssuedAt &&
			(await writeAttemptRecord({
				...fence,
				identity,
				expect: { pushIssuedAt: null },
				patch: { sha, pushIssuedAt: issuedAt },
			}))
		: await writeAttemptRecord({
				...fence,
				identity,
				expect: {},
				patch: { sha, pushIssuedAt: issuedAt },
				append: true,
			});
	if (!issued) {
		return "moved";
	}
	const pushed = await gitCall("push", credential, () =>
		pushCreateOnly({
			dir: credential.workDir,
			sha,
			branch: ref,
			env: credential.env,
			signal: credential.signal,
		}),
	);
	const facts = { snapshotId: row.id, organizationId: row.organizationId };
	if (pushed.kind === "created") {
		await writeAttemptRecord({
			...facts,
			identity,
			expect: { pushAckedAt: null },
			patch: { pushAckedAt: new Date().toISOString() },
		});
		return "created";
	}
	if (pushed.kind === "refused") {
		// A definitive refusal left the ref untouched: the record is back
		// to not issued, so the next attempt pushes it again.
		await writeAttemptRecord({
			...facts,
			identity,
			expect: { pushAckedAt: null },
			patch: { pushIssuedAt: null },
		});
		throw new ProposalStepFailure({
			code: "BRANCH_WRITE_REFUSED",
			phase: "push",
			retryable: true,
		});
	}
	const failure = new ProposalStepFailure({
		code: "REMOTE_REF_CONFLICT",
		phase: "push",
		retryable: false,
	});
	const changed = await applyPullRequestChange({
		...facts,
		records: [
			{
				identity,
				expect: { pushAckedAt: null },
				patch: { outcome: "conflict" },
			},
		],
		transition: {
			event: "open_failure",
			from: ["OPENING"],
			expectedAttempt: attempt,
			to: "BLOCKED",
			bumpAttempt: false,
			data: {
				pullRequestFailure: asJson(failureJson(failure)),
				pullRequestNextAttemptAt: nextAttemptAt(row, failure),
			},
		},
	});
	return changed.ok ? "blocked" : "moved";
}

/** Spec §6.1 steps 7 and 8: the conditional marker, one `open`, the receipt. */
async function createAndRecord(
	row: ProposalOperationRow,
	credential: ProposalCredential,
	attempt: number,
): Promise<OpenProposalResult> {
	const { context } = credential;
	const ref = currentRefOf(row, context);
	const record = recordOnRef(row, ref);
	// The marker commits to exactly one `open`: none is written once the
	// attempt is cancelled or past its deadline.
	assertMayContinue(credential.signal);
	const marked =
		record !== undefined &&
		(await writeAttemptRecord({
			snapshotId: row.id,
			organizationId: row.organizationId,
			identity: identityOf(record),
			expect: { pushAckedAt: "set", createIssuedAt: null },
			patch: { createIssuedAt: row.databaseNow.toISOString() },
			row: { states: ["OPENING"], attempt },
		}));
	if (!marked) {
		return { kind: movedKind(await reloadOperation(row)) };
	}
	let observation: PullRequestObservation;
	let adopted = false;
	try {
		observation = await credential.adapter.open({
			...credential.target,
			sourceRef: ref,
			targetRef: context.targetRef,
			title: context.title,
			body: context.body,
		});
	} catch (error) {
		if (credential.signal.aborted) {
			throw error; // the marker stands; recovery reconciles
		}
		if (!(error instanceof InstructionPullRequestError)) {
			throw error;
		}
		if (!error.duplicate) {
			// The marker stands whatever the answer: only reconciliation or a
			// human retry follows, never a second automatic create.
			throw new ProposalStepFailure({
				code: error.code,
				phase: "create",
				retryable: error.retryable,
				retryAfterSeconds: error.retryAfterSeconds,
			});
		}
		const found = await lookupRef(credential, ref, "create");
		if (found.kind !== "found") {
			throw new ProposalStepFailure({
				code: "CREATE_OUTCOME_UNKNOWN",
				phase: "create",
				retryable: true,
				recoveries: 0,
				params: { recoveries: 0 },
			});
		}
		observation = found.observation;
		adopted = true;
	}
	const current = (await reloadOperation(row)) ?? row;
	if (
		await recordFound(current, context, observation, {
			event: "receipt",
			from: "OPENING",
			expectedAttempt: attempt,
			adopted,
		})
	) {
		return { kind: observation.state === "OPEN" ? "open" : "terminal" };
	}
	// A cancel landed while the create was in flight: record the facts on
	// CLOSE_REQUESTED, unfenced, and let close close it.
	const after = await reloadOperation(row);
	if (
		after?.pullRequestState === "CLOSE_REQUESTED" &&
		(await recordFound(after, context, observation, {
			event: "receipt",
			from: "CLOSE_REQUESTED",
			expectedAttempt: null,
			adopted,
		}))
	) {
		return { kind: "close_requested" };
	}
	return { kind: movedKind(after) };
}

async function openClaimed(
	input: OpenProposalOperationInput,
	loaded: ProposalOperationRow,
	credential: ProposalCredential,
	attempt: number,
	scope: BoundaryScope,
): Promise<OpenProposalResult> {
	// Every pass starts from the row as it stands (a re-exchange reruns this).
	const row = (await reloadOperation(loaded)) ?? loaded;
	if (
		row.pullRequestState !== "OPENING" ||
		row.pullRequestAttempt !== attempt
	) {
		return { kind: movedKind(row) };
	}
	scope.phase = "recover";
	const recovered = await recoverOperation(row, credential, {
		mode: "open",
		attempt,
		retryCreate: Boolean(input.retryCreate),
	});
	if (recovered.kind === "adopted") {
		return {
			kind:
				recovered.to === "unchanged"
					? "close_requested"
					: recovered.to === "OPEN"
						? "open"
						: "terminal",
		};
	}
	if (recovered.kind === "blocked") {
		return { kind: "blocked" };
	}
	if (recovered.kind === "moved") {
		return { kind: movedKind(await reloadOperation(row)) };
	}

	const gate = async (
		phase: "prepare" | "push" | "create",
	): Promise<
		| { ok: true; row: ProposalOperationRow }
		| { ok: false; result: OpenProposalResult }
	> => {
		scope.phase = phase;
		const check = await checkCreationAuthority(
			input,
			attempt,
			credential.context,
		);
		if (check.kind === "ok") {
			return { ok: true, row: check.row };
		}
		if (check.kind === "moved") {
			return { ok: false, result: { kind: movedKind(check.row) } };
		}
		const refusal = new ProposalStepFailure({
			code: check.code,
			phase,
			retryable: check.code === "AUTHENTICATION_FAILED",
		});
		if (refusal.retryable) {
			throw refusal;
		}
		return { ok: false, result: await refuseAndRelease(refusal) };
	};

	// A refusal a human must clear, after an acknowledged push, would leave
	// the branch without an owner: Recover (2) and Restart take only a
	// retryable BLOCKED row. BLOCKED is written first, so a release that
	// fails or dies at any step leaves exactly the row the Close sub-batch's
	// abandoned-push clause finishes; the release itself records nothing
	// over the refusal.
	const refuseAndRelease = async (
		refusal: ProposalStepFailure,
	): Promise<OpenProposalResult> => {
		const now = (await reloadOperation(row)) ?? row;
		if (
			!(await recordProposalFailure(now, refusal, {
				claimedAttempt: attempt,
			}))
		) {
			return { kind: movedKind(await reloadOperation(row)) };
		}
		try {
			const released = await releaseAbandonedPush({
				row: now,
				credential,
				phase: "recover",
			});
			if (released === "adopted") {
				return { kind: movedKind(await reloadOperation(row)) };
			}
		} catch (error) {
			const stopped = cancellationOf(error);
			if (stopped) {
				throw stopped;
			}
			logger.info(
				error instanceof ProposalStepFailure
					? {
							event: "instruction_proposal.branch_release_deferred",
							code: error.code,
						}
					: {
							event: "instruction_proposal.branch_release_deferred",
							code: "UNEXPECTED",
							errorClass: errorClassName(error),
						},
				"Instruction proposal branch release deferred to the sweeper",
			);
		}
		return { kind: "blocked" };
	};

	// Step 4, only now: nothing below runs without creation authority.
	let gated = await gate("prepare");
	if (!gated.ok) {
		return gated.result;
	}
	if (!recovered.ownedSha) {
		const built = await buildAndStoreHeadSha(
			gated.row,
			credential,
			attempt,
		);
		if (built.kind !== "sha") {
			return { kind: movedKind(await reloadOperation(row)) };
		}
		gated = await gate("push");
		if (!gated.ok) {
			return gated.result;
		}
		const pushed = await pushCurrentRecord(
			gated.row,
			credential,
			attempt,
			built.sha,
		);
		if (pushed === "blocked") {
			return { kind: "blocked" };
		}
		if (pushed === "moved") {
			return { kind: movedKind(await reloadOperation(row)) };
		}
	}
	gated = await gate("create");
	if (!gated.ok) {
		return gated.result;
	}
	return createAndRecord(gated.row, credential, attempt);
}

/**
 * Spec §6.1, in order: due confirmations (plan Decision 14), the claim at
 * the attempt readiness observed, recovery under recorded authority, then
 * the creation checks before each new effect, build, push and create. A
 * failure after the claim moves OPENING to BLOCKED at that attempt.
 */
export const openInstructionProposalPullRequest = proposalActivityBoundary<
	OpenProposalOperationInput,
	OpenProposalResult
>(
	"prepare",
	{ kind: "blocked" },
	async (input, scope): Promise<OpenProposalResult> => {
		const signal = activityCancellationSignal();
		const loaded = await getProposalOperation(input);
		if (!loaded || loaded.pullRequestOperationId !== input.operationId) {
			return { kind: "not_claimable" };
		}
		await runDueConfirmations(loaded, signal);
		assertMayContinue(signal);
		const claim = await claimPullRequestOpen({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
			expectedAttempt: input.expectedAttempt,
			retryCreate: input.retryCreate,
		});
		if (claim.kind !== "claimed") {
			return { kind: claim.kind };
		}
		scope.claimedAttempt = claim.attempt;
		const row = (await getProposalOperation(input)) ?? loaded;
		try {
			return await withProposalRepoCredential(
				{
					row,
					phase: "recover",
					unavailable: "AUTHENTICATION_FAILED",
					signal,
				},
				(credential) =>
					openClaimed(input, row, credential, claim.attempt, scope),
			);
		} catch (error) {
			if (
				!(error instanceof ProposalStepFailure) ||
				cancellationOf(error)
			) {
				throw error;
			}
			const now = (await getProposalOperation(input)) ?? row;
			if (
				await recordProposalFailure(now, error, {
					claimedAttempt: claim.attempt,
				})
			) {
				return { kind: "blocked" };
			}
			return { kind: movedKind(await getProposalOperation(input)) };
		}
	},
);

// ---------------------------------------------------------------------------
// Recover (spec §6.1 steps 2 and 3 only)
// ---------------------------------------------------------------------------

/**
 * The Recover sub-batch's action: due confirmations, then recovery. Never
 * builds, pushes, creates or settles. `absent_handoff` means nothing was
 * found and nothing blocks an open, so the sweeper runs Restart's action.
 */
export const recoverInstructionProposalPullRequest = proposalActivityBoundary<
	RecoverProposalInput,
	RecoverProposalResult
>("recover", { kind: "failed" }, async (input) => {
	const signal = activityCancellationSignal();
	const loaded = await getProposalOperation(input);
	if (!loaded || loaded.pullRequestOperationId !== input.operationId) {
		return { kind: "unchanged" };
	}
	const confirmed = await runDueConfirmations(loaded, signal);
	const earlier = confirmed.rateLimitedIntegrationId;
	const limited = earlier ? { rateLimitedIntegrationId: earlier } : {};
	const row = confirmed.row;
	const state = row.pullRequestState;
	if (state === "CLOSE_REQUESTED") {
		return { kind: "close_requested", ...limited };
	}
	if (
		(state !== "QUEUED" && state !== "OPENING" && state !== "BLOCKED") ||
		(input.expectedAttempt !== undefined &&
			row.pullRequestAttempt !== input.expectedAttempt)
	) {
		return { kind: "unchanged", ...limited };
	}
	try {
		const recovered = await withProposalRepoCredential(
			{
				row,
				phase: "recover",
				unavailable: "AUTHENTICATION_FAILED",
				signal,
			},
			(credential) =>
				recoverOperation(row, credential, {
					mode: "recover",
					attempt: row.pullRequestAttempt,
					retryCreate: false,
				}),
		);
		switch (recovered.kind) {
			case "adopted":
				return { kind: "adopted", ...limited };
			case "continue":
				return { kind: "absent_handoff", ...limited };
			case "blocked":
				return { kind: "blocked", ...limited };
			default:
				return { kind: "unchanged", ...limited };
		}
	} catch (error) {
		if (!(error instanceof ProposalStepFailure) || cancellationOf(error)) {
			throw error;
		}
		await recordRecoveryFailure(row, error);
		return { kind: "failed", ...rateLimited(row, error, earlier) };
	}
});

/** Failure-only, except the 24 h rule's move to BLOCKED (spec §4.4). */
async function recordRecoveryFailure(
	row: ProposalOperationRow,
	failure: ProposalStepFailure,
): Promise<void> {
	if (
		failure.code === "CREATE_OUTCOME_UNKNOWN" &&
		!failure.retryable &&
		(row.pullRequestState === "OPENING" ||
			row.pullRequestState === "BLOCKED")
	) {
		const expired = await transitionPullRequest({
			snapshotId: row.id,
			organizationId: row.organizationId,
			event: "create_unknown_expired",
			from: [row.pullRequestState],
			expectedAttempt: row.pullRequestAttempt,
			to: "BLOCKED",
			bumpAttempt: false,
			data: {
				pullRequestFailure: asJson(failureJson(failure)),
				pullRequestNextAttemptAt: nextAttemptAt(row, failure),
			},
		});
		if (expired.ok) {
			return;
		}
	}
	await recordProposalFailure(row, failure, {});
}

// ---------------------------------------------------------------------------
// Close (spec §6.2)
// ---------------------------------------------------------------------------

function settledKind(
	state: ProposalOperationRow["pullRequestState"],
): CloseProposalResult["kind"] {
	switch (state) {
		case "CLOSED":
			return "closed";
		case "CANCELED":
			return "canceled";
		case "MERGED":
			return "merged";
		default:
			return "pending";
	}
}

/**
 * Due confirmations, then, for a CLOSE_REQUESTED row, the close claim (a new
 * attempt) and settlement. Authorized once by the cancel procedure: it
 * checks only the row's tenant, the recorded integration and a resolvable
 * credential, never the requester's access. Every failure is failure-only
 * and the row stays CLOSE_REQUESTED. A BLOCKED row with an abandoned push
 * (`abandonedPush`), at the attempt the sweeper read, has that one branch
 * released instead (`releaseForClose`) and keeps its state and failure.
 */
export const closeInstructionProposalPullRequest = proposalActivityBoundary<
	CloseProposalInput,
	CloseProposalResult
>("close", { kind: "failed" }, async (input) => {
	const signal = activityCancellationSignal();
	const loaded = await getProposalOperation(input);
	if (!loaded || loaded.pullRequestOperationId !== input.operationId) {
		return { kind: "failed" };
	}
	const confirmed = await runDueConfirmations(loaded, signal);
	const earlier = confirmed.rateLimitedIntegrationId;
	const limited = earlier ? { rateLimitedIntegrationId: earlier } : {};
	if (
		abandonedPush(confirmed.row) &&
		(input.expectedAttempt === undefined ||
			confirmed.row.pullRequestAttempt === input.expectedAttempt)
	) {
		return releaseForClose(confirmed.row, signal, earlier);
	}
	if (confirmed.row.pullRequestState !== "CLOSE_REQUESTED") {
		return {
			kind: settledKind(confirmed.row.pullRequestState),
			...limited,
		};
	}
	assertMayContinue(signal);
	const claim = await transitionPullRequest({
		snapshotId: input.snapshotId,
		organizationId: input.organizationId,
		event: "claim",
		from: ["CLOSE_REQUESTED"],
		expectedAttempt:
			input.expectedAttempt ?? confirmed.row.pullRequestAttempt,
		to: "unchanged",
		bumpAttempt: true,
	});
	if (!claim.ok) {
		return { kind: "pending", ...limited };
	}
	const row = (await getProposalOperation(input)) ?? confirmed.row;
	if (row.pullRequestAttempt !== claim.attempt) {
		return { kind: settledKind(row.pullRequestState), ...limited };
	}
	try {
		const settled = await withProposalRepoCredential(
			{
				row,
				phase: "close",
				unavailable: "CLOSE_CREDENTIALS_UNAVAILABLE",
				signal,
			},
			(credential) =>
				settleInstructionProposalBranch({
					mode: "close",
					row,
					credential,
					attempt: claim.attempt,
				}),
		);
		switch (settled.kind) {
			case "merged":
			case "closed":
			case "canceled":
				return { kind: settled.kind, ...limited };
			default:
				return { kind: "pending", ...limited };
		}
	} catch (error) {
		if (!(error instanceof ProposalStepFailure) || cancellationOf(error)) {
			throw error;
		}
		// A cancel keeps looking: a failure a human must clear is revisited
		// every 6 h rather than every tick.
		const recorded = error.retryable
			? error
			: new ProposalStepFailure({
					code: error.code,
					phase: error.phase,
					retryable: false,
					params: error.params,
					nextAttemptDelayMs: error.nextAttemptDelayMs ?? 6 * HOUR_MS,
				});
		await recordProposalFailure(row, recorded, {});
		return { kind: "pending", ...rateLimited(row, error, earlier) };
	}
});

/**
 * Close's release of an abandoned push (`abandonedPush`), which the open
 * activity's own release did not finish. The row keeps its state and the
 * failure a human must see; a release that fails, however it fails short
 * of a stop, records nothing over it (the boundary's retryable UNEXPECTED
 * would hand the row to Recover and Restart) and only moves the row's next
 * look: by the delay a recorded failure of that code would take, UNEXPECTED's
 * for an untyped exception, or 6 h for one a retry cannot cure, so a release
 * that keeps failing never holds a Close slot every tick.
 */
async function releaseForClose(
	row: ProposalOperationRow,
	signal: AbortSignal,
	earlier: string | undefined,
): Promise<CloseProposalResult> {
	const limited = earlier ? { rateLimitedIntegrationId: earlier } : {};
	try {
		const released = await withProposalRepoCredential(
			{
				row,
				phase: "close",
				unavailable: "CLOSE_CREDENTIALS_UNAVAILABLE",
				signal,
			},
			(credential) =>
				releaseAbandonedPush({ row, credential, phase: "close" }),
		);
		if (released === "adopted") {
			return {
				kind: settledKind(
					(await reloadOperation(row))?.pullRequestState ?? null,
				),
				...limited,
			};
		}
		return { kind: "pending", ...limited };
	} catch (error) {
		const stopped = cancellationOf(error);
		if (stopped) {
			throw stopped;
		}
		const typed = error instanceof ProposalStepFailure ? error : null;
		if (!typed) {
			logger.warn(
				{
					event: "instruction_proposal.branch_release_failed",
					errorClass: errorClassName(error),
				},
				"Instruction proposal branch release failed unexpectedly",
			);
		}
		const at = nextAttemptAt(
			row,
			typed ?? { code: "UNEXPECTED", retryable: true },
		);
		const delayMs = at
			? at.getTime() - row.databaseNow.getTime()
			: 6 * HOUR_MS;
		// A stop is never swallowed here: none is checked for inside the
		// deferral write, so it is checked before and after it, and one the
		// write throws is rethrown before any failure of its own is logged.
		assertMayContinue(signal);
		try {
			await deferProposalOperation({
				snapshotId: row.id,
				organizationId: row.organizationId,
				attempt: row.pullRequestAttempt,
				minutes: Math.max(1, Math.ceil(delayMs / MINUTE_MS)),
			});
		} catch (deferError) {
			const deferStopped = cancellationOf(deferError);
			if (deferStopped) {
				throw deferStopped;
			}
			// Undeferred, the row is simply due again next tick.
			logger.warn(
				{
					event: "instruction_proposal.branch_release_defer_failed",
					errorClass: errorClassName(deferError),
				},
				"Instruction proposal branch release could not be deferred",
			);
		}
		assertMayContinue(signal);
		return {
			kind: "pending",
			...(typed ? rateLimited(row, typed, earlier) : limited),
		};
	}
}

// ---------------------------------------------------------------------------
// Observe (spec §6 table, §9 Observe)
// ---------------------------------------------------------------------------

/**
 * The Observe sub-batch's action: `get` the recorded pull request and write
 * what it says. OPEN stamps `pullRequestLastCheckedAt`; MERGED or CLOSED
 * moves the row (a merge into the frozen target requests the merge sync; one
 * into another branch is flagged `targetMismatch` and requests nothing). A
 * failure is failure-only and keeps the last confirmed state.
 */
export const reconcileInstructionProposalPullRequest = proposalActivityBoundary<
	ReconcileProposalInput,
	ReconcileProposalResult
>("reconcile", { kind: "failed" }, async (input) => {
	const signal = activityCancellationSignal();
	const loaded = await getProposalOperation(input);
	if (!loaded || loaded.pullRequestOperationId !== input.operationId) {
		return { kind: "unchanged" };
	}
	const confirmed = await runDueConfirmations(loaded, signal);
	const earlier = confirmed.rateLimitedIntegrationId;
	const limited = earlier ? { rateLimitedIntegrationId: earlier } : {};
	const row = confirmed.row;
	const externalId = row.pullRequestExternalId;
	if (
		row.pullRequestState !== "OPEN" ||
		!externalId ||
		(input.expectedAttempt !== undefined &&
			row.pullRequestAttempt !== input.expectedAttempt)
	) {
		return { kind: "unchanged", ...limited };
	}
	try {
		const { observation, context } = await withProposalRepoCredential(
			{
				row,
				phase: "reconcile",
				unavailable: "AUTHENTICATION_FAILED",
				signal,
			},
			async (credential) => ({
				context: credential.context,
				observation: await providerCall("reconcile", credential, () =>
					credential.adapter.get({
						...credential.target,
						externalId,
					}),
				),
			}),
		);
		const to =
			observation.state === "OPEN" ? "unchanged" : observation.state;
		const moved = await transitionPullRequest({
			snapshotId: row.id,
			organizationId: row.organizationId,
			event: "observe",
			from: ["OPEN"],
			expectedAttempt: row.pullRequestAttempt,
			to,
			bumpAttempt: false,
			data: observedColumns(row, observation, context, to),
			...(to === "unchanged"
				? {}
				: {
						audit: reconciledAudit(
							row,
							to === "MERGED" ? "merged" : "closed",
							observation.targetRef !== context.targetRef,
						),
					}),
		});
		if (!moved.ok) {
			return { kind: "unchanged", ...limited };
		}
		return {
			kind:
				to === "unchanged"
					? "open"
					: to === "MERGED"
						? "merged"
						: "closed",
			...limited,
		};
	} catch (error) {
		if (!(error instanceof ProposalStepFailure) || cancellationOf(error)) {
			throw error;
		}
		await recordProposalFailure(row, error, {});
		return { kind: "failed", ...rateLimited(row, error, earlier) };
	}
});

// ---------------------------------------------------------------------------
// Merge sync (spec §9.1)
// ---------------------------------------------------------------------------

function mergeSyncTupleOf(value: unknown): MergeSyncTuple | null {
	const v = value as { syncId?: unknown; generation?: unknown } | null;
	return typeof v?.syncId === "string" && typeof v.generation === "number"
		? { syncId: v.syncId, generation: v.generation }
		: null;
}

/**
 * Temporal client calls under the attempt's signal: a cancellation or the
 * deadline cancels one in flight (gRPC CANCELLED), and none starts after.
 */
async function withClientSignal<T>(
	fn: (client: Awaited<ReturnType<typeof getTemporalClient>>) => Promise<T>,
): Promise<T> {
	const signal = activityCancellationSignal();
	assertMayContinue(signal);
	const client = await getTemporalClient();
	return client.withAbortSignal(signal, () => fn(client));
}

/** Whether the sync workflow's run `runId` is still running; unknown counts as running. */
async function syncRunRunning(projectId: string, runId: string) {
	try {
		const description = await withClientSignal((client) =>
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

/**
 * Spec §9.1 steps 1 to 5 for one MERGED row with a merge-sync request: give
 * up after 24 h or when the destination changed; otherwise adopt the run it
 * dispatched (by Temporal run id, never by run key) or, after a crash
 * between the dispatch write and the starter's answer, the newest
 * merge-triggered run for the tuple it dispatched; acknowledge a consuming
 * receipt, wait on one in flight, and re-dispatch on a retaining receipt or
 * none, with the 5, 15, then 60 minute backoff.
 */
export const dispatchInstructionProposalMergeSync = proposalActivityBoundary<
	MergeSyncDispatchInput,
	MergeSyncDispatchResult
>("merge_sync", { kind: "failed" }, async (input) => {
	const row = await getProposalOperation(input);
	const requestedAt = row?.mergeSyncRequestedAt;
	if (
		!row ||
		!requestedAt ||
		row.pullRequestOperationId !== input.operationId ||
		row.pullRequestState !== "MERGED"
	) {
		return { kind: "idle" };
	}
	const ids = { snapshotId: row.id, organizationId: row.organizationId };
	const expected = mergeSyncTupleOf(row.mergeSyncExpected);
	const giveUp = async (
		code: "CONFIGURATION_CHANGED" | "MERGE_SYNC_FAILED",
	): Promise<MergeSyncDispatchResult> => {
		const cleared = await clearMergeSyncRequest({
			kind: "gave_up",
			...ids,
			expected,
			failure: {
				phase: "merge_sync",
				code,
				retryable: false,
				at: new Date().toISOString(),
				params: {},
			},
		});
		return { kind: cleared ? "gave_up" : "moved" };
	};
	const elapsed = row.databaseNow.getTime() - requestedAt.getTime();
	if (elapsed >= DAY_MS) {
		return giveUp("MERGE_SYNC_FAILED");
	}

	// Step 1: the destination, re-read; the CURRENT tuple is dispatched.
	const context = pullRequestContextSchema.safeParse(row.pullRequestContext);
	if (!context.success) {
		return giveUp("CONFIGURATION_CHANGED");
	}
	const [sync, settings] = await Promise.all([
		getInstructionRepositorySyncForProposal(
			row.projectId,
			row.organizationId,
		),
		getProjectInstructionSettings(row.projectId, row.organizationId),
	]);
	if (
		!sync ||
		settings.sourceOfTruth !== "REPOSITORY" ||
		sync.repositoryIntegrationId !== context.data.integrationId ||
		sync.ref !== context.data.targetRef ||
		sync.rootPath !== context.data.rootPath
	) {
		return giveUp("CONFIGURATION_CHANGED");
	}
	const current = { syncId: sync.id, generation: sync.generation };

	// Step 2: adopt what was dispatched.
	if (row.mergeSyncDispatchedAt && expected) {
		const receipt = row.mergeSyncRunId
			? await getSyncRunReceiptByRunId({
					projectId: row.projectId,
					organizationId: row.organizationId,
					runId: row.mergeSyncRunId,
				})
			: await findMergeTriggeredRun({
					projectId: row.projectId,
					organizationId: row.organizationId,
					syncId: expected.syncId,
					generation: expected.generation,
					startedAtOrAfter: requestedAt,
				});
		if (receipt) {
			const verdict = classifyMergeSyncReceipt(receipt, {
				projectId: row.projectId,
				syncId: expected.syncId,
				generation: expected.generation,
				requestedAt,
			});
			if (verdict === "wait") {
				return { kind: "waiting" };
			}
			if (verdict === "consuming") {
				const acknowledged = await clearMergeSyncRequest({
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
						organizationId: row.organizationId,
						projectId: row.projectId,
						resource: {
							type: "project_instruction_snapshot",
							id: row.id,
							name: `v${row.version}`,
						},
						metadata: {
							operationId: row.pullRequestOperationId,
							syncRunKey: receipt.id,
						},
					},
				});
				return { kind: acknowledged ? "acknowledged" : "moved" };
			}
		} else if (
			row.mergeSyncRunId &&
			(await syncRunRunning(row.projectId, row.mergeSyncRunId))
		) {
			return { kind: "waiting" }; // started, no receipt yet
		}
	}

	// Step 3: dispatch, after one conditional write. The mark commits to a
	// start, so none is written once the attempt must stop.
	const backoff = mergeSyncBackoffMs(mergeSyncDispatchesBefore(elapsed));
	const nextAttempt = new Date(row.databaseNow.getTime() + backoff);
	assertMayContinue();
	const marked = await markMergeSyncDispatched({
		...ids,
		lastExpected: expected,
		next: current,
		dispatchedAt: row.databaseNow,
		nextAttemptAt: nextAttempt,
	});
	if (!marked) {
		return { kind: "moved" };
	}
	let runId: string;
	try {
		({ runId } = await withClientSignal(() =>
			startAutomaticInstructionSync({
				projectId: row.projectId,
				organizationId: row.organizationId,
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
		await transitionPullRequest({
			...ids,
			event: "failure",
			from: ["MERGED"],
			expectedAttempt: row.pullRequestAttempt,
			to: "unchanged",
			bumpAttempt: false,
			data: {
				pullRequestFailure: asJson(failureJson(failed)),
				pullRequestNextAttemptAt: nextAttempt,
			},
		});
		return { kind: "failed" };
	}
	await recordMergeSyncRun({ ...ids, expected: current, runId });
	return { kind: "dispatched" };
});

// ---------------------------------------------------------------------------
// The sweeper's selection, restart and deferral (spec §9)
// ---------------------------------------------------------------------------

/** Whether an operation workflow is running; anything but a clear answer counts as running. */
async function operationWorkflowRunning(operationId: string): Promise<boolean> {
	try {
		const description = await withClientSignal((client) =>
			client.workflow
				.getHandle(
					instructionProposalPullRequestWorkflowId(operationId),
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

/**
 * The five sub-batches (Task 8), each item with a describe of its operation
 * workflow. Read-only; system-wide by design, returning ids and each row's
 * own tenant columns (spec §13.5).
 */
export async function selectDueInstructionProposalOperations(
	limits: ProposalSweepLimits,
): Promise<DueProposalSweep> {
	const due = await selectDueProposalOperations(limits);
	const described = (items: typeof due.close) =>
		Promise.all(
			items.map(async (item) => ({
				...item,
				running: await operationWorkflowRunning(item.operationId),
			})),
		);
	const [close, recover, mergeSync, observe, restart] = await Promise.all([
		described(due.close),
		described(due.recover),
		described(due.mergeSync),
		described(due.observe),
		described(due.restart),
	]);
	return { close, recover, mergeSync, observe, restart };
}

/**
 * Defers a row whose operation workflow is running by 30 minutes,
 * conditional on the attempt read at selection (spec §9).
 */
export async function deferInstructionProposalOperation(
	input: DispatchProposalInput,
): Promise<{ deferred: boolean }> {
	return {
		deferred: await deferProposalOperation({
			snapshotId: input.snapshotId,
			organizationId: input.organizationId,
			attempt: input.attempt,
			minutes: 30,
		}),
	};
}

/**
 * Restart's action: start the operation workflow unless one is running,
 * which defers the row instead. Sweeper starts carry no correlation memo
 * (R13): no request originated them. Runs under the attempt's deadline
 * (`deadlineAt`, its own timeouts): nothing is deferred or started once it
 * passes.
 */
export async function dispatchInstructionProposalPullRequest(
	input: DispatchProposalInput,
): Promise<DispatchProposalResult> {
	return withProposalDeadline(input, async () => {
		const running = await operationWorkflowRunning(input.operationId);
		assertMayContinue();
		if (running) {
			await deferInstructionProposalOperation(input);
			return { kind: "deferred" };
		}
		const args: [ProposalOperationInput] = [
			{
				snapshotId: input.snapshotId,
				projectId: input.projectId,
				organizationId: input.organizationId,
				operationId: input.operationId,
			},
		];
		try {
			await withClientSignal((client) =>
				client.workflow.start(
					"projectInstructionProposalPullRequestWorkflow",
					{
						taskQueue: PROJECT_INSTRUCTIONS_TASK_QUEUE,
						workflowId: instructionProposalPullRequestWorkflowId(
							input.operationId,
						),
						workflowIdConflictPolicy: "FAIL",
						args,
					},
				),
			);
			return { kind: "started" };
		} catch (error) {
			const stopped = cancellationOf(error);
			if (stopped) {
				throw stopped;
			}
			if (!(error instanceof WorkflowExecutionAlreadyStartedError)) {
				throw error;
			}
			assertMayContinue();
			await deferInstructionProposalOperation(input);
			return { kind: "already_running" };
		}
	});
}
