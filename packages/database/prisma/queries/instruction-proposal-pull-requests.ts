/**
 * Coding Instructions proposal pull requests: the state mapping, the
 * per-branch attempt records and every fenced transition (Fizzy #2563 spec
 * §4.1 to §4.4).
 *
 * A REPOSITORY proposal's delivery is `pullRequestState`; `proposalStatus` is
 * DERIVED from it by `proposalStatusForPullRequestState` and every transition
 * writes both columns or neither. Each transition is one conditional
 * `UPDATE ... WHERE id AND organizationId AND pullRequestState IN (<allowed>)
 * [AND pullRequestAttempt = <expected>]`: zero rows means another actor moved
 * first, and the caller treats that as an answer, not an error. The allowed
 * (event, from, to) combinations are the spec's §4.4 table, encoded once in
 * `PULL_REQUEST_TRANSITIONS`; asking for any other combination throws,
 * because it is a programming error rather than a race.
 *
 * Attempt records (`pullRequestAttempts`, one per branch) are identified by
 * `(attempt, ref)`. Every record write takes the row lock, finds the record
 * by identity, checks the expected field values, rewrites only that record
 * and rewrites the two summary columns (`pullRequestObligationOpen`,
 * `pullRequestConfirmationDueAt`) from `summarizeAttempts` in the same
 * transaction (plan Decision 1): Prisma cannot filter a `Json[]` element, and
 * retention and the sweeper's Close sub-batch must.
 */
import { db, Prisma } from "../client";
import type { ProjectInstructionPullRequestState } from "../generated/client";
import {
	type AuditAction,
	type RecordAuditInput,
	recordAuditTx,
} from "./audit-log";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The typed failure codes of spec §11. Copy comes from `en.json` by code. */
export const INSTRUCTION_PULL_REQUEST_FAILURE_CODES = [
	"VALIDATION_REJECTED",
	"VALIDATION_FAILED",
	"VALIDATION_TIMEOUT",
	"ATTRIBUTION_REJECTED",
	"PERMISSION_REVOKED",
	"CONFIGURATION_CHANGED",
	"TARGET_BRANCH_MISSING",
	"BASE_COMMIT_UNAVAILABLE",
	"TREE_CONFLICT",
	"AUTHENTICATION_FAILED",
	"REPOSITORY_UNAVAILABLE",
	"BRANCH_WRITE_REFUSED",
	"PR_CREATION_REFUSED",
	"REMOTE_REF_CONFLICT",
	"LOOKUP_INCONCLUSIVE",
	"CREATE_OUTCOME_UNKNOWN",
	"PROVIDER_RATE_LIMITED",
	"PROVIDER_TEMPORARY",
	"CLOSE_REFUSED",
	"CLOSE_CREDENTIALS_UNAVAILABLE",
	"STORAGE_FAILED",
	"GIT_FAILED",
	"LIMITS_EXCEEDED",
	"SYNC_START_FAILED",
	"MERGE_SYNC_FAILED",
	"UNEXPECTED",
] as const;

export type InstructionPullRequestFailureCode =
	(typeof INSTRUCTION_PULL_REQUEST_FAILURE_CODES)[number];

export type PullRequestPhase =
	| "admission"
	| "validation"
	| "recover"
	| "prepare"
	| "push"
	| "create"
	| "reconcile"
	| "close"
	| "merge_sync";

/** `pullRequestFailure`. `params` holds safe values only (counts, branch, delay, phase). */
export type PullRequestFailure = {
	phase: PullRequestPhase;
	code: InstructionPullRequestFailureCode;
	retryable: boolean;
	/** ISO 8601. */
	at: string;
	params: Record<string, string | number | boolean>;
};

/**
 * One element of `pullRequestAttempts`: one branch Fabric pushed, or is
 * about to push (spec §4.1). `pushIssuedAt` is absent on a record appended
 * before its push was issued (a retry's re-issue).
 */
export type PullRequestAttemptRecord = {
	attempt: number;
	ref: string;
	sha: string;
	pushIssuedAt?: string;
	pushAckedAt?: string;
	/** The create marker. */
	createIssuedAt?: string;
	settledAt?: string;
	confirmations: number;
	outcome?: "opened" | "push_unknown_absent" | "conflict" | "settled";
};

export type PullRequestProposalStatus =
	| "PENDING"
	| "MERGED"
	| "CLOSED"
	| "REJECTED";

/** The one mapping from delivery state to proposal status (spec §4.2). */
export function proposalStatusForPullRequestState(
	s: ProjectInstructionPullRequestState,
): PullRequestProposalStatus {
	switch (s) {
		case "QUEUED":
		case "OPENING":
		case "OPEN":
		case "CLOSE_REQUESTED":
		case "BLOCKED":
			return "PENDING";
		case "MERGED":
			return "MERGED";
		case "CLOSED":
			return "CLOSED";
		case "CANCELED":
			return "REJECTED";
		default:
			return unknownState(s);
	}
}

function unknownState(s: never): never {
	throw new Error(`Unknown pull-request state: ${String(s)}`);
}

// ---------------------------------------------------------------------------
// Attempt records
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * A record still owes work (spec §4.1): an issued create not yet resolved,
 * a settlement awaiting its two confirmations, or a push issued without an
 * acknowledgment or an outcome (ownership unknown).
 */
export function hasOutstandingObligation(r: PullRequestAttemptRecord): boolean {
	if (r.createIssuedAt) {
		return true;
	}
	if (r.settledAt && r.confirmations < 2) {
		return true;
	}
	return Boolean(r.pushIssuedAt && !r.pushAckedAt && !r.outcome);
}

/** When a settled record's next confirmation is due: 1 h, then 24 h, after `settledAt`. */
function confirmationDueAt(r: PullRequestAttemptRecord): number | null {
	if (!r.settledAt || r.confirmations >= 2) {
		return null;
	}
	const settled = Date.parse(r.settledAt);
	if (Number.isNaN(settled)) {
		return null;
	}
	return settled + (r.confirmations === 0 ? HOUR_MS : 24 * HOUR_MS);
}

/** The two maintained summary columns (plan Decision 1). */
export function summarizeAttempts(rs: readonly PullRequestAttemptRecord[]): {
	obligationOpen: boolean;
	confirmationDueAt: Date | null;
} {
	let due: number | null = null;
	for (const r of rs) {
		const at = confirmationDueAt(r);
		if (at !== null && (due === null || at < due)) {
			due = at;
		}
	}
	return {
		obligationOpen: rs.some(hasOutstandingObligation),
		confirmationDueAt: due === null ? null : new Date(due),
	};
}

/** Create recovery backoff while the marker stands: 1, 5, 15, 60 min, then hourly (spec §6.1). */
const CREATE_RECOVERY_BACKOFF_MS = [1, 5, 15, 60].map((m) => m * MINUTE_MS);
/** Merge-sync dispatch backoff: 5, 15, then 60 min (spec §9.1 step 4). */
const MERGE_SYNC_BACKOFF_MS = [5, 15, 60].map((m) => m * MINUTE_MS);

/**
 * The delay before the next automatic attempt (spec §11 and Global
 * Constraints), or null when the code is never retried automatically: a
 * human must act (Retry opening, reconnect and submit again) or the outcome
 * is final. `CREATE_OUTCOME_UNKNOWN` becomes null 24 h after its marker.
 */
export function nextRetryDelayMs(
	code: InstructionPullRequestFailureCode,
	ctx: {
		retryAfterSeconds?: number;
		markerAgeMs?: number;
		recoveries?: number;
	},
): number | null {
	const step = (schedule: readonly number[]) =>
		schedule[
			Math.min(Math.max(ctx.recoveries ?? 0, 0), schedule.length - 1)
		];
	switch (code) {
		case "PROVIDER_RATE_LIMITED":
			return ctx.retryAfterSeconds !== undefined &&
				Number.isFinite(ctx.retryAfterSeconds) &&
				ctx.retryAfterSeconds > 0
				? Math.ceil(ctx.retryAfterSeconds * 1000)
				: 15 * MINUTE_MS;
		case "CREATE_OUTCOME_UNKNOWN":
			if ((ctx.markerAgeMs ?? 0) >= 24 * HOUR_MS) {
				return null;
			}
			return step(CREATE_RECOVERY_BACKOFF_MS);
		case "VALIDATION_TIMEOUT":
			return HOUR_MS;
		case "AUTHENTICATION_FAILED":
		case "CLOSE_CREDENTIALS_UNAVAILABLE":
		case "REPOSITORY_UNAVAILABLE":
		case "BRANCH_WRITE_REFUSED":
		case "CLOSE_REFUSED":
		case "REMOTE_REF_CONFLICT":
			return 6 * HOUR_MS;
		case "SYNC_START_FAILED":
			return step(MERGE_SYNC_BACKOFF_MS);
		case "PROVIDER_TEMPORARY":
		case "UNEXPECTED":
		case "LOOKUP_INCONCLUSIVE":
		case "VALIDATION_FAILED":
		case "STORAGE_FAILED":
		case "GIT_FAILED":
		case "LIMITS_EXCEEDED":
			return 15 * MINUTE_MS;
		case "VALIDATION_REJECTED":
		case "ATTRIBUTION_REJECTED":
		case "PERMISSION_REVOKED":
		case "CONFIGURATION_CHANGED":
		case "TARGET_BRANCH_MISSING":
		case "BASE_COMMIT_UNAVAILABLE":
		case "TREE_CONFLICT":
		case "PR_CREATION_REFUSED":
		case "MERGE_SYNC_FAILED":
			return null;
		default:
			return unknownCode(code);
	}
}

function unknownCode(code: never): never {
	throw new Error(`Unknown pull-request failure code: ${String(code)}`);
}

