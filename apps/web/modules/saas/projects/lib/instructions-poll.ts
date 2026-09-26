/**
 * How often the Coding Instructions tab re-reads its snapshot list while an
 * upload is being checked, and when it stops.
 *
 * Extracted from the tab because the answer is a policy rather than a
 * rendering detail, and because getting it wrong is expensive in a way that
 * is invisible in the UI: the tab used to poll every 3 seconds for as long as
 * any snapshot was RECEIVING or VALIDATING, with no terminal condition
 * reachable from a workflow that had failed. A stuck row therefore polled
 * forever, for every user who opened that tab, and the only way out was a
 * fresh upload that left the stuck row behind still polling.
 *
 * It also answers when to KEEP polling past a terminal status: READY is
 * written one activity before the project's published pointer moves, so
 * stopping on READY alone left the tab showing the previous tree — see
 * `instructionsAwaitsPublish`. And a version published before its secret scan
 * (Fizzy #2737) is READY while that scan is still PENDING, so READY alone is
 * not "nothing left to watch" either — see `isInFlight`.
 */

import {
	DEFERRED_SCAN_STALE_AFTER_MS,
	RECEIVING_ABANDON_AFTER_MS,
	VALIDATING_STALE_AFTER_MS,
} from "@repo/instructions";

/** Statuses that mean the validation workflow is still working. */
const ACTIVE_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

/** The fields the "is this still in flight" decision reads off a snapshot. */
type PollRow = {
	status: string;
	createdAt?: string | Date | null;
	/** Fizzy #2737: a READY version whose deferred secret scan is running. */
	deferredScanStatus?: string | null;
	/** When the version became readable; what a pending scan is dated from. */
	readyAt?: string | Date | null;
};

/** One pass of the hourly reaper schedule, as the tab's slack allowance. */
const ONE_REAPER_CYCLE_MS = 60 * 60 * 1000;

/**
 * How old — by `createdAt` — a VALIDATING row has to be before the tab stops
 * waiting on it.
 *
 * Three terms, and the first is the one that is easy to leave out. The
 * reaper's own phase 0 measures `updatedAt`, so it dates a row from the claim
 * that put it in VALIDATING. The list projection carries no `updatedAt`
 * (`summarySelect` in `packages/database/prisma/queries/instructions.ts`), so
 * this measures `createdAt` — and a row may legitimately sit in RECEIVING for
 * `RECEIVING_ABANDON_AFTER_MS` before `finalize` is ever called, which has no
 * age predicate of its own. Without that term the tab would give up
 * immediately on a perfectly live validation whose upload dialog had been open
 * for a few hours.
 *
 * Then `VALIDATING_STALE_AFTER_MS`, the reaper's threshold, and one further
 * hour so the hourly sweep has had a full cycle to write the verdict before
 * the tab stops watching for it.
 *
 * Erring long costs nothing here. The row the sweep heals becomes FAILED, and
 * a terminal status stops the poll on its own without the age ever being
 * consulted; this bound only decides how long the tab keeps watching a row the
 * sweep could NOT heal — which was forever before it existed.
 */
const VALIDATING_ABANDON_AFTER_MS =
	RECEIVING_ABANDON_AFTER_MS +
	VALIDATING_STALE_AFTER_MS +
	ONE_REAPER_CYCLE_MS;

/**
 * How old — by `readyAt` — a READY version's PENDING deferred scan (Fizzy
 * #2737) has to be before the tab stops waiting for its verdict: the reaper's
 * own threshold, `DEFERRED_SCAN_STALE_AFTER_MS`, measured from the same
 * column, plus one full cycle for the hourly sweep to record INCOMPLETE. Same
 * reasoning as above: erring long only costs a slow poll, and the verdict
 * stops it on its own.
 */
const DEFERRED_SCAN_ABANDON_AFTER_MS =
	DEFERRED_SCAN_STALE_AFTER_MS + ONE_REAPER_CYCLE_MS;

/** The time at `value`, or NaN when there is no usable one. */
function timeOf(value: string | Date | null | undefined): number {
	return value == null ? Number.NaN : new Date(value).getTime();
}

