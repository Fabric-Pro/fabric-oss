/**
 * Tests for the error classifier used to map thrown values onto the
 * bounded `error_class` label on `app_errors_total`.
 *
 * No mocks — exercises real Error subclasses and ORPCError shapes.
 */

import { describe, expect, it } from "vitest";
import { classifyError } from "../lib/error-class";

/**
 * Build a duck-typed oRPC-style error without pulling `@orpc/server` into
 * `@repo/observability`'s deps. The classifier only inspects `.code` (and
 * sometimes `.status`), so a plain object is enough.
 */
function orpcError(code: string, status?: number): Error {
	const err = new Error(code);
	(err as Error & { code: string; status?: number }).code = code;
	if (status !== undefined) {
		(err as Error & { status: number }).status = status;
	}
	return err;
}

describe("classifyError", () => {
	describe("oRPC error codes", () => {
		it("maps BAD_REQUEST to validation", () => {
			expect(classifyError(orpcError("BAD_REQUEST"))).toBe("validation");
		});

		it("maps NOT_FOUND to downstream_4xx", () => {
			expect(classifyError(orpcError("NOT_FOUND"))).toBe(
				"downstream_4xx",
			);
		});

		it("maps FORBIDDEN to downstream_4xx", () => {
			expect(classifyError(orpcError("FORBIDDEN"))).toBe(
				"downstream_4xx",
			);
		});

		it("maps UNAUTHORIZED to downstream_4xx", () => {
			expect(classifyError(orpcError("UNAUTHORIZED"))).toBe(
				"downstream_4xx",
			);
		});

		it("maps TOO_MANY_REQUESTS to rate_limit", () => {
			expect(classifyError(orpcError("TOO_MANY_REQUESTS"))).toBe(
				"rate_limit",
			);
		});

		it("maps INTERNAL_SERVER_ERROR to 5xx", () => {
			expect(classifyError(orpcError("INTERNAL_SERVER_ERROR"))).toBe(
				"5xx",
			);
		});

		it("maps SERVICE_UNAVAILABLE to 5xx", () => {
			expect(classifyError(orpcError("SERVICE_UNAVAILABLE"))).toBe("5xx");
		});
	});

	describe("timeouts", () => {
		it("classifies AbortError as timeout", () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			expect(classifyError(err)).toBe("timeout");
		});

		it("classifies messages containing 'timeout' as timeout", () => {
			expect(
				classifyError(new Error("Request timed out after 30s")),
			).toBe("timeout");
		});
	});

	describe("HTTP-style status codes", () => {
		it("classifies 5xx-status errors as 5xx", () => {
			const err = Object.assign(new Error("server bork"), {
				status: 503,
			});
			expect(classifyError(err)).toBe("5xx");
		});

		it("classifies 4xx-status errors as downstream_4xx", () => {
			const err = Object.assign(new Error("nope"), { status: 404 });
			expect(classifyError(err)).toBe("downstream_4xx");
		});

		it("classifies 429-status errors as rate_limit", () => {
			const err = Object.assign(new Error("throttled"), { status: 429 });
			expect(classifyError(err)).toBe("rate_limit");
		});
	});

	describe("Prisma errors", () => {
		it("classifies PrismaClientKnownRequestError as downstream_4xx", () => {
			const err = new Error("constraint failed");
			err.name = "PrismaClientKnownRequestError";
			expect(classifyError(err)).toBe("downstream_4xx");
		});

		it("classifies PrismaClientValidationError as downstream_4xx", () => {
			const err = new Error("validation");
			err.name = "PrismaClientValidationError";
			expect(classifyError(err)).toBe("downstream_4xx");
		});

		it("classifies PrismaClientRustPanicError as 5xx", () => {
			const err = new Error("engine crashed");
			err.name = "PrismaClientRustPanicError";
			expect(classifyError(err)).toBe("5xx");
		});
	});

	describe("Zod validation errors", () => {
		it("classifies ZodError as validation", () => {
			const err = new Error("parse failure");
			err.name = "ZodError";
			expect(classifyError(err)).toBe("validation");
		});
	});

	describe("defensive behavior", () => {
		it("returns 'unknown' for null", () => {
			expect(classifyError(null)).toBe("unknown");
		});

		it("returns 'unknown' for undefined", () => {
			expect(classifyError(undefined)).toBe("unknown");
		});

		it("returns 'unhandled' for plain Error", () => {
			expect(classifyError(new Error("oops"))).toBe("unhandled");
		});

		it("returns 'unhandled' for string throws", () => {
			expect(classifyError("string error" as unknown)).toBe("unhandled");
		});

		it("never throws — survives an exotic object", () => {
			const exotic = Object.create(null) as Record<string, unknown>;
			exotic.message = 42; // Wrong type on purpose.
			expect(() => classifyError(exotic)).not.toThrow();
		});
	});
});
