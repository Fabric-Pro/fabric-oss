/**
 * What the proposal pull-request activities share (Fizzy #2563 spec §6.1,
 * §6.2, §11): reading the attempt records, turning a provider or git failure
 * into its typed code, one lookup by source branch, and the columns and audit
 * rows an adoption or a receipt writes.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import {
	applyPullRequestChange,
	getProposalOperation,
	type ProposalOperationRow,
	type PullRequestAttemptRecord,
	type PullRequestColumns,
	type PullRequestPhase,
	type RecordAuditInput,
} from "@repo/database";
import type { PullRequestContext } from "@repo/instructions";
import {
	InstructionPullRequestError,
	type PullRequestObservation,
} from "@repo/integrations/instruction-pull-requests";
import {
	asJson,
	assertMayContinue,
	ProposalStepFailure,
} from "./instruction-proposal-boundary";
import {
	isCredentialFailure,
	type ProposalCredential,
} from "./instruction-proposal-credential";
import { classifyGitFailure, GitCommandError } from "./instruction-sync-git";

type State = NonNullable<ProposalOperationRow["pullRequestState"]>;

const HOUR_MS = 60 * 60 * 1000;

/** The only namespace settlement ever deletes in (spec §2.8, §13.3). */
export const OPERATION_BRANCH_PREFIX = "fabric/instructions/";

export function recordsOf(
	row: Pick<ProposalOperationRow, "pullRequestAttempts">,
): PullRequestAttemptRecord[] {
	return Array.isArray(row.pullRequestAttempts)
		? (row.pullRequestAttempts as unknown as PullRequestAttemptRecord[])
		: [];
}

/** The operation's current branch: admission leaves the column empty until the first build. */
export function currentRefOf(
	row: Pick<ProposalOperationRow, "pullRequestRef">,
	context: Pick<PullRequestContext, "branch">,
): string {
	return row.pullRequestRef ?? context.branch;
}

/** The newest record on `ref`; a re-issue always takes a new ref, so there is at most one. */
export function recordOnRef(
	row: Pick<ProposalOperationRow, "pullRequestAttempts">,
	ref: string,
): PullRequestAttemptRecord | undefined {
	return recordsOf(row)
		.filter((r) => r.ref === ref)
		.at(-1);
}

export const identityOf = (r: PullRequestAttemptRecord) => ({
	attempt: r.attempt,
	ref: r.ref,
});

/** A settled record's next confirmation, 1 h then 24 h after `settledAt`, on the database clock. */
export function confirmationDue(
	r: PullRequestAttemptRecord,
	databaseNow: Date,
): boolean {
	if (!r.settledAt || r.confirmations >= 2) {
		return false;
	}
	const settled = Date.parse(r.settledAt);
	if (Number.isNaN(settled)) {
		return false;
	}
	return (
		databaseNow.getTime() >=
		settled + (r.confirmations === 0 ? HOUR_MS : 24 * HOUR_MS)
	);
}

/** The row again, with a fresh database clock; null once it is gone. */
export function reloadOperation(
	row: Pick<ProposalOperationRow, "id" | "projectId" | "organizationId">,
): Promise<ProposalOperationRow | null> {
	return getProposalOperation({
		snapshotId: row.id,
		projectId: row.projectId,
		organizationId: row.organizationId,
	});
}

/**
 * A provider failure as its typed code. An authentication failure is
 * rethrown as it is, for `withProposalRepoCredential`'s one re-exchange;
 * anything thrown after cancellation is rethrown for the boundary.
 */
function providerFailure(
	error: unknown,
	phase: PullRequestPhase,
	signal: AbortSignal,
): unknown {
	if (signal.aborted || isCredentialFailure(error)) {
		return error;
	}
	if (error instanceof InstructionPullRequestError) {
		return new ProposalStepFailure({
			code: error.code,
			phase,
			retryable: error.retryable,
			retryAfterSeconds: error.retryAfterSeconds,
		});
	}
	return error;
}

/**
 * One provider call under the attempt's signal. Nothing starts once the
 * attempt is cancelled or past its deadline; one in flight is aborted
 * through `target.signal`.
 */
export async function providerCall<T>(
	phase: PullRequestPhase,
	credential: Pick<ProposalCredential, "signal">,
	call: () => Promise<T>,
): Promise<T> {
	assertMayContinue(credential.signal);
	try {
		return await call();
	} catch (error) {
		throw providerFailure(error, phase, credential.signal);
	}
}

