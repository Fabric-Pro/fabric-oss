/**
 * Coding Instructions automatic repository sync: the poll (spec §6.1).
 *
 * The `project-instruction-repository-poll` schedule starts this every five
 * minutes with overlap SKIP and a 270 s execution timeout. It sweeps stale
 * clone directories (§8.2), then keeps four lanes of checks busy inside one
 * four-minute budget (Decision 32):
 *
 * - Claims are per wave (Decision 49). Whenever a lane is free and the 60 s
 *   reserve remains, it claims exactly as many due rows as lanes are free
 *   and dispatches each at once, under the two-minute lease the claim just
 *   wrote. A row with less lease left than the check's 90 s start-to-close
 *   is not dispatched: it is counted as `deferred` and left to expire, and
 *   claiming ends for the tick, because the next claim would be as slow.
 * - A wave walks the repository-sync subject kinds (Decision 46) from a
 *   round-robin cursor kept for the whole run, and gives each open kind at
 *   most `ceil(freeLanes / openKinds)` rows (Decision 52). A kind closes for
 *   the tick when its claim comes back short (nothing more is due) or throws
 *   after its retries; a throw is logged and counted in `claimFailed`, and
 *   never stops another kind or the run. A deep backlog of slow checks in
 *   one kind therefore cannot hold every lane while another kind has due
 *   rows.
 * - A tick claims at most `INSTRUCTION_SYNC_POLL_CLAIM_CAP` rows in all
 *   (Fizzy #2685), so a deep backlog of fast checks cannot record thousands
 *   of activity round trips in one history. Rows past the cap stay due for
 *   the next tick. The cap is deliberately not gated behind `patched()`:
 *   this is a schedule tick bounded by a 270 s execution timeout, so a
 *   pre-cap run that had already passed 400 claims when a worker restarted
 *   onto this code fails replay, times out, and loses that one tick; its
 *   two-minute leases expire and a later tick claims the rows. That bounded
 *   one-time cost does not justify carrying two wave-control paths.
 * - Every activity call's schedule-to-close is the budget left, so a call
 *   no worker serves, or one stuck in retries, cannot hold the run past it.
 *   Each check also receives the budget's end as `deadlineAt` and stops
 *   itself before it (Decision 50): a Temporal timeout ends Temporal's wait
 *   for an activity, not the activity's JavaScript.
 *
 * `Date.now()` is workflow time inside the sandbox, so the budget replays
 * deterministically. Imports only the SDK, the pure sync types and
 * type-only activity signatures, as the workflow sandbox requires.
 *
 * The activities name no task queue: they run on the workflow's own queue,
 * `fabric-worker` (schedules.ts), alongside the sync's own activities.
 */
import {
	log,
	patched,
	proxyActivities,
	workflowInfo,
} from "@temporalio/workflow";
import type * as pollActivities from "../activities/project-instruction-repository-poll";
import {
	type ClaimedInstructionSyncCheck,
	INSTRUCTION_SYNC_CHECK_RESERVE_MS,
	INSTRUCTION_SYNC_CHECK_START_TO_CLOSE_MS,
	INSTRUCTION_SYNC_POLL_BUDGET_MS,
	INSTRUCTION_SYNC_POLL_CLAIM_CAP,
	type InstructionSyncCheckOutcome,
	type InstructionSyncPollInput,
	type InstructionSyncPollResult,
	REPOSITORY_SYNC_SUBJECT_KINDS,
} from "../lib/instruction-sync-types";

const CONCURRENCY = 4;

/**
 * Proxies for ONE call, built when it is made: the schedule-to-close is the
 * budget left at that moment, so it cannot be fixed at module load.
 */
