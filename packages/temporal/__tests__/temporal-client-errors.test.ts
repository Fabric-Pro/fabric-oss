/**
 * `classifyTemporalClientError` — the Temporal client wraps RPC failures in
 * `ServiceError` with the gRPC status in `cause`, so a classifier that reads
 * only the outer error mistakes an ambiguous start (the start may have
 * succeeded and only its response was lost) for a definite failure. The
 * chat starters keep a turn START_PENDING on `transient` and mark it FAILED
 * only on `definite`.
 */

import {
	ServiceError,
	WorkflowExecutionAlreadyStartedError,
	WorkflowFailedError,
	WorkflowNotFoundError,
} from "@temporalio/client";
import { RetryState } from "@temporalio/common";
import { describe, expect, it } from "vitest";
import { classifyTemporalClientError } from "../src/lib/temporal-client-errors";

/** A grpc-js status error, as the client's connection raises it. */
function grpcError(code: number) {
	return Object.assign(new Error(`${code} status`), {
		code,
		details: "status details",
		metadata: {},
	});
}

describe("classifyTemporalClientError", () => {
	it("sees UNAVAILABLE inside a ServiceError as transient", () => {
		const error = new ServiceError("Failed to start Workflow", {
			cause: grpcError(14),
		});
		expect(classifyTemporalClientError(error)).toBe("transient");
	});

	it("sees DEADLINE_EXCEEDED inside a ServiceError as transient", () => {
		expect(
			classifyTemporalClientError(
				new ServiceError("x", { cause: grpcError(4) }),
			),
		).toBe("transient");
	});

	it("sees INVALID_ARGUMENT inside a ServiceError as definite", () => {
		expect(
			classifyTemporalClientError(
				new ServiceError("x", { cause: grpcError(3) }),
			),
		).toBe("definite");
	});

	it("sees NOT_FOUND / ALREADY_EXISTS statuses for what they are", () => {
		expect(
			classifyTemporalClientError(
				new ServiceError("x", { cause: grpcError(5) }),
			),
		).toBe("not_found");
		expect(
			classifyTemporalClientError(
				new ServiceError("x", { cause: grpcError(6) }),
			),
		).toBe("already_started");
	});

	it("recognizes the SDK's own error classes", () => {
		expect(
			classifyTemporalClientError(
				new WorkflowNotFoundError("gone", "wf", undefined),
			),
		).toBe("not_found");
		expect(
			classifyTemporalClientError(
				new WorkflowExecutionAlreadyStartedError("dup", "wf", "type"),
			),
		).toBe("already_started");
		expect(
			classifyTemporalClientError(
				new WorkflowFailedError(
					"failed",
					undefined,
					RetryState.NON_RETRYABLE_FAILURE,
				),
			),
		).toBe("execution_failed");
	});

	it("treats a ServiceError with no status as transient and a plain error as definite", () => {
		expect(classifyTemporalClientError(new ServiceError("no status"))).toBe(
			"transient",
		);
		expect(classifyTemporalClientError(new TypeError("bad input"))).toBe(
			"definite",
		);
	});
});