/**
 * A git failure as its typed code (spec §7 step 1, §11). Authentication and
 * cancellation are rethrown as they are; so is anything that is not a git
 * failure, which the boundary reports as `UNEXPECTED`.
 */
function gitFailure(
	error: unknown,
	phase: PullRequestPhase,
	signal: AbortSignal,
): unknown {
	if (
		signal.aborted ||
		isCredentialFailure(error) ||
		!(error instanceof GitCommandError)
	) {
		return error;
	}
	if (error.kind === "disk_limit") {
		return new ProposalStepFailure({
			code: "LIMITS_EXCEEDED",
			phase,
			retryable: phase === "recover" || phase === "close",
		});
	}
	if (error.kind === "exit") {
		const kind = classifyGitFailure(error.stderrTail);
		if (phase === "prepare" && kind === "ref_missing") {
			return new ProposalStepFailure({
				code: "TARGET_BRANCH_MISSING",
				phase,
				retryable: false,
			});
		}
		if (phase === "prepare" && kind === "commit_missing") {
			return new ProposalStepFailure({
				code: "BASE_COMMIT_UNAVAILABLE",
				phase,
				retryable: false,
			});
		}
		if (kind === "repo_not_found") {
			return new ProposalStepFailure({
				code: "REPOSITORY_UNAVAILABLE",
				phase,
				retryable: true,
			});
		}
	}
	return new ProposalStepFailure({
		code: "GIT_FAILED",
		phase,
		retryable: true,
	});
}

/** One git call under the attempt's signal; as `providerCall`. */
export async function gitCall<T>(
	phase: PullRequestPhase,
	credential: Pick<ProposalCredential, "signal">,
	call: () => Promise<T>,
): Promise<T> {
	assertMayContinue(credential.signal);
	try {
		return await call();
	} catch (error) {
		throw gitFailure(error, phase, credential.signal);
	}
}

type RefLookup =
	| { kind: "found"; observation: PullRequestObservation }
	| { kind: "absent" }
	| { kind: "inconclusive"; failure: ProposalStepFailure };

/** `findOperation` on one source branch (spec §10), its INCONCLUSIVE made a typed failure. */
export async function lookupRef(
	credential: ProposalCredential,
	ref: string,
	phase: PullRequestPhase,
): Promise<RefLookup> {
	const found = await providerCall(phase, credential, () =>
		credential.adapter.findOperation({
			...credential.target,
			sourceRef: ref,
		}),
	);
	if (found.kind === "FOUND") {
		return { kind: "found", observation: found.value };
	}
	if (found.kind === "ABSENT") {
		return { kind: "absent" };
	}
	if (found.cause === "auth") {
		throw new InstructionPullRequestError({
			code: "AUTHENTICATION_FAILED",
			retryable: true,
			cause: "auth",
		});
	}
	if (found.cause === "rate_limit") {
		return {
			kind: "inconclusive",
			failure: new ProposalStepFailure({
				code: "PROVIDER_RATE_LIMITED",
				phase,
				retryable: true,
				retryAfterSeconds: found.retryAfterSeconds,
			}),
		};
	}
	return {
		kind: "inconclusive",
		failure: new ProposalStepFailure({
			code:
				found.cause === "permission" || found.cause === "not_found"
					? "REPOSITORY_UNAVAILABLE"
					: "LOOKUP_INCONCLUSIVE",
			phase,
			retryable: true,
		}),
	};
}

function observationJson(
	observation: PullRequestObservation,
	context: Pick<PullRequestContext, "targetRef">,
) {
	return {
		targetRef: observation.targetRef,
		headSha: observation.headSha,
		mergedAt: observation.mergedAt ?? null,
		closedAt: observation.closedAt ?? null,
		mergeCommitSha: observation.mergeCommitSha ?? null,
		targetMismatch: observation.targetRef !== context.targetRef,
	};
}

/**
 * The receipt and observation columns an adoption, a receipt, an observed
 * change or a settlement writes (spec §4.4). A merge into the frozen target
 * requests the merge sync; one into another branch never does.
 */
export function observedColumns(
	row: Pick<ProposalOperationRow, "databaseNow">,
	observation: PullRequestObservation,
	context: Pick<PullRequestContext, "targetRef">,
	to: State | "unchanged",
): PullRequestColumns {
	return {
		pullRequestUrl: observation.url,
		pullRequestExternalId: observation.externalId,
		pullRequestObservation: asJson(observationJson(observation, context)),
		pullRequestLastCheckedAt: row.databaseNow,
		pullRequestFailure: null,
		pullRequestNextAttemptAt: null,
		...(to === "MERGED" && observation.targetRef === context.targetRef
			? { mergeSyncRequestedAt: row.databaseNow }
			: {}),
	};
}

