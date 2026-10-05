/**
 * An upload that was begun and never finalized (Fizzy #2878 follow-up): the
 * browser could not reach storage, or the tab was closed part-way. `begin`
 * left the snapshot RECEIVING, no workflow owns it, and the tab used to say
 * "Checking your upload" about it for hours with no way out. These say which
 * rows the person may discard and when one has plainly stopped.
 *
 * Pure, so the header, History and their tests share one answer. The server is
 * the authority (the delete procedure and its DELETE's own predicate); this is
 * only which rows to OFFER it for, mirroring what the server accepts: a plain
 * upload or edit that is RECEIVING. A repository sync's snapshot is RECEIVING
 * while its run copies the files in, and a suggestion or a direct commit
 * answers to its pull request.
 */

type DiscardableRow = {
	status: string;
	source?: string | null;
	proposalStatus?: string | null;
	createdAt?: string | Date | null;
};

/** How long an upload may sit RECEIVING before History says it did not finish. */
export const STALLED_UPLOAD_AFTER_MS = 60 * 60_000;

/** Whether a row is an unfinished upload the person may discard. */
export function canDiscardUpload(row: DiscardableRow): boolean {
	return (
		row.status === "RECEIVING" &&
		row.source === "UPLOAD" &&
		(row.proposalStatus ?? null) === null
	);
}

/**
 * Whether an unfinished upload is older than `STALLED_UPLOAD_AFTER_MS`, so
 * History reads it as one that did not finish rather than one being checked.
 * A row with no usable `createdAt` is not called stalled: the age is the only
 * evidence, and no evidence is not a verdict.
 */
export function isStalledUpload(
	row: DiscardableRow,
	now: number = Date.now(),
): boolean {
	if (!canDiscardUpload(row) || row.createdAt == null) {
		return false;
	}
	const createdAt = new Date(row.createdAt).getTime();
	return (
		!Number.isNaN(createdAt) && now - createdAt > STALLED_UPLOAD_AFTER_MS
	);
}
