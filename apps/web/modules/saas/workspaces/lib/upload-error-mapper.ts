// Typed mapper from any thrown value in the workspace document upload pipeline
// to a discriminated `UploadError`. Switches on `error.code` / `instanceof` /
// numeric `.status` per `fabric/standards/global/error-handling.md` — never on
// raw message strings.
//
// Decision-rules table: see spec §6c at
// `specs/2026-05-14-workspace-document-upload-failed-fetch/spec.md`.
//
// The public `UploadErrorCode` union and `UploadError` interface are the
// contract that `DocumentUploader` imports — do not change without coordinated
// updates to Group 4.

import { ORPCError } from "@orpc/client";

export type UploadErrorCode =
	| "NETWORK_OR_CORS"
	| "STORAGE_REJECTED" // HTTP 403 from presigned URL (signature mismatch or expired)
	| "FILE_TOO_LARGE" // HTTP 413
	| "STORAGE_UNAVAILABLE" // HTTP 5xx from storage
	| "UNAUTHORIZED" // oRPC UNAUTHORIZED
	| "FORBIDDEN" // oRPC FORBIDDEN
	| "VALIDATION" // oRPC BAD_REQUEST / Zod validation
	| "SERVER_ERROR" // oRPC INTERNAL_SERVER_ERROR
	| "UNKNOWN";

export interface UploadError {
	code: UploadErrorCode;
	userMessage: string;
	cause?: unknown; // for logging only — never rendered
}

const USER_MESSAGES: Record<UploadErrorCode, string> = {
	NETWORK_OR_CORS:
		"Could not reach storage. Check your connection or contact support if this persists.",
	STORAGE_REJECTED:
		"Upload was rejected by storage. The link may have expired — please try again.",
	FILE_TOO_LARGE: "File is too large for the storage configuration.",
	STORAGE_UNAVAILABLE:
		"Storage service is unavailable. Please try again in a moment.",
	UNAUTHORIZED: "Your session has expired. Please sign in and try again.",
	FORBIDDEN: "You do not have permission to upload to this workspace.",
	VALIDATION:
		"This file did not pass validation. Check the file type and size.",
	SERVER_ERROR: "Something went wrong on our side. Please try again.",
	UNKNOWN: "Upload failed. Please try again.",
};

function buildError(code: UploadErrorCode, cause: unknown): UploadError {
	return {
		code,
		userMessage: USER_MESSAGES[code],
		cause,
	};
}

/**
 * Reads a numeric HTTP status from either a `Response` instance or a
 * plain object that carries a `status` field (the uploader throws a synthetic
 * `{ status }` error when a non-2xx response is received).
 */
function extractHttpStatus(error: unknown): number | null {
	if (error instanceof Response) {
		return error.status;
	}
	if (
		error !== null &&
		typeof error === "object" &&
		"status" in error &&
		typeof (error as { status: unknown }).status === "number"
	) {
		return (error as { status: number }).status;
	}
	return null;
}

function mapHttpStatus(status: number): UploadErrorCode | null {
	if (status === 403) {
		return "STORAGE_REJECTED";
	}
	if (status === 413) {
		return "FILE_TOO_LARGE";
	}
	if (status >= 500 && status < 600) {
		return "STORAGE_UNAVAILABLE";
	}
	return null;
}

function mapORPCCode(code: string): UploadErrorCode | null {
	switch (code) {
		case "UNAUTHORIZED":
			return "UNAUTHORIZED";
		case "FORBIDDEN":
			return "FORBIDDEN";
		case "BAD_REQUEST":
			return "VALIDATION";
		case "INTERNAL_SERVER_ERROR":
			return "SERVER_ERROR";
		default:
			return null;
	}
}

export function mapUploadError(error: unknown): UploadError {
	// 1. Network / CORS — browser `fetch` throws a `TypeError` whose message
	//    matches /fetch/i when the request never reaches the server (CORS
	//    preflight, DNS failure, offline). Status-less, so this must come
	//    BEFORE the HTTP-status branch.
	if (error instanceof TypeError && /fetch/i.test(error.message)) {
		return buildError("NETWORK_OR_CORS", error);
	}

	// 2. ORPCError — checked BEFORE the generic HTTP-status branch because
	//    ORPCError carries its own `.status` (e.g. 403 for FORBIDDEN, 500 for
	//    INTERNAL_SERVER_ERROR) and we want the structured `.code` field to
	//    win over a numeric-status lookup. `instanceof` works cross-context
	//    thanks to a custom `Symbol.hasInstance` on the class (see
	//    @orpc/client source).
	if (error instanceof ORPCError) {
		const code = mapORPCCode(error.code);
		if (code !== null) {
			return buildError(code, error);
		}
		return buildError("UNKNOWN", error);
	}

	// 3. HTTP status from either a `Response` or a synthetic `{ status }`
	//    error from the uploader's `!uploadResponse.ok` branch. The
	//    decision-rules table in spec §6c scopes this branch to the storage
	//    PUT response.
	const status = extractHttpStatus(error);
	if (status !== null) {
		const code = mapHttpStatus(status);
		if (code !== null) {
			return buildError(code, error);
		}
	}

	// 4. Anything else.
	return buildError("UNKNOWN", error);
}
