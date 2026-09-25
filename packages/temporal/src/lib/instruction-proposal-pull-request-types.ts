/**
 * The vocabulary the Coding Instructions proposal pull-request workflow and
 * its sweeper share with their activities (Fizzy #2563 spec §6, §9).
 *
 * The workflow bundle imports this file, so it must stay pure: no runtime
 * imports, no I/O, nothing that reads the clock or the environment.
 * Payloads carry ids, states and codes only (spec §6).
 */

/** The operation workflow's input, and every operation activity's ids. */
export type ProposalOperationInput = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	operationId: string;
	/** A human "Retry opening" (spec §12) names the attempt it observed. */
	retryCreate?: { expectedAttempt: number };
};

/**
 * An absolute deadline a caller hands an activity (#2540's poll pattern):
 * the sweeper passes the end of its budget, so an attempt stops issuing
 * effects before the tick ends. The activity also honours its own
 * start-to-close and schedule-to-close, whichever comes first.
 */
export type ProposalActivityDeadline = {
	/** ISO timestamp; the attempt stops 10 s before it (`withProposalDeadline`). */
	deadlineAt?: string;
};

/**
 * The open activity's input: the attempt readiness observed with its READY
 * verdict, which the claim compares under the row lock (plan Decision 7).
 */
export type OpenProposalOperationInput = ProposalOperationInput & {
	expectedAttempt: number;
};

export type ProposalReadinessInput = ProposalOperationInput & {
	/** The workflow's 6 h validation clock ran out (spec §6 step 1). */
	deadlineReached?: boolean;
};

export type ProposalReadinessResult =
	| { kind: "ready"; attempt: number }
	| { kind: "pending"; validationFailed: boolean }
	| { kind: "stop" };

export type OpenProposalResult = {
	kind: "open" | "terminal" | "close_requested" | "blocked" | "not_claimable";
};

/**
 * The recover activity's input. The sweeper passes the attempt it read at
 * selection (`DueItem.attempt`); a row that moved since is left alone.
 */
export type RecoverProposalInput = ProposalOperationInput &
	ProposalActivityDeadline & {
		expectedAttempt?: number;
	};

/**
 * Recovery's answer. `close_requested` means the row was cancelled: the
 * sweeper runs close for it (spec §9, Recover's action).
 */
export type RecoverProposalResult = {
	kind:
		| "adopted"
		| "absent_handoff"
		| "unchanged"
		| "blocked"
		| "failed"
		| "close_requested";
	/** A provider rate limit: the sweeper skips this integration for the tick. */
	rateLimitedIntegrationId?: string;
};

/**
 * Close's input. The sweeper passes the attempt it read at selection
 * (`DueItem.attempt`), so two ticks holding one observation cannot both
 * claim; the operation workflow omits it and close uses the attempt it
 * reads.
 */
export type CloseProposalInput = ProposalOperationInput &
	ProposalActivityDeadline & {
		expectedAttempt?: number;
	};

export type CloseProposalResult = {
	kind: "closed" | "canceled" | "merged" | "pending" | "failed";
	rateLimitedIntegrationId?: string;
};

/** The Observe sub-batch's input: the attempt read at selection fences it. */
export type ReconcileProposalInput = ProposalOperationInput &
	ProposalActivityDeadline & {
		expectedAttempt?: number;
	};

export type ReconcileProposalResult = {
	kind: "open" | "merged" | "closed" | "unchanged" | "failed";
	rateLimitedIntegrationId?: string;
};

/** The merge-sync dispatcher's input: the ids and the sweeper's deadline. */
export type MergeSyncDispatchInput = ProposalOperationInput &
	ProposalActivityDeadline;

/** The merge-sync dispatcher's answer (spec §9.1). */
export type MergeSyncDispatchResult = {
	kind:
		| "idle"
		| "waiting"
		| "acknowledged"
		| "dispatched"
		| "failed"
		| "gave_up"
		| "moved";
};

/** The five sub-batch limits (spec §9). */
export type ProposalSweepLimits = {
	close: number;
	recover: number;
	mergeSync: number;
	observe: number;
	restart: number;
};

/**
 * One selected row: ids, the attempt read at selection, the integration
 * rate limiting groups by, and whether its operation workflow is running.
 */
export type ProposalSweepItem = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	operationId: string;
	attempt: number;
	integrationId: string | null;
	/** Recover only: which of spec §9's two clauses selected the row. */
	recoverClause?: 1 | 2;
	running: boolean;
};

export type DueProposalSweep = {
	close: ProposalSweepItem[];
	recover: ProposalSweepItem[];
	mergeSync: ProposalSweepItem[];
	observe: ProposalSweepItem[];
	restart: ProposalSweepItem[];
};

/** Restart's input: the ids, the attempt read at selection and the sweeper's deadline. */
export type DispatchProposalInput = ProposalActivityDeadline & {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	operationId: string;
	attempt: number;
};

export type DispatchProposalResult = {
	kind: "started" | "deferred" | "already_running";
};

// ---------------------------------------------------------------------------
// The operation workflow and the sweeper (spec §6, §9)
// ---------------------------------------------------------------------------

