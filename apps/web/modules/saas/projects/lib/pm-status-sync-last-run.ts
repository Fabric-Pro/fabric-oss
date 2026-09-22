/**
 * Pure derivation of the "Last status sync" line on the PM settings card
 * (Fizzy #2304, spec AC13 / D1.8).
 *
 * `Project.pmStatusSyncLastRun` is written in pieces by the hourly poll while
 * the status-sync switch is on (spec D2.6): the fetch summary, a failure or a
 * skipped project, and the reconcile outcome counts. This turns that JSON into
 * one of seven states. It parses through the SAME schema the writers build
 * through, imported from its dependency-free module: the `@repo/database`
 * barrel would drag the Prisma client into the client bundle.
 *
 * A failure never reads as healthy, and neither does silence: nothing recorded
 * for longer than two poll intervals after the switch went on is `stale`, the
 * same threshold `pm-sync-status.ts` uses for the poll itself. Nor does a
 * fetch that could not read some of its tickets, OR that read none of them at
 * all even though nothing individually failed — every id deferred, never
 * attempted (`read-errors`; the trigger is not `failed > 0` alone). Nor does
 * a fetch whose reconcile never finished: the fetch writes its summary every
 * hour, but the outcome is written only at the END of reconcile, so a
 * reconcile that times out or throws every cycle would otherwise look healthy
 * forever (`outcome-overdue`). `now` is injected so the thresholds are
 * deterministic in tests.
 */
import {
	type PmStatusSyncLastRun,
	pmStatusSyncLastRunSchema,
} from "@repo/database/src/pm-status-sync-last-run-schema";
import { STALE_AFTER_MS } from "./pm-sync-status";

type FetchSummary = NonNullable<PmStatusSyncLastRun["fetch"]>;
type OutcomeCounts = NonNullable<PmStatusSyncLastRun["outcome"]>["counts"];

export type PmStatusSyncRunView =
	| { kind: "waiting" }
	| { kind: "unreadable" }
	| {
			kind: "failed";
			at: Date;
			reason: "fetch-failed" | "source-not-found";
			error: string;
	  }
	| { kind: "stale"; at: Date; run: PmStatusSyncLastRun | null }
	/** A fetch landed at `at`, but no outcome for it within the grace period. */
	| { kind: "outcome-overdue"; at: Date; run: PmStatusSyncLastRun }
	/**
	 * A current fetch in which some tickets could not be read: their statuses
	 * were not checked this cycle, so the run is never healthy (AC13).
	 * `nothingRead` when not a single ticket was read — either every read
	 * failed, or every id was deferred (never attempted, `failed` still 0) —
	 * PROVIDED the run had something readable (`linked > notFound`); a board
	 * whose tickets are all not-found or has none linked stays healthy.
	 */
	| {
			kind: "read-errors";
			at: Date;
			run: PmStatusSyncLastRun;
			failed: number;
			linked: number;
			nothingRead: boolean;
	  }
	| { kind: "healthy"; at: Date; run: PmStatusSyncLastRun };

/**
 * How long after a fetch its outcome may still be missing. Reconcile runs
 * straight after the fetch with a 3-minute start-to-close timeout and at most
 * three attempts, so every outcome that will ever arrive has arrived well
 * inside this; a fetch older than it with no outcome means reconcile did not
 * finish.
 */
const OUTCOME_OVERDUE_AFTER_MS = 15 * 60 * 1000;

function toTime(value: Date | string | null | undefined): number | null {
	if (value == null) {
		return null;
	}
	const time = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isNaN(time) ? null : time;
}

function nothingRecordedYet(
	sessionAt: number | null,
	now: number,
): PmStatusSyncRunView {
	if (sessionAt !== null && now - sessionAt > STALE_AFTER_MS) {
		return { kind: "stale", at: new Date(sessionAt), run: null };
	}
	return { kind: "waiting" };
}