// ---------------------------------------------------------------------------
// Transitions (spec §4.4)
// ---------------------------------------------------------------------------

export type PullRequestEvent =
	| "validation_ready"
	| "validation_failed"
	| "validation_rejected"
	| "abandoned"
	| "deadline"
	| "claim"
	| "adopt"
	| "receipt"
	| "open_failure"
	| "failure"
	| "create_unknown_expired"
	| "retry"
	| "reissue"
	| "cancel_pre_create"
	| "cancel_later"
	| "settled"
	| "confirmation"
	| "push_unknown"
	| "settle_blocked"
	| "observe"
	| "merge_sync_acknowledged"
	| "merge_sync_given_up"
	| "restart_deferred";

type JsonColumn =
	| "pullRequestFailure"
	| "pullRequestObservation"
	| "mergeSyncExpected";

/**
 * The columns a transition may write besides the two status columns and the
 * attempt. The three JSON columns also take a plain `null`, which
 * `transitionPullRequest` writes as SQL NULL, so a caller outside this
 * package (the Temporal activities) clears one without Prisma's sentinels.
 */
export type PullRequestColumns = Partial<
	Pick<
		Prisma.ProjectInstructionSnapshotUncheckedUpdateInput,
		| "pullRequestNextAttemptAt"
		| "pullRequestLastCheckedAt"
		| "pullRequestUrl"
		| "pullRequestExternalId"
		| "pullRequestHeadSha"
		| "pullRequestRef"
		| "mergeSyncRequestedAt"
		| "mergeSyncDispatchedAt"
		| "mergeSyncRunId"
	>
> & {
	[K in JsonColumn]?:
		| Prisma.ProjectInstructionSnapshotUncheckedUpdateInput[K]
		| null;
};

/** `PullRequestColumns` as Prisma takes it: a plain null becomes SQL NULL. */
function columnsForPrisma(
	data: PullRequestColumns | undefined,
): Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput {
	const out: Record<string, unknown> = { ...data };
	for (const key of [
		"pullRequestFailure",
		"pullRequestObservation",
		"mergeSyncExpected",
	] as const) {
		if (out[key] === null) {
			out[key] = Prisma.DbNull;
		}
	}
	return out as Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput;
}

type State = ProjectInstructionPullRequestState;
type Target = State | "unchanged";
type Guard = Prisma.ProjectInstructionSnapshotWhereInput;

const ALL_STATES: readonly State[] = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"MERGED",
	"CLOSED",
	"BLOCKED",
	"CANCELED",
];

type FromRule = {
	state: State;
	to: readonly Target[];
	/** Further conditions the row must meet in this state (spec §4.4 "Allowed from"). */
	guard?: Guard;
	/**
	 * The arm records a fact that is true whatever attempt owns the row, so
	 * its clause never compares `pullRequestAttempt` (spec §4.4 "not
	 * attempt-fenced"). Only a receipt landing on CLOSE_REQUESTED and a
	 * settlement confirmation, which `writeAttemptRecord` fences on its
	 * record's identity instead, are such facts. Every other arm is fenced:
	 * a claim, an open failure, a retry request, settlement under a close
	 * claim and every other write on behalf of the current attempt must name
	 * the attempt its caller observed, so two callers holding one observation
	 * cannot both write and a stale activity cannot overwrite a newer one.
	 */
	attemptIndependent?: true;
};

/**
 * The exact audit rows a transition writes, by target (spec §4.4 "Audit",
 * §13.4): the multiset of actions, compared for equality, so nothing is
 * omitted, added or written twice. A target not listed writes none.
 */
type AuditByTarget = Partial<Record<Target, readonly AuditAction[]>>;

type TransitionRule = {
	from: readonly FromRule[];
	/** Whether the transition increments `pullRequestAttempt`. */
	bump: boolean;
	audit: AuditByTarget;
	/**
	 * The one function that may apply the event, because its fence is not
	 * the attempt; `transitionPullRequest` refuses it.
	 */
	writer?: "clearMergeSyncRequest";
};

const failurePhaseIn = (phases: readonly PullRequestPhase[]): Guard => ({
	OR: phases.map((phase) => ({
		pullRequestFailure: { path: ["phase"], equals: phase },
	})),
});

const failureCode = (code: InstructionPullRequestFailureCode): Guard => ({
	pullRequestFailure: { path: ["code"], equals: code },
});

const failureRetryable = (retryable: boolean): Guard => ({
	pullRequestFailure: { path: ["retryable"], equals: retryable },
});

/** No head SHA and no outstanding record obligation: nothing was pushed or created. */
const NOTHING_PUSHED: Guard = {
	pullRequestHeadSha: null,
	pullRequestObligationOpen: false,
};

/** A validation verdict or abandonment cancels every pre-create state (spec §2.12). */
const PRE_CREATE_CANCEL_FROM: readonly FromRule[] = [
	{ state: "QUEUED", to: ["CANCELED"] },
	{ state: "OPENING", to: ["CANCELED"], guard: { pullRequestHeadSha: null } },
	{
		state: "BLOCKED",
		to: ["CANCELED"],
		guard: failurePhaseIn(["validation", "admission"]),
	},
];

const NO_AUDIT: AuditByTarget = {};
const RECONCILED = "project.instructions.pull_request_reconciled";
const OPENED = "project.instructions.pull_request_opened";
const CLOSE_REQUESTED_AUDIT =
	"project.instructions.pull_request_close_requested";
const RETRY_REQUESTED = "project.instructions.pull_request_retry_requested";
const MERGE_SYNC_REQUESTED =
	"project.instructions.pull_request_merge_sync_requested";
/** Opened (adopted or received); reconciled too when already terminal. */
const OPENED_AUDITS: AuditByTarget = {
	OPEN: [OPENED],
	MERGED: [OPENED, RECONCILED],
	CLOSED: [OPENED, RECONCILED],
	unchanged: [OPENED],
};

/**
 * The §4.4 table. One entry per event; each `from` rule names a state the
 * event may start from, the targets it may reach from there and any further
 * condition. `CLOSE_REQUESTED` never reaches `BLOCKED` or `OPEN`.
 */
export const PULL_REQUEST_TRANSITIONS: Readonly<
	Record<PullRequestEvent, TransitionRule>
