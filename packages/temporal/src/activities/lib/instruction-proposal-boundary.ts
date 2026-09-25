/**
 * The proposal pull-request activities' failure plumbing (Fizzy #2563 spec
 * §6, §11): the typed failure a step throws, the one writer that records a
 * failure on the row (an open-failure move to BLOCKED at the claimed
 * attempt, or failure-only everywhere else, spec §4.4), and the boundary
 * that turns any unclassified exception into `UNEXPECTED`.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import {
	getProposalOperation,
	type InstructionPullRequestFailureCode,
	nextRetryDelayMs,
	type Prisma,
	type ProposalOperationRow,
	type PullRequestFailure,
	type PullRequestPhase,
	transitionPullRequest,
} from "@repo/database";
import { logger } from "@repo/logs";
import { CancelledFailure, Context } from "@temporalio/activity";
import type { ProposalActivityDeadline } from "../../lib/instruction-proposal-pull-request-types";
import { withHeartbeatTicker } from "./activity-liveness";

const MINUTE_MS = 60 * 1000;

/**
 * A classified failure (spec §11). Steps throw it and the activity records
 * it; its message is fixed per code and it carries no provider text, URL,
 * token or cause.
 */
export class ProposalStepFailure extends Error {
	readonly code: InstructionPullRequestFailureCode;
	readonly phase: PullRequestPhase;
	readonly retryable: boolean;
	readonly retryAfterSeconds?: number;
	readonly params: Record<string, string | number | boolean>;
	/** Create recovery's clock (spec §6.1): the oldest marker's age and the recoveries so far. */
	readonly markerAgeMs?: number;
	readonly recoveries?: number;
	/**
	 * A delay that overrides the code's own, for a failure recorded as not
	 * retryable whose row is still revisited (a cancel keeps looking at a
	 * conflicting branch every 6 h, spec §6.2).
	 */
	readonly nextAttemptDelayMs?: number;

	constructor(input: {
		code: InstructionPullRequestFailureCode;
		phase: PullRequestPhase;
		retryable: boolean;
		retryAfterSeconds?: number;
		params?: Record<string, string | number | boolean>;
		markerAgeMs?: number;
		recoveries?: number;
		nextAttemptDelayMs?: number;
	}) {
		super(`Proposal pull-request step failed (${input.code})`);
		this.name = "ProposalStepFailure";
		this.code = input.code;
		this.phase = input.phase;
		this.retryable = input.retryable;
		this.params = input.params ?? {};
		if (input.retryAfterSeconds !== undefined) {
			this.retryAfterSeconds = input.retryAfterSeconds;
		}
		if (input.markerAgeMs !== undefined) {
			this.markerAgeMs = input.markerAgeMs;
		}
		if (input.recoveries !== undefined) {
			this.recoveries = input.recoveries;
		}
		if (input.nextAttemptDelayMs !== undefined) {
			this.nextAttemptDelayMs = input.nextAttemptDelayMs;
		}
	}
}

/**
 * The attempt reached its cooperative deadline (see `proposalDeadlineMs`):
 * it stops issuing effects and ends before Temporal's own timeout would,
 * so a retry or a later sweeper tick never runs beside it. Rethrown like a
 * cancellation, never recorded on the row: every write it skipped is
 * fenced, and the next attempt resumes from what the row and remote say.
 */
export class ProposalDeadlineExceeded extends Error {
	constructor() {
		super("Instruction proposal activity reached its deadline");
		this.name = "ProposalDeadlineExceeded";
	}
}

/**
 * How long before its earliest timeout an attempt stops: the time the last
 * call's abort, the git process group's kill and the failure report take,
 * plus the gap between Temporal starting the attempt and the function
 * running. As the repository poll's check does (#2540 Decision 50).
 */
const PROPOSAL_DEADLINE_MARGIN_MS = 10_000;