/**
 * The operation workflow's sleeps between `pending` readiness answers, in
 * seconds; the last repeats (spec §6 step 1).
 */
export const PROPOSAL_READINESS_SLEEPS_S: readonly number[] = [
	5, 10, 20, 40, 60,
];

/**
 * Readiness calls one run of the operation workflow makes before it
 * continues as new, so a long validation (the 6 h clock restarts on every
 * transition into FAILED) never grows one history without bound: about
 * 2,200 events a run, far under Temporal's limits.
 */
export const PROPOSAL_READINESS_CALLS_PER_RUN = 200;

/**
 * What a continued run of the operation workflow resumes readiness from:
 * the validation clock's absolute deadline (workflow time, epoch ms),
 * whether the last answer was FAILED (so the next FAILED answer is no new
 * transition), and how many `pending` answers came before (the sleep
 * index).
 */
export type ProposalReadinessCarry = {
	deadlineMs: number;
	wasFailed: boolean;
	pendingAnswers: number;
};

/**
 * The operation workflow's input: the operation's ids, and on a continued
 * run the readiness state it resumes from. Never passed to an activity.
 */
export type ProposalOperationWorkflowInput = ProposalOperationInput & {
	readiness?: ProposalReadinessCarry;
};

/**
 * The validation clock: 6 h from the workflow's start, restarted when the
 * workflow observes a transition into FAILED (spec §4.4).
 */
export const PROPOSAL_VALIDATION_CLOCK_MS = 6 * 60 * 60 * 1000;

/**
 * Each activity's timeouts (spec §6), in ms, shared by the operation
 * workflow and the sweeper; retry is 3 attempts, 10 s, backoff 2
 * throughout. Every attempt also stops itself 10 s before its earliest
 * bound (`withProposalDeadline`), so no call outlives the attempt and a
 * retry never runs beside it. A declared heartbeat is kept by a ticker for
 * the whole attempt.
 *
 * Close is sized for the longest documented settlement at per-call
 * ceilings (lookup and close 20 s, ls-remote 30 s, delete 30 s, token
 * 20 s): due confirmations, three lookup passes (get, one `findOperation`
 * per record, a close per open pull request) and two deletion passes (an
 * ls-remote and a delete per record, the second for Azure DevOps's refusal)
 * come to about 320 s for one record and 520 s for two. Recover (due
 * confirmations, then get, lookups and ls-remote) and reconcile (due
 * confirmations, then one get) are smaller. An extra page, a hung delete
 * or the re-exchange's second credential pass can still reach the bound:
 * the attempt then stops at its deadline and the retry, or the next tick,
 * resumes from the row's fenced records. In the sweeper every call's
 * schedule-to-close is also the budget left, so none outlives the tick.
 */
export const PROPOSAL_ACTIVITY_TIMEOUTS = {
	readiness: { startToCloseMs: 30_000 },
	open: { startToCloseMs: 15 * 60_000, heartbeatMs: 60_000 },
	close: { startToCloseMs: 10 * 60_000, heartbeatMs: 60_000 },
	recover: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	reconcile: { startToCloseMs: 3 * 60_000, heartbeatMs: 60_000 },
	mergeSync: { startToCloseMs: 60_000, heartbeatMs: 30_000 },
	dispatch: { startToCloseMs: 60_000, heartbeatMs: 30_000 },
	select: { startToCloseMs: 60_000 },
	defer: { startToCloseMs: 60_000 },
} as const;

/** How the operation workflow ended, for its history and its tests. */
export type ProposalOperationWorkflowResult =
	| { readiness: "stop" }
	| {
			readiness: "ready";
			opened: OpenProposalResult["kind"];
			closed?: CloseProposalResult["kind"];
	  };

/** The five sub-batch limits of one sweeper tick (spec §9 table). */
export const PROPOSAL_SWEEP_LIMITS: ProposalSweepLimits = {
	close: 10,
	recover: 10,
	mergeSync: 10,
	observe: 20,
	restart: 10,
};

/** One sweeper tick's budget (spec §9); the schedule's 270 s timeout outlasts it. */
export const PROPOSAL_SWEEP_BUDGET_MS = 4 * 60 * 1000;

/** No item starts with less than this left of the budget (spec §9). */
export const PROPOSAL_SWEEP_RESERVE_MS = 30 * 1000;

/** Items in flight at once (spec §9). */
export const PROPOSAL_SWEEP_CONCURRENCY = 4;

/** What one sweeper tick did. */
export type ProposalSweepResult = {
	/** Rows the selection returned, across the five sub-batches. */
	selected: number;
	/** Items whose action ran to an answer. */
	processed: number;
	/** Rows whose operation workflow was running: deferred 30 min. */
	deferred: number;
	/** Items skipped because their integration was rate limited this tick. */
	rateLimited: number;
	/** Items left for the next tick: under 30 s of the budget remained. */
	outOfBudget: number;
	/** Items whose activity threw after its retries. */
	failed: number;
	/** The selection threw after its retries; nothing else ran. */
	selectFailed: boolean;
};