export function derivePmStatusSyncRunView(args: {
	lastRun: unknown;
	sessionAt: Date | string | null | undefined;
	now: number;
}): PmStatusSyncRunView {
	if (args.lastRun === null || args.lastRun === undefined) {
		return nothingRecordedYet(toTime(args.sessionAt), args.now);
	}

	const parsed = pmStatusSyncLastRunSchema.safeParse(args.lastRun);
	if (!parsed.success) {
		return { kind: "unreadable" };
	}
	const run = parsed.data;

	const fetchAt = toTime(run.fetch?.at);
	const outcomeAt = toTime(run.outcome?.at);
	// An outcome older than the run's fetch belongs to the PREVIOUS cycle: the
	// new fetch has landed but reconcile has not recorded THIS cycle's outcome
	// yet (or never will). Carrying it forward would print the previous
	// cycle's counts under the new fetch's time, so a stale outcome drops out
	// of both the freshness clock and the run handed to the renderer.
	const outcomeIsCurrent =
		run.outcome === undefined ||
		fetchAt === null ||
		(outcomeAt !== null && outcomeAt >= fetchAt);
	const { outcome: _staleOutcome, ...runWithoutStaleOutcome } = run;
	const effectiveRun: PmStatusSyncLastRun = outcomeIsCurrent
		? run
		: runWithoutStaleOutcome;

	const successTimes = [fetchAt, outcomeIsCurrent ? outcomeAt : null].filter(
		(time): time is number => time !== null,
	);
	const lastSuccess =
		successTimes.length > 0 ? Math.max(...successTimes) : null;
	const failureAt = toTime(run.failure?.at);

	// A failure newer than the last success is the current state, however old
	// it is; a later successful fetch supersedes it.
	if (
		run.failure &&
		failureAt !== null &&
		(lastSuccess === null || failureAt >= lastSuccess)
	) {
		return {
			kind: "failed",
			at: new Date(failureAt),
			reason: run.failure.kind,
			error: run.failure.error,
		};
	}

	if (lastSuccess === null) {
		return nothingRecordedYet(
			toTime(run.sessionAt) ?? toTime(args.sessionAt),
			args.now,
		);
	}

	const at = new Date(lastSuccess);
	if (args.now - lastSuccess > STALE_AFTER_MS) {
		return { kind: "stale", at, run: effectiveRun };
	}
	// A fetch with no outcome of its own (none at all, or only the previous
	// cycle's) is fine while reconcile may still be running — past the grace
	// period it never finished, and the fetched tickets were not applied.
	const hasCurrentOutcome =
		run.outcome !== undefined && outcomeIsCurrent && outcomeAt !== null;
	if (
		fetchAt !== null &&
		!hasCurrentOutcome &&
		args.now - fetchAt > OUTCOME_OVERDUE_AFTER_MS
	) {
		return {
			kind: "outcome-overdue",
			at: new Date(fetchAt),
			run: effectiveRun,
		};
	}
	// `failed` excludes not-found and never-attempted ids (the worker's
	// `fetchSummaryCounts` keeps the buckets disjoint), so neither deleted
	// tickets nor budget rotation trip this on their own. But a fetch where
	// EVERY id was deferred (never attempted — MCP capability discovery timed
	// out, or REST source resolution spent the whole budget) also records
	// `failed = 0`, and a failed-only trigger would print that run healthy
	// even though nothing was read. `nothingRead` catches that: nothing was
	// read although there was something readable (`linked > notFound` — a
	// board whose tickets are ALL not-found stays healthy, since deleted
	// tickets are FLAG_MISSING's job, not a read error; `linked === 0` stays
	// healthy the same way).
	const fetchSummary = effectiveRun.fetch;
	if (fetchSummary) {
		const nothingRead =
			fetchSummary.fetched === 0 &&
			fetchSummary.linked > fetchSummary.notFound;
		if (fetchSummary.failed > 0 || nothingRead) {
			return {
				kind: "read-errors",
				at,
				run: effectiveRun,
				failed: fetchSummary.failed,
				linked: fetchSummary.linked,
				nothingRead,
			};
		}
	}
	return { kind: "healthy", at, run: effectiveRun };
}

export function formatPmStatusSyncFetch(fetch: FetchSummary): string {
	const notFetched = Math.max(
		0,
		fetch.linked - fetch.fetched - fetch.failed - fetch.notFound,
	);
	const counts = `${fetch.linked} linked · ${fetch.fetched} fetched · ${fetch.failed} failed · ${fetch.notFound} not found · ${notFetched} not fetched`;
	return fetch.complete
		? counts
		: `${counts} (incomplete — the rest is checked on the next run)`;
}

/** Decision-table order (spec §4.4). */
const OUTCOME_LABELS: ReadonlyArray<readonly [keyof OutcomeCounts, string]> = [
	["moved", "moved"],
	["unchanged", "unchanged"],
	["fabric-ahead", "Fabric ahead"],
	["not-mapped", "not mapped"],
	["ambiguous", "ambiguous"],
	["unverified", "unverified"],
	["stale", "stale"],
	["skipped-conflict", "skipped (conflict)"],
	["raced", "raced"],
];

export function formatPmStatusSyncOutcomes(counts: OutcomeCounts): string {
	return OUTCOME_LABELS.map(([key, label]) => `${counts[key]} ${label}`).join(
		" · ",
	);
}