function resourceOf(row: Pick<ProposalOperationRow, "id" | "version">) {
	return {
		type: "project_instruction_snapshot",
		id: row.id,
		name: `v${row.version}`,
	};
}

type AuditRow = Pick<
	ProposalOperationRow,
	"id" | "version" | "organizationId" | "projectId" | "userId"
> & { pullRequestOperationId: string | null };

/** `pull_request_opened` (spec §13.4): actor the proposer; no URL. */
function openedAudit(
	row: AuditRow,
	context: Pick<PullRequestContext, "provider">,
	observation: Pick<PullRequestObservation, "externalId">,
	adopted: boolean,
): RecordAuditInput {
	return {
		action: "project.instructions.pull_request_opened",
		category: "project",
		actor: { type: "user", userId: row.userId },
		organizationId: row.organizationId,
		projectId: row.projectId,
		resource: resourceOf(row),
		metadata: {
			provider: context.provider,
			version: row.version,
			operationId: row.pullRequestOperationId,
			externalId: observation.externalId,
			adopted,
		},
	};
}

/** `pull_request_reconciled` (spec §13.4): the system observed a terminal outcome. */
export function reconciledAudit(
	row: AuditRow,
	outcome: "merged" | "closed" | "canceled",
	targetMismatch: boolean,
	code?: string,
): RecordAuditInput {
	return {
		action: "project.instructions.pull_request_reconciled",
		category: "project",
		actor: { type: "system" },
		organizationId: row.organizationId,
		projectId: row.projectId,
		resource: resourceOf(row),
		metadata: {
			outcome,
			operationId: row.pullRequestOperationId,
			...(code === undefined ? {} : { code }),
			targetMismatch,
		},
	};
}

function terminalOutcome(
	state: State | "unchanged",
): "merged" | "closed" | "canceled" | null {
	if (state === "MERGED") {
		return "merged";
	}
	if (state === "CLOSED") {
		return "closed";
	}
	if (state === "CANCELED") {
		return "canceled";
	}
	return null;
}

/**
 * Adoption or a receipt (spec §4.4 "Recovery adoption", "Receipt
 * recorded"): the found pull request's facts, its record's create marker
 * cleared with outcome `opened`, `pull_request_opened` plus
 * `pull_request_reconciled` when it is already terminal, all in one
 * transaction. CLOSE_REQUESTED keeps its state and close closes it. False
 * when another actor moved the row first.
 */
export async function recordFound(
	row: ProposalOperationRow,
	context: PullRequestContext,
	observation: PullRequestObservation,
	o: {
		event: "adopt" | "receipt";
		from: State;
		expectedAttempt: number | null;
		adopted: boolean;
	},
): Promise<boolean> {
	const to: State | "unchanged" =
		o.from === "CLOSE_REQUESTED" ? "unchanged" : observation.state;
	const record = recordsOf(row)
		.filter((r) => r.ref === observation.sourceRef && !r.settledAt)
		.at(-1);
	const audit: RecordAuditInput[] = [
		openedAudit(row, context, observation, o.adopted),
	];
	const outcome = terminalOutcome(to);
	if (outcome) {
		audit.push(
			reconciledAudit(
				row,
				outcome,
				observation.targetRef !== context.targetRef,
			),
		);
	}
	const changed = await applyPullRequestChange({
		snapshotId: row.id,
		organizationId: row.organizationId,
		records: record
			? [
					{
						identity: identityOf(record),
						expect: {},
						patch: { outcome: "opened", createIssuedAt: null },
					},
				]
			: [],
		transition: {
			event: o.event,
			from: [o.from],
			expectedAttempt: o.expectedAttempt,
			to,
			bumpAttempt: false,
			data: observedColumns(row, observation, context, to),
			audit,
		},
	});
	return changed.ok;
}

/** What an operation row's state means to a caller that found it moved. */
export function movedKind(
	row: Pick<ProposalOperationRow, "pullRequestState"> | null,
): "open" | "terminal" | "close_requested" | "not_claimable" {
	switch (row?.pullRequestState) {
		case "OPEN":
			return "open";
		case "CLOSE_REQUESTED":
			return "close_requested";
		case "MERGED":
		case "CLOSED":
		case "CANCELED":
			return "terminal";
		default:
			return "not_claimable";
	}
}

export type { State as PullRequestStateName };