/**
 * Whether a snapshot is still work in progress.
 *
 * Both active statuses are decided the same way: by AGE, against the
 * threshold past which the scheduled reaper
 * (`packages/temporal/src/activities/project-instructions-reaper.ts`) has
 * taken over. Sharing those constants is what keeps the two from disagreeing
 * about which rows are still alive.
 *
 * RECEIVING is the abandoned-upload case. `begin` writes RECEIVING and hands
 * the browser its signed PUTs; `finalize` is what starts the workflow. Close
 * the upload dialog part-way through and `finalize` never happens — there is
 * no workflow, nothing will ever move the row, and the tab polled it for
 * every viewer, forever. Past `RECEIVING_ABANDON_AFTER_MS` the reaper closes
 * it out on its own hourly pass; the tab has nothing to wait for.
 *
 * VALIDATING normally means a workflow owns the row and its terminal
 * activities write a verdict one way or the other — which is why this used to
 * be unconditional. The case that breaks it is a row whose execution is GONE
 * with no failure marker written: `finalize` starts the workflow before it
 * writes VALIDATING, so a status write that lands after the run has closed
 * leaves exactly that, and so does a worker that dies mid-run. Nothing inside
 * the feature will ever move such a row, so the tab polled it forever and
 * never offered "Try again". The reaper's phase 0 heals it; past
 * `VALIDATING_ABANDON_AFTER_MS` the tab stops waiting on it regardless.
 *
 * The comparison is `<=` to match the database's STRICT `< cutoff` on the
 * other side of both constants
 * (`listAbandonedReceivingInstructionSnapshots`,
 * `listStaleValidatingInstructionSnapshots`). At exactly the threshold the
 * sweep does not select the row, so a tab that stopped there would leave a
 * row still active and no longer watched until the next hourly pass.
 *
 * A row with no usable `createdAt` counts as active. The age is the only
 * thing that can retire it, so no age means the conservative answer — the
 * bounded fast/slow backoff still applies.
 *
 * A READY row whose deferred secret scan is PENDING (Fizzy #2737) is in flight
 * too: the version is readable, and the tab has a verdict to show when the
 * scan lands. The same rule, by `readyAt` against the reaper's
 * `DEFERRED_SCAN_STALE_AFTER_MS`, retires one whose workflow died.
 */
function isInFlight(snapshot: PollRow, now: number): boolean {
	if (
		snapshot.status === "READY" &&
		snapshot.deferredScanStatus === "PENDING"
	) {
		const readyAt = timeOf(snapshot.readyAt);
		return (
			Number.isNaN(readyAt) ||
			now - readyAt <= DEFERRED_SCAN_ABANDON_AFTER_MS
		);
	}
	if (!ACTIVE_STATUSES.has(snapshot.status)) {
		return false;
	}
	const createdAt =
		snapshot.createdAt == null
			? Number.NaN
			: new Date(snapshot.createdAt).getTime();
	if (Number.isNaN(createdAt)) {
		return true;
	}
	const abandonAfterMs =
		snapshot.status === "RECEIVING"
			? RECEIVING_ABANDON_AFTER_MS
			: VALIDATING_ABANDON_AFTER_MS;
	return now - createdAt <= abandonAfterMs;
}

/** While the workflow is plausibly seconds from finishing. */
export const INSTRUCTIONS_FAST_POLL_MS = 3_000;
/** After that: still watching, but at a cost that can run for hours. */
export const INSTRUCTIONS_SLOW_POLL_MS = 30_000;
/**
 * How long the fast interval lasts. Measured from MOUNT, not from the
 * snapshot's own timestamp: the list projection carries `createdAt` but no
 * `updatedAt`, and adding one would be a schema change for a polling
 * heuristic. Mount time is the conservative reading — a tab opened onto an
 * already-old VALIDATING row gets 2 minutes of fast polling it did not need,
 * which is bounded, rather than the unbounded loop this replaces.
 */
export const INSTRUCTIONS_FAST_POLL_WINDOW_MS = 120_000;

