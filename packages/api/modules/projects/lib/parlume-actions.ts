import type { ParlumeActionStatus } from "@repo/database/prisma/generated/enums";

/**
 * A proposal's status as a member sees it: one still PROPOSED past its
 * `expiresAt` can no longer be confirmed, so it reads as EXPIRED before any
 * write records that.
 */
export function effectiveParlumeActionStatus(
	action: { status: ParlumeActionStatus; expiresAt: Date },
	now: Date = new Date(),
): ParlumeActionStatus {
	return action.status === "PROPOSED" && action.expiresAt <= now
		? "EXPIRED"
		: action.status;
}

/** Why a proposal in this state cannot be confirmed or dismissed now. */
export function parlumeActionClosedMessage(
	status: ParlumeActionStatus,
): string {
	switch (status) {
		case "EXPIRED":
			return "This proposal has expired. Ask Parlume again in the meeting.";
		case "CANCELLED":
			return "This proposal was dismissed.";
		case "EXECUTING":
		case "COMPLETED":
		case "FAILED":
		case "OUTCOME_UNKNOWN":
			return "This proposal was already confirmed.";
		case "PROPOSED":
		case "AWAITING_CONFIRMATION":
		case "INVALIDATED":
			return "This proposal can no longer be confirmed.";
		default: {
			const unreachable: never = status;
			return unreachable;
		}
	}
}
