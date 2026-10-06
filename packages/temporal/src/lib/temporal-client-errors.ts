/**
 * Classifies an error thrown by the Temporal client (start, describe,
 * result, cancel) so a caller can tell "the run definitely does not exist /
 * definitely was not started" from "the service could not answer".
 *
 * The client wraps RPC failures in `ServiceError` with the gRPC status in
 * `cause`, so only walking the cause chain sees the code; reading the outer
 * error alone misses it. The SDK's own predicates (`isGrpcServiceError` and
 * the error classes) are used, with the class NAME accepted too, because
 * the SDK marks its errors by name across module copies.
 *
 * Kinds:
 *   - `not_found`: the workflow (execution) does not exist;
 *   - `already_started`: a start found an execution with this id;
 *   - `execution_failed`: the run itself ended in failure (result());
 *   - `transient`: the service was unreachable, timed out, or could not
 *     say — the request may or may not have been applied;
 *   - `definite`: the request was refused and nothing happened.
 */

import {
	isGrpcServiceError,
	ServiceError,
	WorkflowExecutionAlreadyStartedError,
	WorkflowFailedError,
	WorkflowNotFoundError,
} from "@temporalio/client";

export type TemporalClientErrorKind =
	| "not_found"
	| "already_started"
	| "execution_failed"
	| "transient"
	| "definite";

/** gRPC status codes after which the request may or may not have applied. */
const TRANSIENT_GRPC_CODES = new Set([
	1, // CANCELLED
	2, // UNKNOWN
	4, // DEADLINE_EXCEEDED
	8, // RESOURCE_EXHAUSTED
	10, // ABORTED
	13, // INTERNAL
	14, // UNAVAILABLE
]);
const GRPC_NOT_FOUND = 5;
const GRPC_ALREADY_EXISTS = 6;

function hasName(error: unknown, name: string): boolean {
	return error instanceof Error && error.name === name;
}

export function classifyTemporalClientError(
	error: unknown,
): TemporalClientErrorKind {
	let current: unknown = error;
	let sawServiceError = false;
	for (let depth = 0; current && depth < 6; depth++) {
		if (
			current instanceof WorkflowNotFoundError ||
			hasName(current, "WorkflowNotFoundError")
		) {
			return "not_found";
		}
		if (
			current instanceof WorkflowExecutionAlreadyStartedError ||
			hasName(current, "WorkflowExecutionAlreadyStartedError")
		) {
			return "already_started";
		}
		if (
			current instanceof WorkflowFailedError ||
			hasName(current, "WorkflowFailedError")
		) {
			return "execution_failed";
		}
		if (isGrpcServiceError(current)) {
			const code = (current as { code?: number }).code;
			if (code === GRPC_NOT_FOUND) {
				return "not_found";
			}
			if (code === GRPC_ALREADY_EXISTS) {
				return "already_started";
			}
			return code !== undefined && TRANSIENT_GRPC_CODES.has(code)
				? "transient"
				: "definite";
		}
		if (
			current instanceof ServiceError ||
			hasName(current, "ServiceError")
		) {
			sawServiceError = true;
		}
		current = (current as { cause?: unknown }).cause;
	}
	// A service error with no status underneath could not say what
	// happened; anything else is a local, definite failure.
	return sawServiceError ? "transient" : "definite";
}