/**
 * The absolute time (worker clock, epoch ms) this attempt must stop issuing
 * effects by: the earliest of its start-to-close, its schedule-to-close and
 * the caller's `deadlineAt`, less the margin. Start-to-close is measured
 * from the current attempt's scheduled time, as the context sync's budget
 * does (`remainingSyncBudgetMs`): a late entry into this function is never
 * granted again, and the bound is at or before Temporal's own. Infinite
 * outside an activity with no `deadlineAt`.
 */
function proposalDeadlineMs(
	input: ProposalActivityDeadline,
	nowMs: number = Date.now(),
): number {
	const bounds: number[] = [];
	try {
		const info = Context.current().info;
		if (info.startToCloseTimeoutMs > 0) {
			const attemptScheduled = Number.isFinite(
				info.currentAttemptScheduledTimestampMs,
			)
				? info.currentAttemptScheduledTimestampMs
				: nowMs;
			bounds.push(attemptScheduled + info.startToCloseTimeoutMs);
		}
		if (info.scheduleToCloseTimeoutMs > 0) {
			bounds.push(
				info.scheduledTimestampMs + info.scheduleToCloseTimeoutMs,
			);
		}
	} catch {
		// Not inside an activity, or no timing info (unit tests).
	}
	if (input.deadlineAt !== undefined) {
		const at = Date.parse(input.deadlineAt);
		if (Number.isFinite(at)) {
			bounds.push(at);
		}
	}
	return bounds.length === 0
		? Number.POSITIVE_INFINITY
		: Math.min(...bounds) - PROPOSAL_DEADLINE_MARGIN_MS;
}

type AttemptScope = { signal: AbortSignal; deadlineMs: number };
const attemptScopes = new AsyncLocalStorage<AttemptScope>();

function contextCancellationSignal(): AbortSignal {
	try {
		return Context.current().cancellationSignal;
	} catch {
		return new AbortController().signal;
	}
}

function heartbeatDeclared(): boolean {
	try {
		return (Context.current().info.heartbeatTimeoutMs ?? 0) > 0;
	} catch {
		return false;
	}
}

/**
 * Runs one attempt under its cooperative deadline: `activityCancellationSignal`
 * inside `fn` fires on Temporal's cancellation OR at the deadline, every git
 * and provider call takes that signal, and `assertMayContinue` stops the
 * next one from starting. When the activity declares a heartbeat timeout it
 * heartbeats on a ticker throughout, so a dead worker is noticed and a
 * cancellation is delivered.
 */
