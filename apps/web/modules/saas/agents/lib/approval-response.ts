/**
 * How an answer to an orchestrator approval card landed. `/approve` answers
 * 409 when the run no longer waits on that approval (answered elsewhere, or
 * superseded by a newer one), so the card is stale rather than failed.
 */
export type ApprovalSendResult = "sent" | "stale" | "failed";

export const APPROVAL_STALE_MESSAGE =
	"This approval was already answered or has expired.";

export function approvalSendResult(
	response: Pick<Response, "ok" | "status">,
): ApprovalSendResult {
	if (response.ok) {
		return "sent";
	}
	return response.status === 409 ? "stale" : "failed";
}
