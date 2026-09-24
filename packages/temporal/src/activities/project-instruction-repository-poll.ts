/**
 * Automatic repository sync: the poll's activities (spec §6.1, §8.2). The
 * activities barrel re-exports exactly the three functions below. Each one
 * reaches a synced subject's table and workflow only through the subject's
 * adapter (./lib/repository-sync-subjects.ts, Decision 46), resolved by the
 * kind the claim carries; the git, temp-dir and registry helpers live in
 * ./lib. The repository read itself (integration, token, ls-remote) is the
 * same for every subject, because every subject follows a branch of a
 * connected repository.
 */
import {
	type ClaimedRepositorySyncRow,
	computeSchedulingPatch,
	db,
	getProjectRepoIntegration,
	type InstructionSyncPause,
	type InstructionSyncSchedulingEffect,
	type RepositorySyncFence,
	type RepositorySyncSubjectKind,
} from "@repo/database";
import { shouldStartAutomaticSync } from "@repo/instructions";
import { resolveFreshRepoToken } from "@repo/integrations";
import { logger } from "@repo/logs";
import type {
	ClaimedInstructionSyncCheck,
	InstructionSyncCheckInput,
	InstructionSyncCheckOutcome,
	InstructionSyncCheckResult,
} from "../lib/instruction-sync-types";
import {
	buildGitEnv,
	credentialFreeUrl,
	GitCommandError,
	gitUsernameFor,
	LS_REMOTE_TIMEOUT_MS,
	lsRemoteHead,
	type RemoteHead,
	redactSecrets,
} from "./lib/instruction-sync-git";
import type { RepositorySyncStartResult } from "./lib/instruction-sync-start";
import {
	createSyncRunDir,
	removeSyncRunDir,
	sweepStaleSyncRunDirs,
} from "./lib/instruction-sync-temp";
import { repositorySyncSubject } from "./lib/repository-sync-subjects";

/** Spec §6.1: a claim leases the row for two minutes. */
const CLAIM_LEASE_MS = 2 * 60 * 1000;
/**
 * After a start: the run's own completion writes the real outcome, so this
 * is only the fallback clock (the same 15 minutes as `NEXT_CHECK_AFTER_MS`
 * in `@repo/database`).
 */
const STARTED_RECHECK_MS = 15 * 60 * 1000;
/**
 * After `already_running` for a configuration nobody has evaluated yet (a
 * re-configure during a run): the open run will land NOT_PUBLISHED and move
 * nothing, so look again at the next tick rather than in 15 minutes
 * (Decision 34).
 */
const UNEVALUATED_RECHECK_MS = 2 * 60 * 1000;
/**
 * A check stops this long before its lease or the poll's budget ends,
 * whichever is first (Decision 50), so the one statement it has in flight
 * lands inside both.
 */
const CHECK_DEADLINE_MARGIN_MS = 5_000;

type WrittenEffect = Exclude<InstructionSyncSchedulingEffect, { kind: "none" }>;

/**
 * The stage a check was in when it threw (Fizzy #2684). Logged with the
 * sync's identifiers so an operator can tell a token problem from a
 * network one without recovering it from the receipt row; the error's
 * class only, never its message, which for git can carry a URL.
 */
type CheckStage =
	| "lease"
	| "permission"
	| "remote_head"
	| "record_failure"
	| "start"
	| "write_back";

/** A lease-fenced write a check makes, for the fence-rejection warning. */
type FencedWrite = "write_back" | "record_failure" | "reschedule";

/** Spec §8.2: the poll's first step removes clone directories older than an hour. */
export async function sweepInstructionSyncTempDirs(): Promise<{
	removed: number;
}> {
	return sweepStaleSyncRunDirs();
}

/**
 * Spec §6.1: lease up to `limit` of one subject's due rows, oldest due
 * first. Cross-tenant; see the subject's `listDueAndClaim`. This activity
 * passes only the lease's length: the database dates the lease from its own
 * clock, the one that judges whether it still holds (Decision 48), so a
 * worker whose clock drifts cannot write a lease that is already short or
 * expired (Fizzy #2683).
 */
