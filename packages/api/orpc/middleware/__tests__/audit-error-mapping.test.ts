/**
 * Unit tests for `classifyError` (D16).
 *
 * Coverage:
 *  - ORPCError code branches (FORBIDDEN, NOT_FOUND, BAD_REQUEST,
 *    TOO_MANY_REQUESTS, SERVICE_UNAVAILABLE, TIMEOUT, CONFLICT,
 *    INTERNAL_SERVER_ERROR).
 *  - Zod failure (name === "ZodError").
 *  - Prisma known-request error codes (P2002, P2025) and unknown ones.
 *  - Prisma client-init / rust-panic / unknown-request → critical.
 *  - Fallback path: plain Error, primitives, null/undefined.
 */

import { describe, expect, it } from "vitest";
import { classifyError } from "../audit-error-mapping";

describe("classifyError - ORPCError codes", () => {
	it("FORBIDDEN → permission_denied/warning", () => {
		const result = classifyError({ code: "FORBIDDEN" });
		expect(result).toEqual({
			action: "error.permission_denied",
			severity: "warning",
		});
	});

	it("UNAUTHORIZED → permission_denied/warning", () => {
		const result = classifyError({ code: "UNAUTHORIZED" });
		expect(result).toEqual({
			action: "error.permission_denied",
			severity: "warning",
		});
	});

	it("NOT_FOUND → not_found/info", () => {
		const result = classifyError({ code: "NOT_FOUND" });
		expect(result).toEqual({ action: "error.not_found", severity: "info" });
	});

	it("BAD_REQUEST → validation/info", () => {
		const result = classifyError({ code: "BAD_REQUEST" });
		expect(result).toEqual({
			action: "error.validation",
			severity: "info",
		});
	});

	it("TOO_MANY_REQUESTS → rate_limited/warning", () => {
		const result = classifyError({ code: "TOO_MANY_REQUESTS" });
		expect(result).toEqual({
			action: "error.rate_limited",
			severity: "warning",
		});
	});

	it("SERVICE_UNAVAILABLE → unavailable/error", () => {
		const result = classifyError({ code: "SERVICE_UNAVAILABLE" });
		expect(result).toEqual({
			action: "error.unavailable",
			severity: "error",
		});
	});

	it("TIMEOUT → timeout/error", () => {
		const result = classifyError({ code: "TIMEOUT" });
		expect(result).toEqual({ action: "error.timeout", severity: "error" });
	});

	it("CONFLICT → conflict/warning", () => {
		const result = classifyError({ code: "CONFLICT" });
		expect(result).toEqual({
			action: "error.conflict",
			severity: "warning",
		});
	});

	it("INTERNAL_SERVER_ERROR → internal/error", () => {
		const result = classifyError({ code: "INTERNAL_SERVER_ERROR" });
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});

	it("unknown ORPCError code falls through to internal/error", () => {
		const result = classifyError({ code: "TEAPOT_ERROR" });
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});
});

describe("classifyError - ZodError", () => {
	it("name=ZodError → validation/info", () => {
		const result = classifyError({ name: "ZodError" });
		expect(result).toEqual({
			action: "error.validation",
			severity: "info",
		});
	});

	it("ZodError takes precedence over no code", () => {
		// A real ZodError instance has no `code` field. Make sure the name
		// path fires even when the code path returns nothing.
		const err = new Error("z fail");
		err.name = "ZodError";
		const result = classifyError(err);
		expect(result.action).toBe("error.validation");
	});
});

describe("classifyError - Prisma", () => {
	it("PrismaClientKnownRequestError P2002 → conflict/warning", () => {
		const err = {
			name: "PrismaClientKnownRequestError",
			code: "P2002",
		};
		const result = classifyError(err);
		expect(result).toEqual({
			action: "error.conflict",
			severity: "warning",
		});
	});

	it("PrismaClientKnownRequestError P2025 → not_found/info", () => {
		const err = {
			name: "PrismaClientKnownRequestError",
			code: "P2025",
		};
		const result = classifyError(err);
		expect(result).toEqual({ action: "error.not_found", severity: "info" });
	});

	it("PrismaClientKnownRequestError unknown code → internal/error", () => {
		const err = {
			name: "PrismaClientKnownRequestError",
			code: "P9999",
		};
		const result = classifyError(err);
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});

	it("PrismaClientUnknownRequestError → internal/critical", () => {
		const err = { name: "PrismaClientUnknownRequestError" };
		const result = classifyError(err);
		expect(result).toEqual({
			action: "error.internal",
			severity: "critical",
		});
	});

	it("PrismaClientRustPanicError → internal/critical", () => {
		const err = { name: "PrismaClientRustPanicError" };
		const result = classifyError(err);
		expect(result).toEqual({
			action: "error.internal",
			severity: "critical",
		});
	});

	it("PrismaClientInitializationError → internal/critical", () => {
		const err = { name: "PrismaClientInitializationError" };
		const result = classifyError(err);
		expect(result).toEqual({
			action: "error.internal",
			severity: "critical",
		});
	});
});

describe("classifyError - fallback", () => {
	it("plain Error → internal/error", () => {
		const result = classifyError(new Error("boom"));
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});

	it("null → internal/error", () => {
		const result = classifyError(null);
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});

	it("undefined → internal/error", () => {
		const result = classifyError(undefined);
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});

	it("string → internal/error", () => {
		const result = classifyError("string failure");
		expect(result).toEqual({ action: "error.internal", severity: "error" });
	});
});