> = {
	// Readiness: clears a VALIDATION_FAILED failure, keeps QUEUED.
	validation_ready: {
		from: [
			{
				state: "QUEUED",
				to: ["unchanged"],
				guard: failureCode("VALIDATION_FAILED"),
			},
		],
		bump: false,
		audit: NO_AUDIT,
	},
	// Readiness: a FAILED validation keeps the operation queued.
	validation_failed: {
		from: [{ state: "QUEUED", to: ["unchanged"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	validation_rejected: {
		from: PRE_CREATE_CANCEL_FROM,
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	abandoned: {
		from: PRE_CREATE_CANCEL_FROM,
		bump: true,
		audit: { CANCELED: [RECONCILED] },
	},
	// The 6 h validation clock ran out.
	deadline: {
		from: [{ state: "QUEUED", to: ["BLOCKED"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	// Close's claim (spec §6.2): a new attempt, the state kept, fenced on the
	// attempt the Close sub-batch observed (`DueItem.attempt`), so two
	// claims of one observation cannot both succeed. An OPEN claim is
	// `claimPullRequestOpen`, which needs the database clock and the create
	// marker, neither of which a Prisma filter can express.
	claim: {
		from: [{ state: "CLOSE_REQUESTED", to: ["unchanged"] }],
		bump: true,
		audit: NO_AUDIT,
	},
	// Recovery adoption; CLOSE_REQUESTED keeps its state and close closes it.
	adopt: {
		from: [
			{ state: "OPENING", to: ["OPEN", "MERGED", "CLOSED"] },
			{ state: "BLOCKED", to: ["OPEN", "MERGED", "CLOSED"] },
			{ state: "QUEUED", to: ["OPEN", "MERGED", "CLOSED"] },
			{ state: "CLOSE_REQUESTED", to: ["unchanged"] },
		],
		bump: false,
		audit: OPENED_AUDITS,
	},
	// The create's receipt: OPENING at my attempt; CLOSE_REQUESTED records the
	// facts unfenced and keeps its state.
	receipt: {
		from: [
			{ state: "OPENING", to: ["OPEN", "MERGED", "CLOSED"] },
			{
				state: "CLOSE_REQUESTED",
				to: ["unchanged"],
				attemptIndependent: true,
			},
		],
		bump: false,
		audit: OPENED_AUDITS,
	},
	open_failure: {
		from: [{ state: "OPENING", to: ["BLOCKED"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	// Any other activity's failure is failure-only.
	failure: {
		from: ALL_STATES.map((state) => ({
			state,
			to: ["unchanged"] as const,
		})),
		bump: false,
		audit: NO_AUDIT,
	},
	// 24 h after the marker, CREATE_OUTCOME_UNKNOWN stops being retryable.
	create_unknown_expired: {
		from: [
			{
				state: "OPENING",
				to: ["BLOCKED"],
				guard: {
					AND: [
						failureCode("CREATE_OUTCOME_UNKNOWN"),
						failureRetryable(true),
					],
				},
			},
			{
				state: "BLOCKED",
				to: ["BLOCKED"],
				guard: {
					AND: [
						failureCode("CREATE_OUTCOME_UNKNOWN"),
						failureRetryable(true),
					],
				},
			},
		],
		bump: false,
		audit: NO_AUDIT,
	},
	// A human "Retry opening" on a BLOCKED row that only a human may re-issue
	// (spec §12), with exactly one `pull_request_retry_requested` row. The
	// re-issue's own write at OPENING is `reissue`.
	retry: {
		from: [
			{
				state: "BLOCKED",
				to: ["unchanged"],
				guard: {
					OR: [
						{
							AND: [
								failureCode("CREATE_OUTCOME_UNKNOWN"),
								failureRetryable(false),
							],
						},
						failureCode("PR_CREATION_REFUSED"),
						failureCode("REMOTE_REF_CONFLICT"),
					],
				},
			},
		],
		bump: false,
		audit: { unchanged: [RETRY_REQUESTED] },
	},
	// Retry settlement found nothing (spec §6.1 step 3 (b), §6.2 step 3): the
	// claimed retry records the re-issue's `pullRequestRef` at its attempt.
	// The human request already wrote the retry's one audit row.
	reissue: {
		from: [{ state: "OPENING", to: ["unchanged"] }],
		bump: false,
		audit: NO_AUDIT,
	},
	// Cancel before any push or create: the existing cancellation transaction.
	cancel_pre_create: {
		from: [
			{ state: "QUEUED", to: ["CANCELED"], guard: NOTHING_PUSHED },
			{
				state: "BLOCKED",
				to: ["CANCELED"],
				guard: {
					AND: [
						NOTHING_PUSHED,
						failurePhaseIn(["validation", "admission"]),
					],
				},
			},
		],
		bump: true,
		audit: { CANCELED: [CLOSE_REQUESTED_AUDIT] },
	},
	// Cancel later: settlement closes and deletes what Fabric owns.
	cancel_later: {
		from: [
			{ state: "OPENING", to: ["CLOSE_REQUESTED"] },
			{ state: "OPEN", to: ["CLOSE_REQUESTED"] },
			{
				state: "BLOCKED",
				to: ["CLOSE_REQUESTED"],
				// Exactly the BLOCKED rows `cancel_pre_create` does not take.
				guard: {
					OR: [
						{ pullRequestHeadSha: { not: null } },
						{ pullRequestObligationOpen: true },
						failurePhaseIn([
							"recover",
							"prepare",
							"push",
							"create",
							"reconcile",
							"close",
							"merge_sync",
						]),
					],
				},
			},
		],
		bump: true,
		audit: { CLOSE_REQUESTED: [CLOSE_REQUESTED_AUDIT] },
	},
	settled: {
		from: [
			{ state: "CLOSE_REQUESTED", to: ["CLOSED", "CANCELED", "MERGED"] },
		],
		bump: false,
		audit: {
			CLOSED: [RECONCILED],
			CANCELED: [RECONCILED],
			MERGED: [RECONCILED],
		},
	},
	// A settlement confirmation: terminal CANCELED can still become CLOSED or
	// MERGED; any other row keeps its state. Fenced on the confirmed
	// record's identity, never on the row's attempt (spec §6.2 step 4).
	confirmation: {
		from: [
			{
				state: "CANCELED",
				to: ["CLOSED", "MERGED", "unchanged"],
				attemptIndependent: true,
			},
			...ALL_STATES.filter((state) => state !== "CANCELED").map(
				(state) => ({
					state,
					to: ["unchanged"] as const,
					attemptIndependent: true as const,
				}),
			),
		],
		bump: false,
		audit: { CLOSED: [RECONCILED], MERGED: [RECONCILED] },
	},
	push_unknown: {
		from: [
			{ state: "OPENING", to: ["unchanged", "BLOCKED"] },
			{ state: "CLOSE_REQUESTED", to: ["unchanged"] },
		],
		bump: false,
		audit: NO_AUDIT,
	},
	settle_blocked: {
		from: [
			{ state: "CLOSE_REQUESTED", to: ["unchanged"] },
			{ state: "OPENING", to: ["BLOCKED"] },
		],
		bump: false,
		audit: NO_AUDIT,
	},
	observe: {
		from: [{ state: "OPEN", to: ["MERGED", "CLOSED", "unchanged"] }],
		bump: false,
		audit: { MERGED: [RECONCILED], CLOSED: [RECONCILED] },
	},
	// Merge sync acknowledged or given up (spec §9.1 steps 2 and 5): markers
	// cleared conditional on `mergeSyncExpected`, the identity that fences
	// both, so only `clearMergeSyncRequest` may write them.
	merge_sync_acknowledged: {
		from: [
			{ state: "MERGED", to: ["unchanged"], attemptIndependent: true },
		],
		bump: false,
		audit: { unchanged: [MERGE_SYNC_REQUESTED] },
		writer: "clearMergeSyncRequest",
	},
	merge_sync_given_up: {
		from: [
			{ state: "MERGED", to: ["unchanged"], attemptIndependent: true },
		],
		bump: false,
		audit: NO_AUDIT,
		writer: "clearMergeSyncRequest",
	},
	restart_deferred: {
		from: [
			{ state: "QUEUED", to: ["unchanged"] },
			{ state: "OPENING", to: ["unchanged"] },
			{ state: "BLOCKED", to: ["unchanged"] },
		],
		bump: false,
		audit: NO_AUDIT,
	},
};

function fromRuleOf(
	event: PullRequestEvent,
	state: State,
	to: Target,
): FromRule {
	const match = PULL_REQUEST_TRANSITIONS[event].from.find(
		(r) => r.state === state && r.to.includes(to),
	);
	if (!match) {
		throw new Error(
			`Illegal pull-request transition: ${event} from ${state} to ${to}`,
		);
	}
	return match;
}

/**
 * The row predicate a transition's allowed-from set compiles to. Each source
 * state is its own clause, and a fenced arm's clause carries
 * `pullRequestAttempt = expectedAttempt` (spec §4.2), so the fence is decided
 * per (event, source, target), never per call. A call selecting any fenced
 * arm must name the attempt its caller observed; a call selecting only
 * attempt-independent arms must pass null, so no caller believes a fact write
 * is fenced when it is not.
 */
export function pullRequestTransitionWhere(
	event: PullRequestEvent,
	from: readonly State[],
	to: Target,
	expectedAttempt: number | null,
): Guard {
	if (from.length === 0) {
		throw new Error(
			`Pull-request transition ${event} names no source state`,
		);
	}
	const arms = from.map((state) => ({
		state,
		rule: fromRuleOf(event, state, to),
	}));
	const fenced = arms.find((a) => a.rule.attemptIndependent !== true);
	if (fenced && expectedAttempt === null) {
		throw new Error(
			`Pull-request transition ${event} from ${fenced.state} to ${to} is attempt-fenced: pass the attempt the caller observed`,
		);
	}
	if (!fenced && expectedAttempt !== null) {
		throw new Error(
			`Pull-request transition ${event} to ${to} names only attempt-independent arms: pass expectedAttempt null`,
		);
	}
	const clauses = arms.map(({ state, rule }): Guard => {
		const own: Guard =
			rule.attemptIndependent === true
				? { pullRequestState: state }
				: {
						pullRequestState: state,
						pullRequestAttempt: expectedAttempt as number,
					};
		return rule.guard ? { AND: [own, rule.guard] } : own;
	});
	const [only] = clauses;
	return clauses.length === 1 && only ? only : { OR: clauses };
}

/** Whether every arm the call selects compares the attempt. */
function allArmsFenced(
	event: PullRequestEvent,
	from: readonly State[],
	to: Target,
): boolean {
	return from.every(
		(state) => fromRuleOf(event, state, to).attemptIndependent !== true,
	);
}

function auditsOf(
	audit: RecordAuditInput | readonly RecordAuditInput[] | undefined,
): readonly RecordAuditInput[] {
	if (audit === undefined) {
		return [];
	}
	return Array.isArray(audit) ? audit : [audit as RecordAuditInput];
}

/**
 * The exact audit actions an (event, target) writes (spec §4.4, §13.4): a
 * multiset, empty when the transition writes none.
 */
export function requiredPullRequestAudits(
	event: PullRequestEvent,
	to: Target,
): readonly AuditAction[] {
	return PULL_REQUEST_TRANSITIONS[event].audit[to] ?? [];
}

function assertExactAudits(
	event: PullRequestEvent,
	to: Target,
	audits: readonly RecordAuditInput[],
): void {
	const want = [...requiredPullRequestAudits(event, to)].sort();
	const got = audits.map((a) => a.action).sort();
	if (
		want.length !== got.length ||
		want.some((action, n) => action !== got[n])
	) {
		throw new Error(
			`Pull-request transition ${event} to ${to} writes exactly [${want.join(", ")}], not [${got.join(", ")}]`,
		);
	}
}

/**
 * The stale-VALIDATING reaper (`listStaleValidatingInstructionSnapshots`)
 * reads `updatedAt` as the time a snapshot has spent validating, and Prisma's
 * `@updatedAt` stamps it on every `updateMany`. A pull-request write is not a
 * validation event, so on a snapshot still VALIDATING (a QUEUED operation
 * whose 6 h validation clock ran out, say) every writer here puts the value
 * it read under the row lock back, and the reaper's clock is left alone.
 * Every other status keeps Prisma's stamp.
 */
async function lockSnapshotClock(
	client: Prisma.TransactionClient,
	snapshotId: string,
	organizationId: string,
): Promise<{ status: string; updatedAt: Date } | null> {
	const [row] = await client.$queryRaw<
		Array<{ id: string; status?: string; updatedAt?: Date }>
	>`
		SELECT "id", "status"::text AS "status", "updatedAt"
		FROM "project_instruction_snapshot"
		WHERE "id" = ${snapshotId} AND "organizationId" = ${organizationId}
		FOR UPDATE`;
	if (!row) {
		return null;
	}
	return {
		status: row.status ?? "",
		updatedAt: row.updatedAt ?? new Date(0),
	};
}

function keepValidatingClock(
	locked: { status: string; updatedAt: Date } | null,
): { updatedAt?: Date } {
	return locked?.status === "VALIDATING"
		? { updatedAt: locked.updatedAt }
		: {};
}

/**
 * One fenced transition (spec §4.4). Writes both status columns when `to` is
 * a state, bumps the attempt when the event does, and writes its audit rows
 * with `recordAuditTx` in the same transaction only when the row moved. The
 * rows must be exactly `requiredPullRequestAudits(event, to)`.
 * `expectedAttempt` is the attempt the caller observed: required (a number)
 * whenever the call selects an attempt-fenced arm, and null only for a call
 * whose every arm is attempt-independent (`pullRequestTransitionWhere`).
 */
export async function transitionPullRequest(
	i: {
		snapshotId: string;
		organizationId: string;
		event: PullRequestEvent;
		from: readonly State[];
		expectedAttempt: number | null;
		to: Target;
		bumpAttempt: boolean;
		data?: PullRequestColumns;
		audit?: RecordAuditInput | readonly RecordAuditInput[];
	},
	tx?: Prisma.TransactionClient,
): Promise<{ ok: true; attempt: number } | { ok: false }> {
	const rule = PULL_REQUEST_TRANSITIONS[i.event];
	if (rule.writer) {
		throw new Error(
			`Pull-request transition ${i.event} is written only by ${rule.writer}, which carries its fence`,
		);
	}
	// Legality and the fence first: an illegal (event, from, to), or a
	// fenced arm named without an attempt, is a programming error.
	const stateWhere = pullRequestTransitionWhere(
		i.event,
		i.from,
		i.to,
		i.expectedAttempt,
	);
	const fencedCall = allArmsFenced(i.event, i.from, i.to);
	if (i.bumpAttempt !== rule.bump) {
		throw new Error(
			`Pull-request transition ${i.event} ${rule.bump ? "must" : "must not"} bump the attempt`,
		);
	}
	const audits = auditsOf(i.audit);
	assertExactAudits(i.event, i.to, audits);
	const where: Prisma.ProjectInstructionSnapshotWhereInput = {
		id: i.snapshotId,
		organizationId: i.organizationId,
		AND: [stateWhere],
	};
	const data: Prisma.ProjectInstructionSnapshotUncheckedUpdateManyInput = {
		...columnsForPrisma(i.data),
		...(i.to === "unchanged"
			? {}
			: {
					pullRequestState: i.to,
					proposalStatus: proposalStatusForPullRequestState(i.to),
				}),
		...(i.bumpAttempt ? { pullRequestAttempt: { increment: 1 } } : {}),
	};

	const run = async (
		client: Prisma.TransactionClient,
	): Promise<{ ok: true; attempt: number } | { ok: false }> => {
		const locked = await lockSnapshotClock(
			client,
			i.snapshotId,
			i.organizationId,
		);
		if (!locked) {
			return { ok: false };
		}
		const { count } = await client.projectInstructionSnapshot.updateMany({
			where,
			data: { ...data, ...keepValidatingClock(locked) },
		});
		if (count !== 1) {
			return { ok: false };
		}
		let attempt: number;
		if (fencedCall) {
			attempt = (i.expectedAttempt as number) + (i.bumpAttempt ? 1 : 0);
		} else {
			// An attempt-independent arm matched the row at whatever attempt
			// it holds. Our UPDATE holds the row lock until commit, so this
			// read sees exactly the attempt it left.
			const row = await client.projectInstructionSnapshot.findFirst({
				where: { id: i.snapshotId, organizationId: i.organizationId },
				select: { pullRequestAttempt: true },
			});
			attempt = row?.pullRequestAttempt ?? 0;
		}
		for (const a of audits) {
			await recordAuditTx(client, a);
		}
		return { ok: true, attempt };
	};
	return tx ? run(tx) : db.$transaction((t) => run(t));
}

// ---------------------------------------------------------------------------
// Record writes (spec §4.1)
// ---------------------------------------------------------------------------

type RecordField =
	| "pushIssuedAt"
	| "pushAckedAt"
	| "createIssuedAt"
	| "settledAt"
	| "outcome";

/** Per field: `null` requires it absent, `"set"` requires it present. */
export type RecordExpectation = Partial<Record<RecordField, null | "set">> & {
	confirmations?: number;
};

/** A record patch; `null` clears an optional field. The identity is not patchable. */
export type AttemptRecordPatch = {
	[K in Exclude<keyof PullRequestAttemptRecord, "attempt" | "ref">]?:
		| PullRequestAttemptRecord[K]
		| null;
};

function toRecords(value: unknown): PullRequestAttemptRecord[] {
	return Array.isArray(value) ? (value as PullRequestAttemptRecord[]) : [];
}

function meetsExpectation(
	r: PullRequestAttemptRecord,
	expect: RecordExpectation,
): boolean {
	for (const field of [
		"pushIssuedAt",
		"pushAckedAt",
		"createIssuedAt",
		"settledAt",
		"outcome",
	] as const) {
		const wanted = expect[field];
		if (wanted === undefined) {
			continue;
		}
		const present = r[field] !== undefined && r[field] !== null;
		if (wanted === null ? present : !present) {
			return false;
		}
	}
	return (
		expect.confirmations === undefined ||
		r.confirmations === expect.confirmations
	);
}

function applyPatch(
	r: PullRequestAttemptRecord,
	patch: AttemptRecordPatch,
): PullRequestAttemptRecord {
	const next: Record<string, unknown> = { ...r };
	for (const [key, value] of Object.entries(patch)) {
		if (key === "attempt" || key === "ref") {
			throw new Error("An attempt record's identity is not patchable");
		}
		if (value === null || value === undefined) {
			delete next[key];
		} else {
			next[key] = value;
		}
	}
	return next as PullRequestAttemptRecord;
}

/**
 * Rewrites one attempt record under the row lock, or appends one, and the
 * two summary columns with it. False when the row, the record or an
 * expectation does not hold; nothing is written then.
 */
export async function writeAttemptRecord(
	i: {
		snapshotId: string;
		organizationId: string;
		identity: { attempt: number; ref: string };
		expect: RecordExpectation;
		patch: AttemptRecordPatch;
		row?: { states?: readonly State[]; attempt?: number };
		append?: boolean;
	},
	tx?: Prisma.TransactionClient,
): Promise<boolean> {
	const run = async (client: Prisma.TransactionClient): Promise<boolean> => {
		const locked = await lockSnapshotClock(
			client,
			i.snapshotId,
			i.organizationId,
		);
		if (!locked) {
			return false;
		}
		const row = await client.projectInstructionSnapshot.findFirst({
			where: { id: i.snapshotId, organizationId: i.organizationId },
			select: {
				pullRequestState: true,
				pullRequestAttempt: true,
				pullRequestAttempts: true,
			},
		});
		if (!row) {
			return false;
		}
		if (
			i.row?.states !== undefined &&
			(row.pullRequestState === null ||
				!i.row.states.includes(row.pullRequestState))
		) {
			return false;
		}
		if (
			i.row?.attempt !== undefined &&
			row.pullRequestAttempt !== i.row.attempt
		) {
			return false;
		}
		const records = toRecords(row.pullRequestAttempts);
		const index = records.findIndex(
			(r) => r.attempt === i.identity.attempt && r.ref === i.identity.ref,
		);
		let next: PullRequestAttemptRecord[];
		if (i.append) {
			// A re-queue appends and never edits an earlier record.
			if (index !== -1) {
				return false;
			}
			const created = applyPatch(
				{
					attempt: i.identity.attempt,
					ref: i.identity.ref,
					sha: "",
					confirmations: 0,
				},
				i.patch,
			);
			if (!created.sha) {
				throw new Error("An appended attempt record needs its sha");
			}
			next = [...records, created];
		} else {
			if (index === -1 || !meetsExpectation(records[index], i.expect)) {
				return false;
			}
			next = records.map((r, n) =>
				n === index ? applyPatch(r, i.patch) : r,
			);
		}
		const summary = summarizeAttempts(next);
		const { count } = await client.projectInstructionSnapshot.updateMany({
			where: { id: i.snapshotId, organizationId: i.organizationId },
			data: {
				pullRequestAttempts: next as unknown as Prisma.InputJsonValue[],
				pullRequestObligationOpen: summary.obligationOpen,
				pullRequestConfirmationDueAt: summary.confirmationDueAt,
				...keepValidatingClock(locked),
			},
		});
		return count === 1;
	};
	return tx ? run(tx) : db.$transaction((t) => run(t));
}

// ---------------------------------------------------------------------------
// The open claim (spec §4.4 claim rows, §6.1 step 1, plan Decision 7)
// ---------------------------------------------------------------------------

/**
 * Claims the operation for one open attempt. The caller names the attempt
 * it observed (readiness returns it); the claim compares it under the row
 * lock and conditions its update on it, so two callers holding the same
 * observation cannot both claim. A row with a create marker is claimable
 * only through `retryCreate`, at the attempt it names; an ordinary claim
 * takes a retryable BLOCKED row only when it is due by the database clock,
 * while a human retry ignores the backoff.
 */
/**
 * The due test is the database's clock, never a worker timestamp (Review
 * Focus 4). `AT TIME ZONE 'UTC'` because the column is `timestamp without
 * time zone` holding UTC, as in `leaseFenceSql`
 * (instruction-repository-sync.ts); a bare `now()` would be cast through the
 * session time zone.
 */
export async function claimPullRequestOpen(i: {
	snapshotId: string;
	organizationId: string;
	expectedAttempt: number;
	retryCreate?: { expectedAttempt: number };
}): Promise<
	| { kind: "claimed"; attempt: number }
	| { kind: "open" | "terminal" | "close_requested" | "not_claimable" }
> {
	return db.$transaction(async (tx) => {
		const [row] = await tx.$queryRaw<
			Array<{
				state: ProjectInstructionPullRequestState | null;
				attempt: number;
				failure: PullRequestFailure | null;
				attempts: PullRequestAttemptRecord[] | null;
				due: boolean;
				status?: string;
				updatedAt?: Date;
			}>
		>`
			SELECT "pullRequestState" AS state, "pullRequestAttempt" AS attempt, "pullRequestFailure" AS failure, "pullRequestAttempts" AS attempts,
				("pullRequestNextAttemptAt" IS NULL OR "pullRequestNextAttemptAt" <= (now() AT TIME ZONE 'UTC')) AS due,
				"status"::text AS "status", "updatedAt"
			FROM "project_instruction_snapshot"
			WHERE "id" = ${i.snapshotId} AND "organizationId" = ${i.organizationId} FOR UPDATE`;
		if (!row || row.state === null) {
			return { kind: "not_claimable" as const };
		}
		if (row.state === "OPEN") {
			return { kind: "open" as const };
		}
		if (row.state === "CLOSE_REQUESTED") {
			return { kind: "close_requested" as const };
		}
		if (["MERGED", "CLOSED", "CANCELED"].includes(row.state)) {
			return { kind: "terminal" as const };
		}
		if (row.attempt !== i.expectedAttempt) {
			return { kind: "not_claimable" as const }; // stale observation
		}
		const marker = toRecords(row.attempts).some(
			(r) => r.createIssuedAt && !r.settledAt,
		);
		const claimable = i.retryCreate
			? row.state === "BLOCKED" &&
				row.attempt === i.retryCreate.expectedAttempt // human retry: no backoff wait
			: !marker &&
				(row.state === "QUEUED" ||
					row.state === "OPENING" ||
					(row.state === "BLOCKED" &&
						row.due &&
						row.failure?.retryable === true));
		if (!claimable) {
			return { kind: "not_claimable" as const };
		}
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: i.snapshotId,
				organizationId: i.organizationId,
				pullRequestAttempt: i.expectedAttempt,
			},
			data: {
				pullRequestState: "OPENING",
				proposalStatus: "PENDING",
				pullRequestAttempt: i.expectedAttempt + 1,
				...keepValidatingClock(
					row.status !== undefined && row.updatedAt !== undefined
						? { status: row.status, updatedAt: row.updatedAt }
						: null,
				),
			},
		});
		if (count !== 1) {
			return { kind: "not_claimable" as const };
		}
		return { kind: "claimed" as const, attempt: i.expectedAttempt + 1 };
	});
}

// ---------------------------------------------------------------------------
// Retention (spec §4.3)
// ---------------------------------------------------------------------------

/** The states in which an operation may still push, create, close or settle. */
const UNRESOLVED_STATES = [
	"QUEUED",
	"OPENING",
	"OPEN",
	"CLOSE_REQUESTED",
	"BLOCKED",
] as const satisfies readonly State[];

/** The terminal states; a row in one is resolved once nothing is owed on it. */
const RESOLVED_STATES = [
	"MERGED",
	"CLOSED",
	"CANCELED",
] as const satisfies readonly State[];

/**
 * A row retention must keep: a live operation, a merge sync still owed, or
 * any attempt record with an outstanding obligation (the maintained
 * `pullRequestObligationOpen` column). Spec §4.3.
 */
export function unresolvedPullRequestOperation() {
	return {
		OR: [
			{ pullRequestState: { in: [...UNRESOLVED_STATES] } },
			{ mergeSyncRequestedAt: { not: null } },
			{ pullRequestObligationOpen: true },
		],
	} satisfies Prisma.ProjectInstructionSnapshotWhereInput;
}

/**
 * The null-safe complement of `unresolvedPullRequestOperation`, which every
 * retention filter uses. `NOT` over that `OR` would be wrong for a FABRIC
 * row: `"pullRequestState" IN (...)` is NULL for a null state, so the
 * negation is NULL too and no FABRIC row would ever be prunable again.
 */
export function resolvedPullRequestOperation() {
	return {
		AND: [
			{
				OR: [
					{ pullRequestState: null },
					{ pullRequestState: { in: [...RESOLVED_STATES] } },
				],
			},
			{ mergeSyncRequestedAt: null },
			{ pullRequestObligationOpen: false },
		],
	} satisfies Prisma.ProjectInstructionSnapshotWhereInput;
}

/** The same predicate over a row value, for a caller that has read the row. */
export function isUnresolvedPullRequestOperation(row: {
	pullRequestState?: State | null;
	mergeSyncRequestedAt?: Date | null;
	pullRequestObligationOpen?: boolean | null;
}): boolean {
	return (
		(row.pullRequestState !== null &&
			row.pullRequestState !== undefined &&
			(UNRESOLVED_STATES as readonly State[]).includes(
				row.pullRequestState,
			)) ||
		(row.mergeSyncRequestedAt !== null &&
			row.mergeSyncRequestedAt !== undefined) ||
		row.pullRequestObligationOpen === true
	);
}

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/;

/** `<alias>."<column>"`. The alias is a caller's constant, checked, never input. */
function column(alias: string, name: string): Prisma.Sql {
	if (!SQL_ALIAS.test(alias)) {
		throw new Error(`Invalid SQL alias: ${alias}`);
	}
	return Prisma.raw(`${alias}."${name}"`);
}

function stateList(states: readonly State[]): Prisma.Sql {
	return Prisma.raw(states.map((state) => `'${state}'`).join(", "));
}

/** `unresolvedPullRequestOperation()` for raw SQL over `alias`. */
export function unresolvedPullRequestOperationSql(alias: string): Prisma.Sql {
	return Prisma.sql`(${column(alias, "pullRequestState")} IN (${stateList(UNRESOLVED_STATES)}) OR ${column(alias, "mergeSyncRequestedAt")} IS NOT NULL OR ${column(alias, "pullRequestObligationOpen")})`;
}

/** `resolvedPullRequestOperation()` for raw SQL over `alias`, null-safe as it is. */
export function resolvedPullRequestOperationSql(alias: string): Prisma.Sql {
	const state = column(alias, "pullRequestState");
	return Prisma.sql`(${state} IS NULL OR ${state} IN (${stateList(RESOLVED_STATES)})) AND ${column(alias, "mergeSyncRequestedAt")} IS NULL AND NOT ${column(alias, "pullRequestObligationOpen")}`;
}

// ---------------------------------------------------------------------------
// The sweeper's selection (spec §9)
// ---------------------------------------------------------------------------

/** One row a sub-batch selected: ids and the attempt read at selection. */
export type DueItem = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	operationId: string;
	attempt: number;
	/** The frozen context's integration, which rate limiting groups by. */
	integrationId: string | null;
	/** Recover only: which of spec §9's two clauses selected the row. */
	recoverClause?: 1 | 2;
};

export type DueProposalOperations = {
	close: DueItem[];
	recover: DueItem[];
	mergeSync: DueItem[];
	observe: DueItem[];
	restart: DueItem[];
};

/**
 * The SQL fragments the sub-batches share, built on first use rather than at
 * import. Every due test reads the database clock (Review Focus 4), with `AT
 * TIME ZONE 'UTC'` because the columns are `timestamp without time zone`
 * holding UTC, as `claimPullRequestOpen` explains.
 */
function sweepFragments() {
	const nowUtc = Prisma.sql`(now() AT TIME ZONE 'UTC')`;
	const retryableBlocked = Prisma.sql`(s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'true')`;
	// No record carries an OUTSTANDING create marker: a create may be in
	// flight on none. A settled record's marker is history, kept only until
	// its second confirmation clears it, so it must not keep a human retry's
	// row from Recover (2) or Restart for a day; the claim reads markers the
	// same way (`createIssuedAt` set and `settledAt` null).
	const noCreateMarker = Prisma.sql`NOT EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") m WHERE m->>'createIssuedAt' IS NOT NULL AND m->>'settledAt' IS NULL)`;
	return {
		nowUtc,
		due: Prisma.sql`(s."pullRequestNextAttemptAt" IS NULL OR s."pullRequestNextAttemptAt" <= ${nowUtc})`,
		byNextAttempt: Prisma.sql`ORDER BY s."pullRequestNextAttemptAt" ASC NULLS FIRST, s."id" ASC`,
		retryableBlocked,
		noCreateMarker,
		// Recover (1): an unsettled record with a create marker, or with a
		// push that was issued and never acknowledged and no outcome, on a
		// row that is not terminal. A record a branch-write refusal returned
		// to not issued (`pushIssuedAt` cleared) has no uncertain effect: it
		// is Restart's, and must not take a Recover slot.
		recoverUnsettled: Prisma.sql`(s."pullRequestState" IN (${stateList(UNRESOLVED_STATES)}) AND EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") r WHERE r->>'settledAt' IS NULL AND (r->>'createIssuedAt' IS NOT NULL OR (r->>'pushIssuedAt' IS NOT NULL AND r->>'pushAckedAt' IS NULL AND r->>'outcome' IS NULL))))`,
		// Recover (2): the current record acknowledged, no external id, no marker.
		recoverAcknowledged: Prisma.sql`(s."pullRequestExternalId" IS NULL AND (s."pullRequestState" IN ('QUEUED', 'OPENING') OR ${retryableBlocked}) AND ${noCreateMarker} AND EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") c WHERE c->>'ref' = s."pullRequestRef" AND c->>'pushAckedAt' IS NOT NULL))`,
		// Close (abandoned push): a BLOCKED row only a human may retry whose
		// current record's push was acknowledged but never created on,
		// settled or given an outcome, with no pull request and no
		// outstanding marker. Recover (2) and Restart take only a retryable
		// BLOCKED row, so nothing else would ever delete that branch; Close
		// releases it (the open activity's own release did not finish) and
		// keeps the row's state and failure.
		abandonedPush: Prisma.sql`(s."pullRequestState" = 'BLOCKED' AND (s."pullRequestFailure"->>'retryable') = 'false' AND s."pullRequestExternalId" IS NULL AND ${noCreateMarker} AND EXISTS (SELECT 1 FROM unnest(s."pullRequestAttempts") c WHERE c->>'ref' = s."pullRequestRef" AND c->>'pushAckedAt' IS NOT NULL AND c->>'settledAt' IS NULL AND c->>'createIssuedAt' IS NULL AND c->>'outcome' IS NULL))`,
		columns: Prisma.sql`s."id" AS "snapshotId", s."projectId", s."organizationId", s."pullRequestOperationId" AS "operationId", s."pullRequestAttempt" AS "attempt", s."pullRequestContext"->>'integrationId' AS "integrationId"`,
	};
}

type DueRow = Omit<DueItem, "recoverClause"> & { recoverClause?: number };

function toDueItems(rows: DueRow[]): DueItem[] {
	return rows.map((row) => ({
		snapshotId: row.snapshotId,
		projectId: row.projectId,
		organizationId: row.organizationId,
		operationId: row.operationId,
		attempt: Number(row.attempt),
		integrationId: row.integrationId,
		...(row.recoverClause === undefined
			? {}
			: { recoverClause: row.recoverClause === 1 ? 1 : 2 }),
	}));
}

/**
 * The five sub-batches of spec §9, in the table's order (Close first, so due
 * confirmations precede ordinary recovery), as five statements in one
 * repeatable-read transaction. SYSTEM-WIDE: it returns ids and each row's
 * own tenant columns, and every action on an item runs under that item's
 * organization and is fenced on the attempt read here. An id an earlier
 * sub-batch took is excluded from every later one. Every due test is the
 * database clock; the limits and the taken ids are the only bound values.
 */
export async function selectDueProposalOperations(limits: {
	close: number;
	recover: number;
	mergeSync: number;
	observe: number;
	restart: number;
}): Promise<DueProposalOperations> {
	const {
		nowUtc,
		due,
		byNextAttempt,
		retryableBlocked,
		noCreateMarker,
		recoverUnsettled,
		recoverAcknowledged,
		abandonedPush,
		columns,
	} = sweepFragments();
	return db.$transaction(
		async (tx) => {
			const taken: string[] = [];
			const run = async (
				statement: (excluded: string[]) => Prisma.Sql,
			): Promise<DueItem[]> => {
				const items = toDueItems(
					await tx.$queryRaw<DueRow[]>(statement([...taken])),
				);
				taken.push(...items.map((item) => item.snapshotId));
				return items;
			};
			const from = (excluded: string[]) =>
				Prisma.sql`FROM "project_instruction_snapshot" s WHERE s."proposalDestination" = 'REPOSITORY' AND s."id" <> ALL(${excluded}::text[])`;

			const close = await run(
				(
					excluded,
				) => Prisma.sql`/* sweep:close */ SELECT ${columns} ${from(excluded)}
					AND (((s."pullRequestState" = 'CLOSE_REQUESTED' AND ${due}) OR s."pullRequestConfirmationDueAt" <= ${nowUtc}) OR (${abandonedPush} AND ${due}))
					${byNextAttempt} LIMIT ${limits.close}`,
			);
			const recover = await run(
				(
					excluded,
				) => Prisma.sql`/* sweep:recover */ SELECT ${columns}, CASE WHEN ${recoverUnsettled} THEN 1 ELSE 2 END AS "recoverClause" ${from(excluded)}
					AND ${due} AND (${recoverUnsettled} OR ${recoverAcknowledged})
					${byNextAttempt} LIMIT ${limits.recover}`,
			);
			const mergeSync = await run(
				(
					excluded,
				) => Prisma.sql`/* sweep:merge_sync */ SELECT ${columns} ${from(excluded)}
					AND s."mergeSyncRequestedAt" IS NOT NULL AND ${due}
					${byNextAttempt} LIMIT ${limits.mergeSync}`,
			);
			const observe = await run(
				(
					excluded,
				) => Prisma.sql`/* sweep:observe */ SELECT ${columns} ${from(excluded)}
					AND s."pullRequestState" = 'OPEN'
					AND (s."pullRequestLastCheckedAt" IS NULL OR s."pullRequestLastCheckedAt" <= ${nowUtc} - interval '10 minutes')
					AND ${due}
					ORDER BY s."pullRequestLastCheckedAt" ASC NULLS FIRST, s."id" ASC LIMIT ${limits.observe}`,
			);
			const restart = await run(
				(
					excluded,
				) => Prisma.sql`/* sweep:restart */ SELECT ${columns} ${from(excluded)}
					AND (s."pullRequestState" IN ('QUEUED', 'OPENING') OR ${retryableBlocked})
					AND ${noCreateMarker}
					AND s."createdAt" <= ${nowUtc} - interval '2 minutes'
					AND ${due}
					${byNextAttempt} LIMIT ${limits.restart}`,
			);
			return { close, recover, mergeSync, observe, restart };
		},
		{ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
	);
}

/**
 * Defers a row whose workflow is still running (spec §9): its next attempt
 * moves `minutes` past the database clock, conditional on the attempt read
 * at selection. False when another actor moved the attempt first.
 */
export async function deferProposalOperation(i: {
	snapshotId: string;
	organizationId: string;
	attempt: number;
	minutes: number;
}): Promise<boolean> {
	const count = await db.$executeRaw`
		UPDATE "project_instruction_snapshot"
		SET "pullRequestNextAttemptAt" = (now() AT TIME ZONE 'UTC') + make_interval(mins => ${i.minutes}::int)
		WHERE "id" = ${i.snapshotId} AND "organizationId" = ${i.organizationId} AND "pullRequestAttempt" = ${i.attempt}
	`;
	return count === 1;
}

/**
 * How often a person's Refresh is admitted, per operation (spec §12):
 * at most once in this many seconds, on the database clock.
 */
export const PULL_REQUEST_REFRESH_COOLDOWN_SECONDS = 60;

/**
 * A Refresh's answer (spec §12): admitted, with what the row holds
 * afterwards, or refused with the seconds until one could be admitted.
 * `provider_rate_limited` is a row whose provider set its own deadline,
 * which no Refresh moves; `cooldown` is one refreshed within the last
 * `PULL_REQUEST_REFRESH_COOLDOWN_SECONDS`.
 */
export type PullRequestRefreshResult =
	| { admitted: true; state: State; attempt: number; failure: unknown }
	| {
			admitted: false;
			reason: "cooldown" | "provider_rate_limited";
			retryAfterSeconds: number;
	  };

/**
 * Refresh (spec §12), for a person asking Fabric to look again: nulls
 * `pullRequestLastCheckedAt`, so the sweeper's Observe takes an OPEN row on
 * its next tick, and makes a retryable BLOCKED row due now on the database
 * clock (Review Focus 4). A non-retryable BLOCKED row keeps its next attempt:
 * only a human retry re-issues it. Only an unresolved REPOSITORY operation
 * in the caller's project and organization is touched; null otherwise.
 *
 * Every Refresh brings provider work forward, so it is rationed (review
 * round 1). ONE conditional UPDATE admits it, and only when no Refresh of
 * this operation was admitted in the last
 * `PULL_REQUEST_REFRESH_COOLDOWN_SECONDS`; the same statement stamps
 * `pullRequestRefreshAdmittedAt`. Two concurrent refreshes serialize on the
 * row lock and the second re-reads the stamp the first wrote, so exactly one
 * is admitted. A BLOCKED `PROVIDER_RATE_LIMITED` row whose deadline is still
 * ahead is never admitted: that deadline is the provider's own (its
 * Retry-After), and no Refresh shortens it. A refused Refresh changes
 * nothing; a second read only explains the refusal and never admits.
 *
 * Raw SQL on purpose: a Prisma update would stamp `updatedAt`, which on a
 * VALIDATING snapshot is the gate's staleness clock. Not attempt-fenced:
 * it moves no state and bumps nothing, and the one statement decides under
 * its own row lock, so a transition racing it is either wholly before or
 * wholly after. An admitted answer carries what the row holds afterwards,
 * for the caller to decide whether the operation's workflow should run.
 */
export async function requestPullRequestRefresh(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<PullRequestRefreshResult | null> {
	const cooldown = PULL_REQUEST_REFRESH_COOLDOWN_SECONDS;
	const admitted = await db.$queryRaw<
		Array<{ state: State; attempt: number; failure: unknown }>
	>`
		UPDATE "project_instruction_snapshot"
		SET "pullRequestLastCheckedAt" = NULL,
			"pullRequestRefreshAdmittedAt" = (now() AT TIME ZONE 'UTC'),
			"pullRequestNextAttemptAt" = CASE
				WHEN "pullRequestState" = 'BLOCKED'
					AND ("pullRequestFailure"->>'retryable') = 'true'
					AND ("pullRequestFailure"->>'code') IS DISTINCT FROM 'PROVIDER_RATE_LIMITED'
				THEN (now() AT TIME ZONE 'UTC')
				ELSE "pullRequestNextAttemptAt"
			END
		WHERE "id" = ${i.snapshotId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "proposalDestination" = 'REPOSITORY'
			AND "pullRequestState" IN (${stateList(UNRESOLVED_STATES)})
			AND ("pullRequestRefreshAdmittedAt" IS NULL
				OR "pullRequestRefreshAdmittedAt"
					<= (now() AT TIME ZONE 'UTC') - make_interval(secs => ${cooldown}::int))
			AND NOT COALESCE(
				"pullRequestState" = 'BLOCKED'
					AND ("pullRequestFailure"->>'code') = 'PROVIDER_RATE_LIMITED'
					AND "pullRequestNextAttemptAt" > (now() AT TIME ZONE 'UTC'),
				false)
		RETURNING "pullRequestState" AS "state", "pullRequestAttempt" AS "attempt", "pullRequestFailure" AS "failure"
	`;
	const row = admitted[0];
	if (row) {
		return {
			admitted: true,
			state: row.state,
			attempt: Number(row.attempt),
			failure: row.failure,
		};
	}
	// Not admitted: say why, from the row as it is now. Read-only, and in the
	// same scope as the UPDATE, so a row that is not an unresolved operation
	// of this project is still null.
	const refused = await db.$queryRaw<
		Array<{
			rateLimited: boolean | null;
			backoffSeconds: number | null;
			cooldownSeconds: number | null;
		}>
	>`
		SELECT
			("pullRequestState" = 'BLOCKED'
				AND ("pullRequestFailure"->>'code') = 'PROVIDER_RATE_LIMITED'
				AND "pullRequestNextAttemptAt" > (now() AT TIME ZONE 'UTC')) AS "rateLimited",
			CEIL(EXTRACT(EPOCH FROM ("pullRequestNextAttemptAt" - (now() AT TIME ZONE 'UTC'))))::int AS "backoffSeconds",
			CEIL(EXTRACT(EPOCH FROM (
				"pullRequestRefreshAdmittedAt" + make_interval(secs => ${cooldown}::int)
					- (now() AT TIME ZONE 'UTC'))))::int AS "cooldownSeconds"
		FROM "project_instruction_snapshot"
		WHERE "id" = ${i.snapshotId}
			AND "projectId" = ${i.projectId}
			AND "organizationId" = ${i.organizationId}
			AND "proposalDestination" = 'REPOSITORY'
			AND "pullRequestState" IN (${stateList(UNRESOLVED_STATES)})
	`;
	const why = refused[0];
	if (!why) {
		return null;
	}
	// A refused Refresh is told to wait at least a second: if the cooldown
	// ran out between the two statements, trying again is simply admitted.
	const cooling = Math.min(cooldown, Math.max(0, why.cooldownSeconds ?? 0));
	if (why.rateLimited === true) {
		return {
			admitted: false,
			reason: "provider_rate_limited",
			retryAfterSeconds: Math.max(1, why.backoffSeconds ?? 1, cooling),
		};
	}
	return {
		admitted: false,
		reason: "cooldown",
		retryAfterSeconds: Math.max(1, cooling),
	};
}

// ---------------------------------------------------------------------------
// Merge-sync receipts (spec §9.1)
// ---------------------------------------------------------------------------

/** What `classifyMergeSyncReceipt` (Task 13) reads from a run receipt. */
const RECEIPT_SELECT = {
	id: true,
	projectId: true,
	syncId: true,
	generation: true,
	trigger: true,
	startedAt: true,
	status: true,
	error: true,
} satisfies Prisma.ProjectInstructionRepositorySyncRunSelect;

/**
 * The newest merge-triggered run for the tuple the request was dispatched
 * with, started at or after the request (spec §9.1 step 2), when no run id
 * was recorded. Scoped to the row's organization and project (spec §13.5).
 */
export function findMergeTriggeredRun(i: {
	projectId: string;
	organizationId: string;
	syncId: string;
	generation: number;
	startedAtOrAfter: Date;
}) {
	return db.projectInstructionRepositorySyncRun.findFirst({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			syncId: i.syncId,
			generation: i.generation,
			trigger: "PULL_REQUEST_MERGED",
			startedAt: { gte: i.startedAtOrAfter },
		},
		orderBy: { startedAt: "desc" },
		select: RECEIPT_SELECT,
	});
}

/**
 * The receipt of the Temporal run `runId`, whichever sync row keyed it
 * (spec §9.1): the receipt id is `<syncId>:<runId>` for the row that existed
 * when `begin` ran, so a key built from the dispatcher's own sync id names
 * nothing after a reconfiguration. Scoped to the row's organization and project (spec
 * §13.5); `projectId` also bounds the scan by the `(projectId, startedAt)`
 * index prefix.
 */
export async function getSyncRunReceiptByRunId(i: {
	projectId: string;
	organizationId: string;
	runId: string;
}) {
	if (i.runId === "") {
		// `endsWith(":")` would match every receipt of the project.
		throw new Error("getSyncRunReceiptByRunId needs a run id");
	}
	return db.projectInstructionRepositorySyncRun.findFirst({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			id: { endsWith: `:${i.runId}` },
		},
		select: RECEIPT_SELECT,
	});
}

/** A merge-sync run's receipt as the queries here read it. */
type SyncRunReceipt = Prisma.ProjectInstructionRepositorySyncRunGetPayload<{
	select: typeof RECEIPT_SELECT;
}>;

/**
 * The receipts of several Temporal runs in ONE query, for a page of proposals
 * (spec §9.1, §12): the same rule as `getSyncRunReceiptByRunId`
 * for each id (a receipt in this project and organization whose id ends
 * `:<runId>`, whichever sync row keyed it), keyed by run id. A run with no
 * receipt is absent from the map. Empty ids are skipped rather than refused:
 * a row whose `mergeSyncRunId` is empty reads no receipt on the single path
 * either, and `endsWith(":")` would match every receipt of the project. No
 * query at all when no id is left.
 */
export async function getSyncRunReceiptsByRunIds(i: {
	projectId: string;
	organizationId: string;
	runIds: readonly string[];
}): Promise<Map<string, SyncRunReceipt>> {
	const runIds = [...new Set(i.runIds.filter((runId) => runId !== ""))];
	const byRunId = new Map<string, SyncRunReceipt>();
	if (runIds.length === 0) {
		return byRunId;
	}
	const receipts = await db.projectInstructionRepositorySyncRun.findMany({
		where: {
			projectId: i.projectId,
			organizationId: i.organizationId,
			OR: runIds.map((runId) => ({ id: { endsWith: `:${runId}` } })),
		},
		select: RECEIPT_SELECT,
	});
	for (const runId of runIds) {
		const receipt = receipts.find((r) => r.id.endsWith(`:${runId}`));
		if (receipt) {
			byRunId.set(runId, receipt);
		}
	}
	return byRunId;
}

/** A sync row's identity at one generation (spec §9.1). */
export type MergeSyncTuple = { syncId: string; generation: number };

/**
 * The two ways a merge-sync request ends (spec §9.1 steps 2 and 5), as
 * distinct inputs so neither can borrow the other's writes.
 */
export type ClearMergeSyncRequestInput =
	| {
			/** A consuming receipt for exactly `expected` (step 2). */
			kind: "acknowledged";
			snapshotId: string;
			organizationId: string;
			/** The receipt's own tuple, which must still be `mergeSyncExpected`. */
			expected: MergeSyncTuple;
			/** Exactly one `pull_request_merge_sync_requested` row. */
			audit: RecordAuditInput;
	  }
	| {
			/** The destination changed, or 24 h passed (step 5). */
			kind: "gave_up";
			snapshotId: string;
			organizationId: string;
			/** The tuple last read; null for a request never dispatched. */
			expected: MergeSyncTuple | null;
			/** Written in place of an audit row; the card shows it. */
			failure: PullRequestFailure & {
				phase: "merge_sync";
				retryable: false;
			};
	  };

/**
 * Clears a MERGED row's merge-sync request (spec §9.1 steps 2 and 5),
 * conditional on `mergeSyncExpected` still being the tuple the caller
 * compared, the identity that fences both writes. An acknowledgment keeps
 * `mergeSyncRunId` and writes its `pull_request_merge_sync_requested` row in
 * the same transaction; a give-up writes its non-retryable `merge_sync`
 * failure, drops the run id and writes no audit row. The state stays MERGED
 * either way. False when the row moved.
 */
export async function clearMergeSyncRequest(
	i: ClearMergeSyncRequestInput,
): Promise<boolean> {
	// The union is the contract; these checks hold it for a caller that
	// reached here through a cast.
	const loose = i as {
		kind: string;
		expected: MergeSyncTuple | null;
		audit?: RecordAuditInput | readonly RecordAuditInput[];
		failure?: PullRequestFailure;
	};
	let event: "merge_sync_acknowledged" | "merge_sync_given_up";
	if (loose.kind === "acknowledged") {
		event = "merge_sync_acknowledged";
		if (loose.expected === null || loose.expected === undefined) {
			throw new Error(
				"clearMergeSyncRequest: an acknowledgment names the receipt's (syncId, generation)",
			);
		}
		if (loose.failure !== undefined) {
			throw new Error(
				"clearMergeSyncRequest: an acknowledgment writes no failure",
			);
		}
	} else if (loose.kind === "gave_up") {
		event = "merge_sync_given_up";
		if (
			loose.failure?.retryable !== false ||
			loose.failure.phase !== "merge_sync"
		) {
			throw new Error(
				"clearMergeSyncRequest: a give-up writes a non-retryable merge_sync failure",
			);
		}
	} else {
		throw new Error(
			`clearMergeSyncRequest: unknown kind ${String(loose.kind)}`,
		);
	}
	const audits = auditsOf(loose.audit);
	assertExactAudits(event, "unchanged", audits);
	const stateWhere = pullRequestTransitionWhere(
		event,
		["MERGED"],
		"unchanged",
		null,
	);
	const expected = loose.expected;
	const failure = loose.failure;
	return db.$transaction(async (tx) => {
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: i.snapshotId,
				organizationId: i.organizationId,
				AND: [stateWhere],
				mergeSyncRequestedAt: { not: null },
				mergeSyncExpected: {
					equals:
						expected === null
							? Prisma.AnyNull
							: (expected as unknown as Prisma.InputJsonValue),
				},
			},
			data: {
				mergeSyncRequestedAt: null,
				mergeSyncDispatchedAt: null,
				...(failure
					? {
							mergeSyncRunId: null,
							pullRequestFailure:
								failure as unknown as Prisma.InputJsonValue,
							pullRequestNextAttemptAt: null,
						}
					: {}),
			},
		});
		if (count !== 1) {
			return false;
		}
		for (const a of audits) {
			await recordAuditTx(tx, a);
		}
		return true;
	});
}

/** `mergeSyncExpected` as a Prisma JSON filter: null matches a never-dispatched request. */
function expectedFilter(expected: MergeSyncTuple | null) {
	return {
		equals:
			expected === null
				? Prisma.AnyNull
				: (expected as unknown as Prisma.InputJsonValue),
	};
}

/**
 * Spec §9.1 step 3: the one conditional write before the starter is called.
 * On a MERGED row that still carries its request and whose
 * `mergeSyncExpected` is still `lastExpected` (the tuple the dispatcher
 * read), it sets `mergeSyncDispatchedAt`, the tuple about to be passed as
 * `expected`, the next attempt (the dispatch backoff) and forgets the
 * previous run id. False when another dispatcher or a clear moved first.
 */
export async function markMergeSyncDispatched(i: {
	snapshotId: string;
	organizationId: string;
	lastExpected: MergeSyncTuple | null;
	next: MergeSyncTuple;
	dispatchedAt: Date;
	nextAttemptAt: Date;
}): Promise<boolean> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: i.snapshotId,
			organizationId: i.organizationId,
			pullRequestState: "MERGED",
			mergeSyncRequestedAt: { not: null },
			mergeSyncExpected: expectedFilter(i.lastExpected),
		},
		data: {
			mergeSyncDispatchedAt: i.dispatchedAt,
			mergeSyncExpected: i.next as unknown as Prisma.InputJsonValue,
			mergeSyncRunId: null,
			pullRequestNextAttemptAt: i.nextAttemptAt,
		},
	});
	return count === 1;
}

/**
 * Spec §9.1 step 3: the Temporal run id the starter reached, for either
 * outcome, conditional on the dispatch this caller marked. Clears a
 * previous `SYNC_START_FAILED`. False when the row moved.
 */
export async function recordMergeSyncRun(i: {
	snapshotId: string;
	organizationId: string;
	expected: MergeSyncTuple;
	runId: string;
}): Promise<boolean> {
	const { count } = await db.projectInstructionSnapshot.updateMany({
		where: {
			id: i.snapshotId,
			organizationId: i.organizationId,
			pullRequestState: "MERGED",
			mergeSyncRequestedAt: { not: null },
			mergeSyncDispatchedAt: { not: null },
			mergeSyncExpected: expectedFilter(i.expected),
		},
		data: { mergeSyncRunId: i.runId, pullRequestFailure: Prisma.DbNull },
	});
	return count === 1;
}

// ---------------------------------------------------------------------------
// The operation activities' reads and composite writes (spec §6.1, §6.2)
// ---------------------------------------------------------------------------

const PROPOSAL_OPERATION_SELECT = {
	id: true,
	projectId: true,
	organizationId: true,
	userId: true,
	version: true,
	status: true,
	rejection: true,
	proposalStatus: true,
	proposalDestination: true,
	baseSnapshotId: true,
	createdAt: true,
	pullRequestOperationId: true,
	pullRequestState: true,
	pullRequestAttempt: true,
	pullRequestContext: true,
	pullRequestHeadSha: true,
	pullRequestRef: true,
	pullRequestAttempts: true,
	pullRequestUrl: true,
	pullRequestExternalId: true,
	pullRequestObservation: true,
	pullRequestFailure: true,
	pullRequestLastCheckedAt: true,
	pullRequestNextAttemptAt: true,
	mergeSyncRequestedAt: true,
	mergeSyncDispatchedAt: true,
	mergeSyncRunId: true,
	mergeSyncExpected: true,
} satisfies Prisma.ProjectInstructionSnapshotSelect;

export type ProposalOperationRow = Prisma.ProjectInstructionSnapshotGetPayload<{
	select: typeof PROPOSAL_OPERATION_SELECT;
}> & {
	/**
	 * The database clock when the row was read (UTC, as the timestamp
	 * columns store it). Every due decision an activity makes from this row
	 * (a confirmation, the 24 h create rule, a merge-sync backoff) compares
	 * with this, never with the worker's clock (Review Focus 4).
	 */
	databaseNow: Date;
};

/**
 * One proposal operation, scoped to its project and organization (spec
 * §13.5), with the database clock read beside it. Null when no such row.
 */
export async function getProposalOperation(i: {
	snapshotId: string;
	projectId: string;
	organizationId: string;
}): Promise<ProposalOperationRow | null> {
	const [row, clock] = await Promise.all([
		db.projectInstructionSnapshot.findFirst({
			where: {
				id: i.snapshotId,
				projectId: i.projectId,
				organizationId: i.organizationId,
			},
			select: PROPOSAL_OPERATION_SELECT,
		}),
		db.$queryRaw<
			Array<{ now: Date }>
		>`SELECT (now() AT TIME ZONE 'UTC') AS "now"`,
	]);
	if (!row) {
		return null;
	}
	return { ...row, databaseNow: clock[0]?.now ?? new Date() };
}

type TransitionInput = Parameters<typeof transitionPullRequest>[0];
type WriteAttemptRecordInput = Parameters<typeof writeAttemptRecord>[0];

/** Rolls a composite change back when one of its parts matched nothing. */
class PullRequestChangeRefused extends Error {}

/**
 * Several record writes and at most one transition as ONE transaction (spec
 * §4.1 "every record write runs in a transaction holding the row lock";
 * §4.4 "audit rows are written in the same transaction"): a receipt clears
 * its record's create marker with the state change, a settlement stamps each
 * owned record with the `settled` transition, a confirmation counts its
 * record with the terminal change it causes. The records are written first,
 * so a record fenced on the row's current state sees it before the
 * transition moves it. Any part that matches nothing rolls back every part;
 * `{ ok: false }` then means another actor moved first.
 */
export async function applyPullRequestChange(i: {
	snapshotId: string;
	organizationId: string;
	records?: ReadonlyArray<
		Omit<WriteAttemptRecordInput, "snapshotId" | "organizationId">
	>;
	transition?: Omit<TransitionInput, "snapshotId" | "organizationId">;
}): Promise<{ ok: true; attempt: number | null } | { ok: false }> {
	try {
		return await db.$transaction(async (tx) => {
			for (const record of i.records ?? []) {
				const written = await writeAttemptRecord(
					{
						...record,
						snapshotId: i.snapshotId,
						organizationId: i.organizationId,
					},
					tx,
				);
				if (!written) {
					throw new PullRequestChangeRefused();
				}
			}
			if (!i.transition) {
				return { ok: true as const, attempt: null };
			}
			const moved = await transitionPullRequest(
				{
					...i.transition,
					snapshotId: i.snapshotId,
					organizationId: i.organizationId,
				},
				tx,
			);
			if (!moved.ok) {
				throw new PullRequestChangeRefused();
			}
			return { ok: true as const, attempt: moved.attempt };
		});
	} catch (error) {
		if (error instanceof PullRequestChangeRefused) {
			return { ok: false };
		}
		throw error;
	}
}

/**
 * Spec §6.1 step 5: stores the frozen commit's SHA, conditional on the row
 * still being OPENING at the claimed attempt and holding no SHA or this
 * SHA, and records the operation's current branch the first time (admission
 * leaves `pullRequestRef` empty; the sweeper's Recover clause reads it).
 * `mismatch` means another SHA is stored, which a reproducible build never
 * produces (GIT_FAILED, non-retryable); `moved` means the row is no longer
 * this attempt's.
 */
export async function storePullRequestHeadSha(i: {
	snapshotId: string;
	organizationId: string;
	attempt: number;
	sha: string;
	ref: string;
}): Promise<"stored" | "mismatch" | "moved"> {
	return db.$transaction(async (tx) => {
		const locked = await lockSnapshotClock(
			tx,
			i.snapshotId,
			i.organizationId,
		);
		if (!locked) {
			return "moved";
		}
		const row = await tx.projectInstructionSnapshot.findFirst({
			where: { id: i.snapshotId, organizationId: i.organizationId },
			select: {
				pullRequestState: true,
				pullRequestAttempt: true,
				pullRequestHeadSha: true,
				pullRequestRef: true,
			},
		});
		if (
			!row ||
			row.pullRequestState !== "OPENING" ||
			row.pullRequestAttempt !== i.attempt
		) {
			return "moved";
		}
		if (
			row.pullRequestHeadSha !== null &&
			row.pullRequestHeadSha !== i.sha
		) {
			return "mismatch";
		}
		if (row.pullRequestHeadSha === i.sha && row.pullRequestRef !== null) {
			return "stored";
		}
		const { count } = await tx.projectInstructionSnapshot.updateMany({
			where: {
				id: i.snapshotId,
				organizationId: i.organizationId,
				pullRequestState: "OPENING",
				pullRequestAttempt: i.attempt,
			},
			data: {
				pullRequestHeadSha: i.sha,
				...(row.pullRequestRef === null
					? { pullRequestRef: i.ref }
					: {}),
				...keepValidatingClock(locked),
			},
		});
		return count === 1 ? "stored" : "moved";
	});
}
