import { isCheckRunActive } from "./instructions-poll";

type PendingPublishRow = {
	status: string;
	createdAt?: string | Date | null;
	/** Absent reads as on: an upload publishes itself unless it says it will not. */
	publishOnReady?: boolean;
	/** A proposal publishes only through review, never on its own. */
	proposalStatus?: string | null;
};

/**
 * How many checks that are still running will publish themselves when they
 * finish, and so would replace whatever History's rollback has just made
 * current.
 *
 * Counts the snapshots still being checked that are set to publish, plus a
 * repository sync run that has not staged its snapshot yet (`syncRunPending`):
 * it publishes what it syncs, and until its snapshot exists there is no row
 * to count. Newest still wins: this only tells the person, it changes nothing.
 */
export function countPendingPublishes(input: {
	snapshots: readonly PendingPublishRow[];
	syncRunPending: boolean;
	now: number;
}): number {
	const checking = input.snapshots.filter(
		(s) =>
			s.publishOnReady !== false &&
			(s.proposalStatus ?? null) === null &&
			isCheckRunActive(s, input.now),
	).length;
	return checking + (input.syncRunPending ? 1 : 0);
}
