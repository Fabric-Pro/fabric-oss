/** Whether a persisted proposal is waiting for its apply to finish. */
export function isApplyInFlight(status: string | null | undefined): boolean {
	return status === "APPROVED" || status === "APPLYING";
}