export async function claimDueInstructionSyncChecks(input: {
	kind: RepositorySyncSubjectKind;
	limit: number;
}): Promise<ClaimedInstructionSyncCheck[]> {
	const rows = await repositorySyncSubject(input.kind).listDueAndClaim(db, {
		limit: input.limit,
		leaseMs: CLAIM_LEASE_MS,
	});
	// A Date does not survive a Temporal payload as a Date. The lease
	// travels as its ISO string, which keeps the milliseconds the
	// compare-and-set matches on (Decision 31), and the kind travels with
	// it so the check resolves the same subject.
	return rows.map((row) => ({
		...row,
		kind: input.kind,
		leaseUntil: row.leaseUntil.toISOString(),
	}));
}

/**
 * Spec §6.1: one claimed row, in this order.
 *
 * 1. The lease is still this check's (Decision 31); otherwise `stale`,
 *    before anything is read.
 * 2. The delegate may still publish the subject (spec §8.5, Decision 33);
 *    otherwise a FAILED / PERMISSION_DENIED receipt that pauses with
 *    PERMISSION_REVOKED, and no repository access at all.
 * 3. `ls-remote`, then the shared `shouldStartAutomaticSync`:
 *    - evaluated or suppressed: the cursor effect, 15 minutes out;
 *    - missing branch: a FAILED / REF_MISSING receipt that pauses the sync;
 *    - anything transient: backoff (Decision 20);
 *    - a moved head: start a POLL run FIRST, carrying the claimed row as
 *      `expected` (Decision 56), then a conditional reschedule
 *      (Decision 34). A run already open also gets a re-check request,
 *      settled against that run's receipt so a completion that already
 *      committed cannot leave it unread (Fizzy #2682).
 *
 * Every write goes through the subject and, but for the re-check request
 * and its settle, is fenced on the lease, so a check that outlived it writes
 * nothing and reports `stale`. A thrown error is left to the lease.
 *
 * The check also keeps its own deadline (Decision 50). Temporal's timeouts
 * make Temporal stop waiting for this activity; they do not stop its
 * JavaScript, which keeps running on the worker until it returns. So before
 * each stage that could have a side effect (the token, `ls-remote`, the
 * start, each write) it requires the database's time, calibrated from its
 * own first lease read (Fizzy #2683), to be more than
 * `CHECK_DEADLINE_MARGIN_MS` before its lease or the poll's budget ends,
 * and returns `stale` with nothing done when it is not. Its schedule writes
 * are dated on the same calibrated time.
 */
export async function checkInstructionSyncRemoteHead(
	input: InstructionSyncCheckInput,
): Promise<InstructionSyncCheckResult> {
	const stage: { current: CheckStage } = { current: "lease" };
	try {
		return await runRemoteHeadCheck(input, stage);
	} catch (error) {
		// The throw itself is left to the lease (above); this only names
		// where it happened, which the wrapped ActivityFailure does not.
		logger.error(
			{
				event: "instructions.sync.check_failed",
				kind: input.kind,
				syncId: input.id,
				projectId: input.projectId,
				organizationId: input.organizationId,
				stage: stage.current,
				errorClass: error instanceof Error ? error.name : typeof error,
			},
			"[InstructionSync] automatic check failed; its lease will expire",
		);
		throw error;
	}
}