/**
 * How many further polls the tab spends waiting for auto-publication to move
 * the project's published pointer onto a snapshot that has just reached READY.
 *
 * A bound, not a deadline: publication is one activity away from the READY
 * write, so it normally lands on the first or second poll. The budget exists
 * so that the cases where it never lands — a workflow that failed between the
 * two, a snapshot a newer version has already overtaken — stop polling instead
 * of turning the tab into a permanent background load, which is the exact
 * failure `instructionsPollInterval` was extracted to end.
 */
export const INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS = 20;

/** The interval in force at a given age, ignoring whether to poll at all. */
function intervalAt(elapsedMs: number): number {
	return elapsedMs < INSTRUCTIONS_FAST_POLL_WINDOW_MS
		? INSTRUCTIONS_FAST_POLL_MS
		: INSTRUCTIONS_SLOW_POLL_MS;
}

/**
 * Whether the tab is still waiting for the published pointer to catch up with
 * a snapshot that has reached READY.
 *
 * READY is written by `finalizeInstructionSnapshot`; the pointer is moved by
 * `publishInstructionSnapshotActivity`, the NEXT activity in the workflow
 * (`packages/temporal/src/workflows/project-instruction-snapshot.ts`). The
 * list poll's terminal condition fires on the first of those, so it stopped in
 * the gap: a first upload kept showing "nothing published" and a replacement
 * kept showing the old tree until the viewer reloaded or refocused the tab.
 * Invalidating `getPublished` once on seeing READY is not enough either — that
 * refetch can also land inside the gap.
 *
 * So: keep polling both queries while the newest snapshot is READY, is set to
 * publish itself, and is not yet the pointer — for a bounded number of further
 * polls at whatever interval is currently in force.
 *
 * `readySince` is the CLIENT's own first sighting of READY, not the row's
 * `readyAt`. `readyAt` is the server's clock, and a bound computed across the
 * two would be a bound on clock skew: a viewer running minutes fast would
 * never converge at all, and one running minutes slow would poll for those
 * minutes on every upload.
 */
export function instructionsAwaitsPublish(input: {
	snapshots:
		| ReadonlyArray<{
				id: string;
				status: string;
				publishOnReady?: boolean;
		  }>
		| undefined;
	publishedId: string | null | undefined;
	/** When this tab first saw the newest snapshot READY; null if it has not. */
	readySince: number | null;
	now: number;
	elapsedMs: number;
}): boolean {
	const newest = input.snapshots?.[0];
	if (!newest || newest.status !== "READY") {
		return false;
	}
	// A manually-published project never moves the pointer on its own, so
	// there is nothing to converge on: the History dialog's Publish button
	// invalidates both queries itself when someone uses it.
	if (newest.publishOnReady === false) {
		return false;
	}
	if (input.publishedId === newest.id) {
		return false;
	}
	if (input.readySince === null) {
		return false;
	}
	return (
		input.now - input.readySince <
		INSTRUCTIONS_PUBLISH_CONVERGENCE_POLLS * intervalAt(input.elapsedMs)
	);
}

/**
 * The `refetchInterval` for the snapshot list: `false` once nothing is in
 * flight (READY, REJECTED and FAILED are all terminal, and an abandoned
 * RECEIVING row is no longer in flight either) and the published pointer has
 * nothing left to catch up on, otherwise fast then slow.
 *
 * REJECTED and FAILED stop it as they always did — neither ever publishes.
 *
 * `now` is an argument rather than a `Date.now()` inside this function: the
 * caller already reads the clock once per decision, and a pure helper is what
 * makes the age boundary testable at all.
 *
 * `published` is the pointer query's own row. A version published before its
 * scan can be the pointer without being in the list's first page of rows the
 * tab happens to hold, and the published view renders its alert off THAT row,
 * so both queries keep polling while it is pending (Fizzy #2737).
 */
export function instructionsPollInterval(
	snapshots: ReadonlyArray<PollRow> | undefined,
	elapsedMs: number,
	options: {
		awaitingPublish?: boolean;
		now: number;
		published?: PollRow | null;
	},
): number | false {
	const active =
		snapshots?.some((s) => isInFlight(s, options.now)) ||
		(options.published
			? isInFlight(options.published, options.now)
			: false);
	if (!active && !options.awaitingPublish) {
		return false;
	}
	return intervalAt(elapsedMs);
}
