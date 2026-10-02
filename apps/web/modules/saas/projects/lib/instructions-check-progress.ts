/**
 * What the Coding Instructions tab says about a snapshot's checks while they
 * run, read off the progress columns the check passes write
 * (`recordInstructionSnapshotProgress`).
 *
 * Honest by construction: a count is only ever shown as the server wrote it,
 * as files fully decided out of files to decide, and anything that does not
 * add up (a count past its total, a phase with no numbers, a row nothing is
 * checking) yields `null`, which callers answer with the plain
 * "Checking your upload" copy they had before progress existed. There is no
 * percentage and no estimate of the time left anywhere.
 */

export type SnapshotCheckPhase = "CHECKING" | "SAVING" | "SCANNING";

export type SnapshotProgressFields = {
	status: string;
	deferredScanStatus?: string | null;
	progressPhase?: SnapshotCheckPhase | null;
	progressDone?: number | null;
	progressTotal?: number | null;
};

export type SnapshotCheckProgress = {
	phase: SnapshotCheckPhase;
	done: number;
	total: number;
};

/** A row somebody is checking: a run in flight, or a published version's scan. */
function isBeingChecked(snapshot: SnapshotProgressFields): boolean {
	return (
		snapshot.status === "VALIDATING" ||
		(snapshot.status === "READY" &&
			snapshot.deferredScanStatus === "PENDING")
	);
}

export function snapshotCheckProgress(
	snapshot: SnapshotProgressFields,
): SnapshotCheckProgress | null {
	const {
		progressPhase: phase,
		progressDone: done,
		progressTotal: total,
	} = snapshot;
	if (
		!isBeingChecked(snapshot) ||
		phase == null ||
		done == null ||
		total == null ||
		!Number.isInteger(done) ||
		!Number.isInteger(total) ||
		done < 0 ||
		done > total
	) {
		return null;
	}
	return { phase, done, total };
}

/** The translation key (under `publishedView`) for a phase's "X of Y files" line. */
export function checkProgressMessageKey(
	phase: SnapshotCheckPhase,
): "checkingFiles" | "savingFiles" | "scanningFiles" {
	switch (phase) {
		case "CHECKING":
			return "checkingFiles";
		case "SAVING":
			return "savingFiles";
		case "SCANNING":
			return "scanningFiles";
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}

/** The translation key for the phase's name alone, which is what a screen reader hears. */
export function checkPhaseMessageKey(
	phase: SnapshotCheckPhase,
): "checkingPhase" | "savingPhase" | "scanningPhase" {
	switch (phase) {
		case "CHECKING":
			return "checkingPhase";
		case "SAVING":
			return "savingPhase";
		case "SCANNING":
			return "scanningPhase";
		default: {
			const unreachable: never = phase;
			return unreachable;
		}
	}
}
