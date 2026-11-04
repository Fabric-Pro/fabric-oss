import { ContextQualityStoreError } from "@repo/database/prisma/queries/projects/context-quality-runs";
import { SavedEvaluationError } from "../saved-contracts";
import { ContextQualityInputError } from "./commands";
import { ContextReadError } from "./context-reader";

export function contextQualityError(error: unknown):
	| {
			status: 400 | 403 | 404 | 409 | 412 | 413 | 503;
			code:
				| "BAD_REQUEST"
				| "FORBIDDEN"
				| "NOT_FOUND"
				| "CONFLICT"
				| "PAYLOAD_TOO_LARGE"
				| "PRECONDITION_FAILED"
				| "SERVICE_UNAVAILABLE";
			message: string;
	  }
	| undefined {
	if (error instanceof SavedEvaluationError) {
		const statuses = {
			BAD_REQUEST: 400,
			FORBIDDEN: 403,
			NOT_FOUND: 404,
			CONFLICT: 409,
			PRECONDITION_FAILED: 412,
			SERVICE_UNAVAILABLE: 503,
		} as const;
		return {
			status: statuses[error.code],
			code: error.code,
			message: error.message,
		};
	}
	if (error instanceof ContextQualityStoreError) {
		if (error.code === "NOT_FOUND")
			return {
				status: 404,
				code: "NOT_FOUND",
				message: "Evaluation not found in this project.",
			};
		if (error.code === "INVALID_INPUT")
			return {
				status: 400,
				code: "BAD_REQUEST",
				message: "Use a valid bounded evaluation request.",
			};
		if (error.code === "INVALID_BINDING")
			return {
				status: 412,
				code: "PRECONDITION_FAILED",
				message: "The approved evaluation destination is unavailable.",
			};
		return {
			status: 409,
			code: "CONFLICT",
			message:
				"The evaluation destination or request changed. Refresh and try again with the same request key.",
		};
	}
	if (error instanceof ContextQualityInputError) {
		return { status: 400, code: "BAD_REQUEST", message: error.message };
	}
	if (!(error instanceof ContextReadError)) {
		return undefined;
	}
	const status = {
		INVALID_SCOPE: 400,
		INVALID_REVISION: 400,
		NOT_FOUND: 404,
		FORBIDDEN: 403,
		NOT_READY: 409,
		TOO_LARGE: 413,
		STALE_REVISION: 409,
	} as const;
	const code = {
		INVALID_SCOPE: "BAD_REQUEST",
		INVALID_REVISION: "BAD_REQUEST",
		NOT_FOUND: "NOT_FOUND",
		FORBIDDEN: "FORBIDDEN",
		NOT_READY: "CONFLICT",
		TOO_LARGE: "PAYLOAD_TOO_LARGE",
		STALE_REVISION: "CONFLICT",
	} as const;
	return {
		status: status[error.code],
		code: code[error.code],
		message: error.message,
	};
}