export async function withProposalDeadline<T>(
	input: ProposalActivityDeadline,
	fn: () => Promise<T>,
): Promise<T> {
	const deadlineMs = proposalDeadlineMs(input);
	const leftMs = deadlineMs - Date.now();
	const deadline = new AbortController();
	let timer: ReturnType<typeof setTimeout> | null = null;
	if (leftMs <= 0) {
		// A retry scheduled past the deadline issues nothing at all.
		deadline.abort(new ProposalDeadlineExceeded());
	} else if (Number.isFinite(leftMs)) {
		timer = setTimeout(
			() => deadline.abort(new ProposalDeadlineExceeded()),
			leftMs,
		);
		timer.unref?.();
	}
	const signal = AbortSignal.any([
		contextCancellationSignal(),
		deadline.signal,
	]);
	const run = () => attemptScopes.run({ signal, deadlineMs }, fn);
	try {
		return heartbeatDeclared()
			? await withHeartbeatTicker(run)
			: await run();
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

/**
 * The signal every git and provider call of this attempt takes: Temporal's
 * cancellation, and, inside `withProposalDeadline`, the attempt's deadline.
 * Outside an activity (unit tests) it never fires.
 */
export function activityCancellationSignal(): AbortSignal {
	return attemptScopes.getStore()?.signal ?? contextCancellationSignal();
}

function stopReason(signal: AbortSignal): unknown {
	const reason: unknown = signal.reason;
	return reason instanceof CancelledFailure ||
		reason instanceof ProposalDeadlineExceeded
		? reason
		: new CancelledFailure("Instruction proposal activity cancelled");
}

/**
 * Throws the stop reason when the attempt is cancelled or past its
 * deadline. Called before every git or provider call and before a write
 * that commits the next effect (the create marker, the merge-sync mark), so
 * nothing new starts once the attempt must stop.
 */
export function assertMayContinue(
	signal: AbortSignal = activityCancellationSignal(),
): void {
	if (signal.aborted) {
		throw stopReason(signal);
	}
}

/**
 * Stops the attempt before a step it cannot abandon once begun (a token
 * refresh, a status write and its notification) unless that step's worst
 * case, `boundMs`, still ends before the attempt's deadline. Also throws
 * the stop once the attempt is cancelled or past its deadline. Unbounded
 * outside `withProposalDeadline`.
 */
export function assertTimeFor(
	boundMs: number,
	signal: AbortSignal = activityCancellationSignal(),
): void {
	timeGate(boundMs, signal)();
}

/**
 * `assertTimeFor` as a check a helper runs later, such as a credential
 * helper's pre-exchange gate consulted under a provider lock. The attempt's
 * deadline is captured now, not looked up when the check runs, so a check
 * called from outside this attempt's async context (a driver callback, a
 * shared single flight) is still held to it rather than passing unbounded.
 */
export function timeGate(
	boundMs: number,
	signal: AbortSignal = activityCancellationSignal(),
): () => void {
	const scope = attemptScopes.getStore();
	return () => {
		assertMayContinue(signal);
		if (scope && scope.deadlineMs - Date.now() < boundMs) {
			throw new ProposalDeadlineExceeded();
		}
	};
}

/**
 * The stop to rethrow, when the attempt was cancelled or reached its
 * deadline: Temporal must see the `CancelledFailure` (or the deadline)
 * itself, never a failure recorded in its place (spec §6).
 */
export function cancellationOf(error: unknown): unknown | null {
	if (
		error instanceof CancelledFailure ||
		error instanceof ProposalDeadlineExceeded
	) {
		return error;
	}
	const signal = activityCancellationSignal();
	if (signal.aborted) {
		const reason: unknown = signal.reason;
		return reason instanceof CancelledFailure ||
			reason instanceof ProposalDeadlineExceeded
			? reason
			: error;
	}
	return null;
}

/** The only thing an unclassified error may leave in a log: its class name (spec §6). */
export function errorClassName(error: unknown): string {
	if (error instanceof Error) {
		return error.constructor?.name || error.name || "Error";
	}
	return typeof error;
}

/**
 * The next automatic attempt, from the database clock read with the row
 * (Review Focus 4), or null when a human must act.
 */
export function nextAttemptAt(
	row: Pick<ProposalOperationRow, "databaseNow">,
	failure: {
		code: InstructionPullRequestFailureCode;
		retryable: boolean;
		retryAfterSeconds?: number;
		markerAgeMs?: number;
		recoveries?: number;
		nextAttemptDelayMs?: number;
	},
): Date | null {
	if (failure.nextAttemptDelayMs !== undefined) {
		return new Date(row.databaseNow.getTime() + failure.nextAttemptDelayMs);
	}
	if (!failure.retryable) {
		return null;
	}
	const delay =
		nextRetryDelayMs(failure.code, {
			retryAfterSeconds: failure.retryAfterSeconds,
			markerAgeMs: failure.markerAgeMs,
			recoveries: failure.recoveries,
		}) ?? 15 * MINUTE_MS;
	return new Date(row.databaseNow.getTime() + delay);
}

export function failureJson(
	f: Pick<ProposalStepFailure, "code" | "phase" | "retryable" | "params">,
): PullRequestFailure {
	return {
		phase: f.phase,
		code: f.code,
		retryable: f.retryable,
		at: new Date().toISOString(),
		params: f.params,
	};
}

export const asJson = (value: unknown) =>
	value as unknown as Prisma.InputJsonValue;

/** What `recordProposalFailure` reads from a step failure. */
type FailureToRecord = Pick<
	ProposalStepFailure,
	| "code"
	| "phase"
	| "retryable"
	| "retryAfterSeconds"
	| "params"
	| "markerAgeMs"
	| "recoveries"
	| "nextAttemptDelayMs"
>;

/**
 * Records a failure (spec §4.4): with `claimedAttempt`, the open activity's
 * move from OPENING to BLOCKED at that attempt; otherwise failure-only at the
 * state and attempt the row holds now. False when the row moved first, which
 * writes nothing.
 */
export async function recordProposalFailure(
	row: ProposalOperationRow,
	failure: FailureToRecord,
	mode: { claimedAttempt?: number },
): Promise<boolean> {
	const data = {
		pullRequestFailure: asJson(failureJson(failure)),
		pullRequestNextAttemptAt: nextAttemptAt(row, failure),
	};
	if (mode.claimedAttempt !== undefined) {
		const moved = await transitionPullRequest({
			snapshotId: row.id,
			organizationId: row.organizationId,
			event: "open_failure",
			from: ["OPENING"],
			expectedAttempt: mode.claimedAttempt,
			to: "BLOCKED",
			bumpAttempt: false,
			data,
		});
		return moved.ok;
	}
	if (row.pullRequestState === null) {
		return false;
	}
	const moved = await transitionPullRequest({
		snapshotId: row.id,
		organizationId: row.organizationId,
		event: "failure",
		from: [row.pullRequestState],
		expectedAttempt: row.pullRequestAttempt,
		to: "unchanged",
		bumpAttempt: false,
		data,
	});
	return moved.ok;
}

/** What the boundary knows about the activity it wraps, updated as it runs. */
export type BoundaryScope = {
	phase: PullRequestPhase;
	/** Set once the open activity's claim succeeded. */
	claimedAttempt?: number;
};

type OperationIds = {
	snapshotId: string;
	projectId: string;
	organizationId: string;
};

/**
 * Wraps an operation activity (spec §6) in its cooperative deadline
 * (`withProposalDeadline`): a `CancelledFailure` or the deadline is rethrown;
 * any other exception becomes `UNEXPECTED` (retryable, params `{ phase }`),
 * recorded on the row per `recordProposalFailure`, and the activity returns
 * `unexpected`, its typed outcome for that case. Only the error's class
 * name is logged: never its message, body or cause. When even the record
 * cannot be written, a sanitized error is thrown for Temporal's retry.
 */
export function proposalActivityBoundary<
	I extends OperationIds & ProposalActivityDeadline,
	R,
>(
	phase: PullRequestPhase,
	unexpected: R,
	fn: (input: I, scope: BoundaryScope) => Promise<R>,
): (input: I) => Promise<R> {
	return async (input: I): Promise<R> =>
		withProposalDeadline(input, () => boundary(input));

	async function boundary(input: I): Promise<R> {
		const scope: BoundaryScope = { phase };
		try {
			assertMayContinue();
			return await fn(input, scope);
		} catch (error) {
			const cancelled = cancellationOf(error);
			if (cancelled) {
				if (cancelled instanceof ProposalDeadlineExceeded) {
					logger.warn(
						{
							event: "instruction_proposal.deadline",
							phase: scope.phase,
						},
						"Instruction proposal activity stopped at its deadline",
					);
				}
				throw cancelled;
			}
			logger.warn(
				{
					event: "instruction_proposal.unexpected",
					phase: scope.phase,
					errorClass: errorClassName(error),
				},
				"Instruction proposal activity failed",
			);
			try {
				const row = await getProposalOperation(input);
				if (row) {
					await recordProposalFailure(
						row,
						new ProposalStepFailure({
							code: "UNEXPECTED",
							phase: scope.phase,
							retryable: true,
							params: { phase: scope.phase },
						}),
						{ claimedAttempt: scope.claimedAttempt },
					);
				}
			} catch (recordError) {
				const cancelledAgain = cancellationOf(recordError);
				if (cancelledAgain) {
					throw cancelledAgain;
				}
				logger.warn(
					{
						event: "instruction_proposal.unexpected_unrecorded",
						phase: scope.phase,
						errorClass: errorClassName(recordError),
					},
					"Instruction proposal failure could not be recorded",
				);
				throw new Error(
					"Instruction proposal activity failed (UNEXPECTED)",
				);
			}
			return unexpected;
		}
	}
}
