/**
 * A user-cancelled code index ends in the FAILED status (there is no CANCELLED
 * value) with this marker as its error. The cancel procedure writes it and the
 * repository list reads it, so the two cannot drift apart.
 */
export const CODE_INDEX_CANCELLED_ERROR = "Cancelled by user";

export function isCancelledCodeIndex(index: {
	status: string;
	error: string | null;
}): boolean {
	return (
		index.status === "FAILED" && index.error === CODE_INDEX_CANCELLED_ERROR
	);
}