async function runRemoteHeadCheck(
	input: InstructionSyncCheckInput,
	stage: { current: CheckStage },
): Promise<InstructionSyncCheckResult> {
	const subject = repositorySyncSubject(input.kind);
	const row: ClaimedRepositorySyncRow = {
		id: input.id,
		projectId: input.projectId,
		organizationId: input.organizationId,
		userId: input.userId,
		generation: input.generation,
		repositoryIntegrationId: input.repositoryIntegrationId,
		ref: input.ref,
		lastEvaluatedCommitSha: input.lastEvaluatedCommitSha,
		lastEvaluatedGeneration: input.lastEvaluatedGeneration,
		suppressedCommitSha: input.suppressedCommitSha,
		suppressedGeneration: input.suppressedGeneration,
		failureCount: input.failureCount,
		leaseUntil: new Date(input.leaseUntil),
	};
	const fence: RepositorySyncFence = {
		id: row.id,
		generation: row.generation,
		leaseUntil: row.leaseUntil,
	};
	// The first database read, before anything else: whether the lease still
	// holds, and the database's clock from the same statement (Fizzy #2683).
	// `leaseHeld` is the stale-lease guard before any remote access: it
	// compares the lease with the database's clock, the clock that dated it,
	// so a second `leaseUntil > now` test on this worker's clock would answer
	// nothing the database does not already answer.
	const lease = await subject.leaseHeld(db, fence);
	// This worker's offset from the database, measured here, on the worker
	// that uses it: Temporal gives the claim and the check no worker
	// affinity, so an offset measured by the claim could belong to another
	// clock. Measured once per check, authoritative to within the drift over
	// one two-minute lease plus this read's round trip; the second lease read
	// before the start does not refresh it. The fence still judges ownership
	// on Postgres's clock; this only dates the schedule this check writes and
	// places its deadline.
	const clockSkewMs = lease.dbNow.getTime() - Date.now();
	const dbNow = (): Date => new Date(Date.now() + clockSkewMs);
	// `inTime()` is `dbNow() < min(lease, budget end) - margin`, kept as a
	// stop time on this worker's clock (minus the offset) because the git
	// deadline below is a timer on it. A worker ahead of the database no
	// longer gives up a live lease, nor does one behind overrun it. The
	// budget end is the workflow's time, Temporal's server clock; judging it
	// on the calibrated clock takes the two server clocks to agree, which is
	// closer than trusting the drift this corrects.
	const stopAt =
		Math.min(row.leaseUntil.getTime(), Date.parse(input.deadlineAt)) -
		CHECK_DEADLINE_MARGIN_MS -
		clockSkewMs;
	const inTime = (): boolean => Date.now() < stopAt;
	const stale: InstructionSyncCheckResult = { outcome: "stale" };
	// A lease-fenced write the fence refused while this worker still thought
	// the lease live (Fizzy #2683). Some refusals are ordinary (a run or a
	// re-configure moved the row, a run finished in between); the operator
	// compares `leaseUntil` with the calibrated `dbNow` and the raw
	// `workerNow`. Identifiers and times only, never the ref, URL, token or
	// an error. Logging only: the outcome is unchanged.
	const warnIfFenceRejected = (
		applied: boolean,
		write: FencedWrite,
	): void => {
		if (applied || !inTime()) {
			return;
		}
		logger.warn(
			{
				event: "instructions.sync.lease_fence_rejected",
				kind: input.kind,
				syncId: row.id,
				projectId: row.projectId,
				organizationId: row.organizationId,
				stage: write,
				leaseUntil: row.leaseUntil.toISOString(),
				dbNow: dbNow().toISOString(),
				workerNow: new Date().toISOString(),
			},
			"[InstructionSync] the lease fence refused a check's write while the check was still in time",
		);
	};
	// While the lease holds, the claimed failure count is the stored one:
	// every writer of `failureCount` also moves the fence (Task 2).
	const writeBack = (effect: WrittenEffect) =>
		subject.writeBack(
			db,
			fence,
			// Dated on the database's clock: a worker behind it would
			// otherwise write a next check that is already due (Fizzy #2683).
			computeSchedulingPatch(effect, {
				now: dbNow(),
				failureCount: row.failureCount,
				generation: row.generation,
			}),
		);
	const settle = async (
		effect: WrittenEffect,
		outcome: InstructionSyncCheckOutcome,
	): Promise<InstructionSyncCheckResult> => {
		if (!inTime()) {
			return stale;
		}
		stage.current = "write_back";
		const { applied } = await writeBack(effect);
		warnIfFenceRejected(applied, "write_back");
		return { outcome: applied ? outcome : "stale" };
	};
	const recordFailure = async (
		error: "REF_MISSING" | "PERMISSION_DENIED",
		pause: InstructionSyncPause,
		outcome: InstructionSyncCheckOutcome,
	): Promise<InstructionSyncCheckResult> => {
		if (!inTime()) {
			return stale;
		}
		stage.current = "record_failure";
		const { applied } = await db.$transaction((tx) =>
			subject.recordCheckFailure(tx, {
				row,
				pollRunId: input.pollRunId,
				error,
				pause,
				now: dbNow(),
			}),
		);
		warnIfFenceRejected(applied, "record_failure");
		return { outcome: applied ? outcome : "stale" };
	};

	// A check the task queue held past its deadline, or whose lease is gone,
	// reads nothing more: the lease read above is its only database read,
	// and it never reaches the repository.
	if (!lease.held || !inTime()) {
		return stale;
	}
	stage.current = "permission";
	if (!(await subject.checkPermission(row))) {
		return recordFailure(
			"PERMISSION_DENIED",
			"PERMISSION_REVOKED",
			"permission_revoked",
		);
	}

	stage.current = "remote_head";
	const head = await readRemoteHead(row, stopAt);
	if (head.kind === "expired") {
		return stale;
	}
	if (head.kind === "transient") {
		return settle({ kind: "backoff" }, "transient");
	}
	if (head.kind === "missing") {
		return recordFailure("REF_MISSING", "REF_MISSING", "ref_missing");
	}

	const decision = shouldStartAutomaticSync(
		{
			// The claim selected only automatic, unpaused rows, and the lease
			// read above re-confirmed both; `begin` re-checks them when a
			// started run actually begins.
			automatic: true,
			automaticPausedReason: null,
			generation: row.generation,
			lastEvaluatedCommitSha: row.lastEvaluatedCommitSha,
			lastEvaluatedGeneration: row.lastEvaluatedGeneration,
			suppressedCommitSha: row.suppressedCommitSha,
			suppressedGeneration: row.suppressedGeneration,
		},
		head.sha,
	);
	if (!decision.start) {
		if (decision.reason === "evaluated") {
			return settle(
				{ kind: "success", commitSha: head.sha },
				"evaluated",
			);
		}
		if (decision.reason === "suppressed") {
			return settle(
				{ kind: "suppress", commitSha: head.sha },
				"suppressed",
			);
		}
		return stale;
	}

	// The ls-remote took up to 30 s: start nothing for a row this check no
	// longer holds, or has no time left for. A run that completes between
	// this read and the start below is the one way a second run can follow
	// the first (Decision 51); `expected` still refuses it if the row was
	// re-configured meanwhile (Decision 56).
	stage.current = "lease";
	if (!(await subject.leaseHeld(db, fence)).held || !inTime()) {
		return stale;
	}
	let started: RepositorySyncStartResult;
	stage.current = "start";
	try {
		started = await subject.startRun(row, "POLL", {
			expected: { syncId: row.id, generation: row.generation },
		});
	} catch (error) {
		// The outcome is unknown: the server may have started the run before
		// its answer was lost. Not retried and not backed off (Decision 51):
		// the lease is left to expire, and the next claim finds the run open
		// or its completion's cursor.
		logger.warn(
			{
				event: "instructions.sync.poll_start_failed",
				projectId: row.projectId,
				errorClass: error instanceof Error ? error.name : typeof error,
			},
			"[InstructionSync] could not start an automatic sync; its lease will expire",
		);
		return stale;
	}
	// The open run may have read the branch before this head, and its
	// completion would schedule the next check 15 minutes out, past this
	// reschedule. A re-check request on the row makes that completion set
	// the row due now instead (Fizzy #2682). Neither write below is fenced on
	// the lease, and the request never moves `nextCheckAt`. Each is skipped
	// past the deadline like every other write (Decision 50), and a throw is
	// left to the lease.
	// Whether the re-check request found the row moved on purpose: a
	// re-configure refused the marker or its settle, or the settle made the
	// row due. Each ends this check's lease, so the reschedule's refusal
	// below is expected and not worth a warning (Fizzy #2683).
	let rowMovedOnPurpose = false;
	if (started.outcome === "already_running" && inTime()) {
		const { applied } = await subject.recordPendingHead(db, row, head.sha);
		// `already_running` proves only that the workflow has not closed; its
		// completion may already have committed and will never read the
		// marker. The open run's receipt, read under the row lock, decides:
		// unfinished, and that completion consumes it later; finished, and
		// the settle applies it now. Applying it makes the row due, which ends
		// this check's lease, so the reschedule below then applies nothing.
		rowMovedOnPurpose = !applied;
		if (applied && inTime()) {
			const settlement = await subject.settlePendingHead(
				db,
				row,
				started.runId,
			);
			rowMovedOnPurpose = settlement.settled !== "consumer_pending";
		}
	}
	// Conditional (Decision 34): a run that already finished moved
	// `nextCheckAt` itself, and then this applies nothing, which is right. A
	// crash before this line leaves the row to its lease; the next claim
	// finds the run open or its completion's cursor. Past the deadline the
	// reschedule is skipped for the same reason (Decision 50), and the start
	// is still reported.
	if (inTime()) {
		stage.current = "write_back";
		const { applied } = await writeBack({
			kind: "reschedule",
			delayMs:
				started.outcome === "already_running" &&
				row.lastEvaluatedGeneration !== row.generation
					? UNEVALUATED_RECHECK_MS
					: STARTED_RECHECK_MS,
		});
		if (!rowMovedOnPurpose) {
			warnIfFenceRejected(applied, "reschedule");
		}
	}
	return { outcome: started.outcome };
}