function sweepActivity(budgetLeftMs: number) {
	// Destructured, not read off the proxy object, so the activity-registration
	// parity guard (`workflows/__tests__/activity-registration-parity.test.ts`)
	// can see this name statically.
	const { sweepInstructionSyncTempDirs } = proxyActivities<
		typeof pollActivities
	>({
		startToCloseTimeout: "1 minute",
		scheduleToCloseTimeout: budgetLeftMs,
		// Housekeeping: a failure is logged and the tick carries on; the next
		// tick, and the worker's startup sweep, try again.
		retry: { maximumAttempts: 1 },
	});
	return sweepInstructionSyncTempDirs;
}

function claimActivity(budgetLeftMs: number) {
	const { claimDueInstructionSyncChecks } = proxyActivities<
		typeof pollActivities
	>({
		startToCloseTimeout: "30 seconds",
		scheduleToCloseTimeout: budgetLeftMs,
		retry: {
			initialInterval: "1 second",
			backoffCoefficient: 2,
			maximumAttempts: 3,
		},
	});
	return claimDueInstructionSyncChecks;
}

function checkActivity(budgetLeftMs: number) {
	const { checkInstructionSyncRemoteHead } = proxyActivities<
		typeof pollActivities
	>({
		// A per-attempt ceiling: token resolution, a 30 s ls-remote and the
		// fenced writes. A lane dispatches only with at least this much lease
		// left (Decision 49), and the check stops itself before its lease or
		// the budget ends (Decision 50).
		startToCloseTimeout: INSTRUCTION_SYNC_CHECK_START_TO_CLOSE_MS,
		scheduleToCloseTimeout: budgetLeftMs,
		// The check reports its own transient outcomes. A thrown check is not
		// retried: its lease expires in two minutes and the next claim takes it.
		retry: { maximumAttempts: 1 },
	});
	return checkInstructionSyncRemoteHead;
}

const OUTCOME_COUNTER: Record<
	InstructionSyncCheckOutcome,
	keyof InstructionSyncPollResult
> = {
	started: "started",
	already_running: "alreadyRunning",
	evaluated: "evaluated",
	suppressed: "suppressed",
	ref_missing: "refMissing",
	permission_revoked: "permissionRevoked",
	transient: "transient",
	stale: "stale",
};

function errorName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

