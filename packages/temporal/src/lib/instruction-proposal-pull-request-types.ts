/**
 * The vocabulary the Coding Instructions proposal sweeper shares with its
 * activities (Fizzy #2563 spec §6, §9), and the readiness vocabulary the
 * member proposal branch reuses. #2563's per-proposal operation workflow was
 * retired (Fizzy #2748); the operation-lane types below stay because a
 * sweeper tick recorded before that retirement still replays through its
 * lane (`V1_LANE_REMOVED_PATCH`), against the retired activities' stubs.
 *
 * The workflow bundle imports this file, so it must stay pure: no runtime
 * imports, no I/O, nothing that reads the clock or the environment.
 * Payloads carry ids, states and codes only (spec §6).
 */

/** Every operation activity's ids. */
export type ProposalOperationInput = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
	operationId: string;
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

export type ProposalReadinessInput = ProposalOperationInput & {
	/** The 6 h validation clock ran out (spec §6 step 1). */
	deadlineReached?: boolean;
};

export type ProposalReadinessResult =
	| { kind: "ready"; attempt: number }
	| { kind: "pending"; validationFailed: boolean }
	| { kind: "stop" };

/**
 * The recover activity's input. The sweeper passes the attempt it read at
 * selection; a row that moved since is left alone.
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
 * Close's input. The sweeper passes the attempt it read at selection, so
 * two ticks holding one observation cannot both claim.
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
// Readiness and the sweeper (spec §6, §9)
// ---------------------------------------------------------------------------

/**
 * The sleeps between `pending` readiness answers, in seconds; the last
 * repeats (spec §6 step 1). The member proposal branch workflow waits on
 * these.
 */
export const PROPOSAL_READINESS_SLEEPS_S: readonly number[] = [
	5, 10, 20, 40, 60,
];

/**
 * The validation clock: 6 h, restarted on every transition into FAILED
 * (spec §4.4).
 */
export const PROPOSAL_VALIDATION_CLOCK_MS = 6 * 60 * 60 * 1000;

/**
 * The sweeper's activity timeouts (spec §6), in ms; retry is 3 attempts,
 * 10 s, backoff 2 throughout. Every attempt also stops itself 10 s before
 * its earliest bound (`withProposalDeadline`), so no call outlives the
 * attempt and a retry never runs beside it. A declared heartbeat is kept by
 * a ticker for the whole attempt. In the sweeper every call's
 * schedule-to-close is also the budget left, so none outlives the tick.
 *
 * The close, recover, reconcile, mergeSync, dispatch and defer entries size
 * #2563's retired operation lane. They are unchanged so a tick recorded
 * before that lane was retired (Fizzy #2748) schedules exactly what its
 * history recorded when it replays.
 */
export const PROPOSAL_ACTIVITY_TIMEOUTS = {
	close: { startToCloseMs: 10 * 60_000, heartbeatMs: 60_000 },
	recover: { startToCloseMs: 5 * 60_000, heartbeatMs: 60_000 },
	reconcile: { startToCloseMs: 3 * 60_000, heartbeatMs: 60_000 },
	mergeSync: { startToCloseMs: 60_000, heartbeatMs: 30_000 },
	dispatch: { startToCloseMs: 60_000, heartbeatMs: 30_000 },
	select: { startToCloseMs: 60_000 },
	defer: { startToCloseMs: 60_000 },
} as const;

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