/** `expired`: the check reached its deadline, so it did nothing (Decision 50). */
type HeadRead = RemoteHead | { kind: "transient" } | { kind: "expired" };

async function readRemoteHead(
	row: ClaimedRepositorySyncRow,
	stopAt: number,
): Promise<HeadRead> {
	const integration = await getProjectRepoIntegration(
		row.repositoryIntegrationId,
		row.projectId,
	);
	// PR 1's helper (Decision 45): origin and path only, userinfo stripped,
	// and null for anything that is not HTTPS or carries a query or a
	// fragment. `lsRemoteHead` re-checks the same at the git sink.
	const url = integration
		? credentialFreeUrl(integration.repositoryUrl)
		: null;
	if (!integration || integration.status !== "ACTIVE" || url === null) {
		return { kind: "transient" };
	}
	// No credential is resolved for a check out of time.
	if (Date.now() >= stopAt) {
		return { kind: "expired" };
	}
	let token: string | null;
	try {
		({ token } = await resolveFreshRepoToken({
			integrationId: row.repositoryIntegrationId,
			projectId: row.projectId,
			userId: row.userId,
			organizationId: row.organizationId,
		}));
	} catch (error) {
		logger.debug(
			{
				event: "instructions.sync.poll_token_failed",
				projectId: row.projectId,
				errorClass: error instanceof Error ? error.name : typeof error,
			},
			"[InstructionSync] could not resolve a repository token",
		);
		return { kind: "transient" };
	}
	// Token resolution can stall (a slow secret store, a refresh). A check
	// released after its deadline runs no git.
	if (Date.now() >= stopAt) {
		return { kind: "expired" };
	}
	if (!token) {
		return { kind: "transient" };
	}
	const home = await createSyncRunDir();
	const deadline = deadlineSignal(stopAt);
	try {
		return await lsRemoteHead({
			cwd: home,
			url,
			ref: row.ref,
			timeoutMs: LS_REMOTE_TIMEOUT_MS,
			signal: deadline.signal,
			env: buildGitEnv({
				home,
				username: gitUsernameFor(integration.provider),
				credential: token,
				host: new URL(url).host,
			}),
		});
	} catch (error) {
		if (deadline.signal.aborted) {
			return { kind: "expired" };
		}
		logGitFailure(error, [token]);
		return { kind: "transient" };
	} finally {
		deadline.clear();
		await removeSyncRunDir(home).catch(() => {});
	}
}

/**
 * An `AbortSignal` that fires at `stopAt` (Decision 50). Its reason is a
 * `DOMException` named `TimeoutError`, which the git runner reports as a
 * timeout (`instruction-sync-git.ts:156-160`); `lsRemoteHead` joins it with
 * its own 30 s bound.
 */
function deadlineSignal(stopAt: number): {
	signal: AbortSignal;
	clear: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(
		() =>
			controller.abort(
				new DOMException(
					"The check reached its deadline",
					"TimeoutError",
				),
			),
		Math.max(0, stopAt - Date.now()),
	);
	return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** Debug level only, after redaction (spec §8.3). */
function logGitFailure(error: unknown, secrets: readonly string[]): void {
	if (error instanceof GitCommandError) {
		logger.debug(
			{
				event: "instructions.sync.poll_git_failed",
				label: error.label,
				kind: error.kind,
				exitCode: error.exitCode,
				stderr: redactSecrets(error.stderrTail, secrets),
			},
			"[InstructionSync] ls-remote failed",
		);
	}
}
