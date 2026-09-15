import { ORPCError } from "@orpc/client";
import {
	GovernedActorRequiredError,
	StageApprovalError,
	StageTransitionBlockedError,
	StageTransitionConflictError,
} from "@repo/database";

/**
 * Map domain errors thrown by the stage-transition choke point
 * (`@repo/database` delivery module) to oRPC errors. Anything else is
 * returned unchanged so callers can rethrow it.
 */
export function mapStageTransitionError(error: unknown): unknown {
	if (error instanceof StageTransitionBlockedError) {
		return new ORPCError("PRECONDITION_FAILED", {
			message: `This feature is not ready for ${error.toStage
				.toLowerCase()
				.replace(/_/g, " ")}: ${error.missing.join(", ")}`,
			data: {
				code: error.code,
				toStage: error.toStage,
				missing: error.missing,
				advisory: error.advisory,
				effectiveTrack: error.effectiveTrack,
			},
		});
	}
	if (error instanceof GovernedActorRequiredError) {
		return new ORPCError("PRECONDITION_FAILED", {
			message: error.message,
			data: { code: error.code },
		});
	}
	if (error instanceof StageTransitionConflictError) {
		return new ORPCError("CONFLICT", {
			message: error.message,
			data: { code: error.code },
		});
	}
	if (error instanceof StageApprovalError) {
		const status =
			error.code === "REQUEST_NOT_FOUND"
				? "NOT_FOUND"
				: error.code === "NOT_AN_APPROVER" ||
						error.code === "SELF_APPROVAL"
					? "FORBIDDEN"
					: "CONFLICT";
		return new ORPCError(status, {
			message: error.message,
			data: { code: error.code },
		});
	}
	if (
		error instanceof Error &&
		/updated by another request|Story not found/i.test(error.message)
	) {
		return new ORPCError(
			/not found/i.test(error.message) ? "NOT_FOUND" : "CONFLICT",
			{ message: error.message },
		);
	}
	return error;
}
