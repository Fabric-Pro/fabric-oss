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
 * `instructionsAwaitsPublish`.
 */

/** Statuses that mean the validation workflow is still working. */
const ACTIVE_STATUSES = new Set(["RECEIVING", "VALIDATING"]);

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
 * flight (READY, REJECTED and FAILED are all terminal) and the published
 * pointer has nothing left to catch up on, otherwise fast then slow.
 *
 * REJECTED and FAILED stop it as they always did — neither ever publishes.
 */
export function instructionsPollInterval(
	snapshots: ReadonlyArray<{ status: string }> | undefined,
	elapsedMs: number,
	options?: { awaitingPublish?: boolean },
): number | false {
	const active = snapshots?.some((s) => ACTIVE_STATUSES.has(s.status));
	if (!active && !options?.awaitingPublish) {
		return false;
	}
	return intervalAt(elapsedMs);
}
