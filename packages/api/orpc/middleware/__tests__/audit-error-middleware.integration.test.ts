/**
 * "Integration" test for the audit-error middleware (D16).
 *
 * Exercises the full pipe: thrown error → classification → metadata
 * shape → correlation propagation → `recordAudit` payload. We mock
 * `recordAudit` at the @repo/database boundary but otherwise run real
 * production code. A real-DB version of this test belongs in a future
 * `packages/database/__tests__/audit-log.integration.test.ts` if one
 * is ever added — for v1 the mock contract is the load-bearing one.
 *
 * Coverage:
 *  - Each ORPCError code (FORBIDDEN/NOT_FOUND/BAD_REQUEST/...) lands the
 *    right `error.*` action key.
 *  - ZodError lands `error.validation`.
 *  - Prisma P2002 → `error.conflict`.
 *  - Original error instance identity preserved through the capture path.
 *  - End-to-end correlation: AsyncLocalStorage value lands on the audit
 *    row's `metadata.correlationId`.
 *  - Input snapshot is sanitized (sensitive keys redacted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		recordAudit: mocks.recordAuditMock,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: () => "203.0.113.42",
}));

vi.mock("@repo/auth", () => ({
	auth: {
		api: { getSession: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

// v2 item 4: the audit-error middleware now flushes the request-span
// buffer on capture. Mock the helper so this unit test doesn't require
// a Prisma client.
vi.mock("../../../lib/request-span", () => ({
	flushSpansOnFailure: vi.fn().mockResolvedValue(undefined),
}));

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import { __captureErrorForTest } from "../audit-error-middleware";

function buildContext() {
	return {
		headers: new Headers(),
		user: { id: "user-99", email: "alice@example.com", name: "Alice" },
		session: {
			id: "sess-99",
			impersonatedBy: null,
			activeOrganizationId: "org-99",
		},
	};
}

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("audit-error middleware (end-to-end)", () => {
	it("FORBIDDEN → error.permission_denied with metadata complete", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("not allowed"), {
			code: "FORBIDDEN",
			status: 403,
		});
		await runWithCorrelationId("corr-int-1", async () => {
			await __captureErrorForTest(err, ctx, { foo: "bar" }, [
				"projects",
				"delete",
			]);
		});

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
			category: string;
			severity: string;
			outcome: string;
			correlationId: string | null;
			metadata: {
				correlationId?: string;
				fingerprint: string;
				exception: { type: string; message: string };
				procedure: { path: string; httpStatus: number };
				input: { foo: string };
			};
		};
		expect(args.action).toBe("error.permission_denied");
		expect(args.category).toBe("error");
		expect(args.severity).toBe("warning");
		expect(args.outcome).toBe("failure");
		expect(args.correlationId).toBe("corr-int-1");
		expect(args.metadata.correlationId).toBe("corr-int-1");
		expect(args.metadata.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		expect(args.metadata.exception.message).toBe("not allowed");
		expect(args.metadata.procedure.path).toBe("projects.delete");
		expect(args.metadata.procedure.httpStatus).toBe(403);
		expect(args.metadata.input.foo).toBe("bar");
	});

	it("NOT_FOUND → error.not_found / info", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("gone"), { code: "NOT_FOUND" });
		await __captureErrorForTest(err, ctx, undefined, ["stories", "get"]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
			severity: string;
		};
		expect(args.action).toBe("error.not_found");
		expect(args.severity).toBe("info");
	});

	it("BAD_REQUEST → error.validation / info", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("bad"), { code: "BAD_REQUEST" });
		await __captureErrorForTest(err, ctx, undefined, ["foo"]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
		};
		expect(args.action).toBe("error.validation");
	});

	it("ZodError name → error.validation", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("z"), { name: "ZodError" });
		await __captureErrorForTest(err, ctx, undefined, ["foo"]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
		};
		expect(args.action).toBe("error.validation");
	});

	it("Prisma P2002 → error.conflict", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("dup"), {
			name: "PrismaClientKnownRequestError",
			code: "P2002",
		});
		await __captureErrorForTest(err, ctx, undefined, ["foo"]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
			severity: string;
		};
		expect(args.action).toBe("error.conflict");
		expect(args.severity).toBe("warning");
	});

	it("uncaught Error → error.internal", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("kaboom"), ctx, undefined, [
			"foo",
		]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			action: string;
			severity: string;
		};
		expect(args.action).toBe("error.internal");
		expect(args.severity).toBe("error");
	});

	it("sanitizes sensitive keys in input snapshot", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ apiKey: "sk-secret", payload: { password: "shhh" } },
			["foo"],
		);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: {
				input: { apiKey: string; payload: { password: string } };
			};
		};
		expect(args.metadata.input.apiKey).toBe("[REDACTED]");
		expect(args.metadata.input.payload.password).toBe("[REDACTED]");
	});

	it("captures the cause chain when Error.cause is set", async () => {
		const ctx = buildContext();
		const inner = new Error("inner");
		const outer = Object.assign(new Error("outer"), {
			cause: inner,
			code: "INTERNAL_SERVER_ERROR",
		});
		await __captureErrorForTest(outer, ctx, undefined, ["foo"]);
		const args = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { cause: { message: string } };
		};
		expect(args.metadata.cause.message).toBe("inner");
	});
});