export async function projectInstructionRepositoryPollWorkflow(
	input: InstructionSyncPollInput = {},
): Promise<InstructionSyncPollResult> {
	// The default kind list grew from one kind to every registered kind when
	// Living Memory joined the adapter. A run recorded before that claimed
	// one kind per wave; replaying it against a two-kind default would issue
	// a claim its history never saw. The patch keeps old histories on the
	// one-kind path and lets every new run walk the registered kinds.
	const kinds: NonNullable<InstructionSyncPollInput["kinds"]> =
		input.kinds ??
		(patched("repository-sync-subject-kinds-v2")
			? REPOSITORY_SYNC_SUBJECT_KINDS
			: ["instructions"]);
	const deadline = Date.now() + INSTRUCTION_SYNC_POLL_BUDGET_MS;
	const deadlineAt = new Date(deadline).toISOString();
	const budgetLeft = (): number => deadline - Date.now();
	const pollRunId = workflowInfo().runId;
	const result: InstructionSyncPollResult = {
		claimed: 0,
		started: 0,
		alreadyRunning: 0,
		evaluated: 0,
		suppressed: 0,
		refMissing: 0,
		permissionRevoked: 0,
		transient: 0,
		stale: 0,
		failed: 0,
		deferred: 0,
		claimFailed: 0,
	};

	try {
		const { removed } = await sweepActivity(budgetLeft())();
		if (removed > 0) {
			log.info("Removed stale instruction sync directories", { removed });
		}
	} catch (error) {
		log.warn("Instruction sync temp sweep failed; continuing", {
			error: errorName(error),
		});
	}

	// Kinds still worth claiming this tick, and the kind the next wave
	// starts from (Decision 52).
	const open = new Set(kinds);
	let cursor = 0;
	const lanes = new Set<Promise<void>>();

	const check = async (
		row: ClaimedInstructionSyncCheck,
		budgetLeftMs: number,
	): Promise<void> => {
		try {
			const { outcome } = await checkActivity(budgetLeftMs)({
				...row,
				pollRunId,
				deadlineAt,
			});
			result[OUTCOME_COUNTER[outcome]]++;
		} catch (error) {
			result.failed++;
			log.warn("Repository sync check failed; its lease will expire", {
				kind: row.kind,
				id: row.id,
				error: errorName(error),
			});
		}
	};

	/**
	 * Starts a lane for `row`, or refuses a row it could not finish in time.
	 * The lease-left test compares a database-clock lease with the
	 * workflow's clock, which is Temporal's, not the database's, and is not
	 * calibrated as the check calibrates its own (Fizzy #2683: a documented
	 * residual).
	 * A refusal only leaves the row to its lease, and the next tick claims it
	 * again; it never lets a write through, which the fence decides.
	 */
	const dispatch = (row: ClaimedInstructionSyncCheck): boolean => {
		const left = budgetLeft();
		if (
			lanes.size >= CONCURRENCY ||
			left < INSTRUCTION_SYNC_CHECK_RESERVE_MS ||
			Date.parse(row.leaseUntil) - Date.now() <
				INSTRUCTION_SYNC_CHECK_START_TO_CLOSE_MS
		) {
			return false;
		}
		const lane = check(row, left);
		lanes.add(lane);
		void lane.then(() => lanes.delete(lane));
		return true;
	};

	/** One wave: at most `freeLanes` rows, shared across the open kinds. */
	const claimWave = async (
		freeLanes: number,
	): Promise<ClaimedInstructionSyncCheck[]> => {
		const wave: ClaimedInstructionSyncCheck[] = [];
		const share = Math.ceil(freeLanes / open.size);
		for (
			let step = 0;
			step < kinds.length && wave.length < freeLanes;
			step++
		) {
			const kind = kinds[(cursor + step) % kinds.length];
			if (kind === undefined || !open.has(kind)) {
				continue;
			}
			const left = budgetLeft();
			if (left < INSTRUCTION_SYNC_CHECK_RESERVE_MS) {
				break;
			}
			const limit = Math.min(share, freeLanes - wave.length);
			try {
				const rows = await claimActivity(left)({ kind, limit });
				result.claimed += rows.length;
				wave.push(...rows);
				if (rows.length < limit) {
					open.delete(kind);
				}
			} catch (error) {
				open.delete(kind);
				result.claimFailed++;
				log.warn(
					"Repository sync claim failed; skipping its kind for the rest of the tick",
					{ kind, error: errorName(error) },
				);
			}
		}
		cursor = (cursor + 1) % kinds.length;
		return wave;
	};

	while (true) {
		// Lanes free, and no more than the tick may still claim under its cap.
		const freeLanes = Math.min(
			CONCURRENCY - lanes.size,
			INSTRUCTION_SYNC_POLL_CLAIM_CAP - result.claimed,
		);
		if (
			freeLanes > 0 &&
			open.size > 0 &&
			budgetLeft() >= INSTRUCTION_SYNC_CHECK_RESERVE_MS
		) {
			const wave = await claimWave(freeLanes);
			if (result.claimed >= INSTRUCTION_SYNC_POLL_CLAIM_CAP) {
				// Logged once: with the cap reached, no later wave is claimed.
				log.info(
					"Instruction sync poll reached its claim cap; the rest wait for the next tick",
					{ cap: INSTRUCTION_SYNC_POLL_CLAIM_CAP },
				);
			}
			const refused = wave.filter((row) => !dispatch(row)).length;
			if (refused > 0) {
				// Claimed too late to check in time. Their leases expire and they
				// come due again first in the order; the next claim would be as
				// late, so this tick claims nothing more (Decision 49).
				result.deferred += refused;
				open.clear();
			}
			if (wave.length > 0) {
				continue;
			}
		}
		if (lanes.size === 0) {
			break;
		}
		await Promise.race(lanes);
	}

	log.info("Instruction sync poll finished", { ...result });
	return result;
}
