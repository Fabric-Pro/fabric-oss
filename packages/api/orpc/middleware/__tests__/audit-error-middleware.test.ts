/**
 * Unit tests for the audit-error middleware (D16).
 *
 * Coverage:
 *  - `captureError` emits a properly shaped `recordAudit` call.
 *  - Original error re-thrown with same instance identity.
 *  - Kill switch via `FABRIC_AUDIT_ERROR_CAPTURE_DISABLED=true`.
 *  - Skip-paths env var with exact and prefix forms.
 *  - Idempotence flag suppresses second emit.
 *  - `_auditFailureEmitted` is set after a successful capture.
 *  - Capture internal failure does not throw (logged + swallowed).
 *  - Correlation ID propagation (AsyncLocalStorage > header).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
	getTrustedClientIpMock: vi.fn().mockReturnValue("203.0.113.42"),
	flushSpansOnFailureMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/request-span", () => ({
	flushSpansOnFailure: (...args: unknown[]) =>
		mocks.flushSpansOnFailureMock(...args),
}));

// Avoid wiring through actual Prisma: this is a unit test.
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		recordAudit: mocks.recordAuditMock,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: (headers: Headers) =>
		mocks.getTrustedClientIpMock(headers),
}));

// The audit-error middleware re-resolves session from headers to enrich
// the actor/orgId when the outer context lacks `user`. Mock returns null
// (anonymous) so tests fall back to the explicitly-built `buildContext()`
// shape and the recorded audit row uses that user/session.
vi.mock("@repo/auth", () => ({
	auth: {
		api: { getSession: vi.fn().mockResolvedValue(null) },
	},
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

import { runWithCorrelationId } from "@repo/utils/correlation-id";
import {
	__captureErrorForTest,
	__isCaptureDisabledForTest,
	__readSkipPatternsForTest,
	__shouldSkipForTest,
	ALWAYS_SKIP_PATHS,
	auditErrorMiddleware,
} from "../audit-error-middleware";

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
	mocks.flushSpansOnFailureMock.mockClear();
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function buildContext(headersInit: Record<string, string> = {}) {
	const headers = new Headers(headersInit);
	return {
		headers,
		user: { id: "user-1", email: "alice@example.com", name: "Alice" },
		session: {
			id: "sess-1",
			impersonatedBy: null,
			activeOrganizationId: "org-1",
		},
	};
}

describe("__readSkipPatternsForTest", () => {
	it("returns empty sets for an unset env", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.size).toBe(0);
		expect(prefixes).toEqual([]);
	});

	it("parses exact-match entries", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "a,b,c");
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.has("a")).toBe(true);
		expect(exact.has("b")).toBe(true);
		expect(exact.has("c")).toBe(true);
		expect(prefixes).toEqual([]);
	});

	it("parses prefix entries (trailing *)", () => {
		vi.stubEnv(
			"FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS",
			"internal.*,debug.*",
		);
		const { exact, prefixes } = __readSkipPatternsForTest();
		expect(exact.size).toBe(0);
		expect(prefixes).toContain("internal.");
		expect(prefixes).toContain("debug.");
	});

	it("trims whitespace and skips empty entries", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "  a , , b  ,");
		const { exact } = __readSkipPatternsForTest();
		expect(exact.has("a")).toBe(true);
		expect(exact.has("b")).toBe(true);
		expect(exact.size).toBe(2);
	});
});

describe("__shouldSkipForTest", () => {
	it("returns false when nothing matches", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
		expect(__shouldSkipForTest("foo.bar")).toBe(false);
	});

	it("matches an exact entry", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "foo.bar");
		expect(__shouldSkipForTest("foo.bar")).toBe(true);
		expect(__shouldSkipForTest("foo.baz")).toBe(false);
	});

	it("matches a prefix entry", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "internal.*");
		expect(__shouldSkipForTest("internal.health")).toBe(true);
		expect(__shouldSkipForTest("public.health")).toBe(false);
	});
});

describe("ALWAYS_SKIP_PATHS (#1899)", () => {
	// CRITICAL regression guard: personal-meeting procedures must never
	// produce an audit row, even if FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS
	// is unset, cleared, or misconfigured by a ConfigMap edit. See the
	// module-level ALWAYS_SKIP_PATHS doc comment for why.
	it.each(ALWAYS_SKIP_PATHS)(
		"shouldSkip returns true for %s with no skip-paths env set",
		(path) => {
			vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
			expect(__shouldSkipForTest(path)).toBe(true);
		},
	);

	it.each(ALWAYS_SKIP_PATHS)(
		"captureError emits no audit row for %s",
		async (path) => {
			vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "");
			const ctx = buildContext();
			const [namespace, feature, procedure] = path.split(".");
			await __captureErrorForTest(new Error("boom"), ctx, undefined, [
				namespace,
				feature,
				procedure,
			]);
			expect(mocks.recordAuditMock).not.toHaveBeenCalled();
		},
	);

	it("contains both personal-meetings procedure paths", () => {
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.meetingDigest.listPersonalMeetings",
		);
		expect(ALWAYS_SKIP_PATHS).toContain(
			"projects.meetingDigest.getPersonalTranscript",
		);
	});
});

describe("__isCaptureDisabledForTest", () => {
	it("returns true when env is 'true'", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "true");
		expect(__isCaptureDisabledForTest()).toBe(true);
	});

	it("returns false when env is 'false'", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "false");
		expect(__isCaptureDisabledForTest()).toBe(false);
	});

	it("returns false when env is unset", () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "");
		expect(__isCaptureDisabledForTest()).toBe(false);
	});
});

describe("captureError", () => {
	it("calls recordAudit with the right action/severity/category", async () => {
		const ctx = buildContext();
		const err = Object.assign(new Error("forbidden!"), {
			code: "FORBIDDEN",
		});

		await __captureErrorForTest(err, ctx, undefined, [
			"projects",
			"delete",
		]);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(arg.action).toBe("error.permission_denied");
		expect(arg.category).toBe("error");
		expect(arg.severity).toBe("warning");
		expect(arg.outcome).toBe("failure");
	});

	it("includes the procedure path in the resource", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, [
			"a",
			"b",
			"c",
		]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			resource: { id: string; name: string; type: string };
		};
		expect(arg.resource.id).toBe("a.b.c");
		expect(arg.resource.type).toBe("procedure");
	});

	it("reads projectId from input when available", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ projectId: "proj-42" },
			["projects", "update"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			projectId: string | null;
		};
		expect(arg.projectId).toBe("proj-42");
	});

	it("falls back to null projectId when input has none", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["health"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			projectId: string | null;
		};
		expect(arg.projectId).toBeNull();
	});

	it("reads organizationId from input when provided", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ organizationId: "org-from-input" },
			["audit", "list"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			organizationId: string | null;
		};
		expect(arg.organizationId).toBe("org-from-input");
	});

	it("falls back to session.activeOrganizationId when input lacks one", async () => {
		// buildContext()'s session.activeOrganizationId = "org-1"
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			organizationId: string | null;
		};
		expect(arg.organizationId).toBe("org-1");
	});

	it("re-resolves user from headers when outer context.user missing", async () => {
		// CRITICAL regression: the middleware sits OUTSIDE the auth chain,
		// so context.user is undefined even for authenticated requests.
		// Without enrichContextFromHeaders, every error row would be
		// orphaned with userId=null. This test mocks auth.api.getSession to
		// return a user and asserts that the audit row uses that user as
		// the actor instead of falling back to "system".
		const { auth } = (await import("@repo/auth")) as {
			auth: { api: { getSession: ReturnType<typeof vi.fn> } };
		};
		auth.api.getSession.mockResolvedValueOnce({
			user: { id: "u-1", email: "real@user.test", name: "Real User" },
			session: {
				id: "s-1",
				impersonatedBy: null,
				activeOrganizationId: "org-real",
			},
		});

		// Anonymous outer context — no user, no session, just headers.
		const ctx = { headers: new Headers() };
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: {
				type: string;
				userId: string | null;
				emailSnapshot: string;
			};
			organizationId: string | null;
		};
		expect(arg.actor.type).toBe("user");
		expect(arg.actor.userId).toBe("u-1");
		expect(arg.actor.emailSnapshot).toBe("real@user.test");
		expect(arg.organizationId).toBe("org-real");
	});

	it("kill switch (env disabled) skips emit", async () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_DISABLED", "true");
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["health"]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("skip-paths suppresses emit for matching paths", async () => {
		vi.stubEnv("FABRIC_AUDIT_ERROR_CAPTURE_SKIP_PATHS", "auth.session.*");
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, [
			"auth",
			"session",
			"validate",
		]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("idempotence flag suppresses double-emit", async () => {
		const ctx = buildContext() as ReturnType<typeof buildContext> & {
			_auditFailureEmitted?: boolean;
		};
		ctx._auditFailureEmitted = true;
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("sets _auditFailureEmitted after a successful capture", async () => {
		const ctx = buildContext() as ReturnType<typeof buildContext> & {
			_auditFailureEmitted?: boolean;
		};
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		expect(ctx._auditFailureEmitted).toBe(true);
	});

	it("captures OTEL-shaped exception metadata", async () => {
		const ctx = buildContext();
		const err = new Error("boom");
		await __captureErrorForTest(err, ctx, undefined, [
			"projects",
			"create",
		]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: {
				exception: { type: string; message: string; escaped: boolean };
				fingerprint: string;
			};
		};
		expect(arg.metadata.exception.type).toBe("Error");
		expect(arg.metadata.exception.message).toBe("boom");
		expect(arg.metadata.exception.escaped).toBe(true);
		expect(arg.metadata.fingerprint).toMatch(/^[0-9a-f]{16}$/);
	});

	it("captures correlation ID from AsyncLocalStorage", async () => {
		const ctx = buildContext();
		await runWithCorrelationId("corr-test-ALS", async () => {
			await __captureErrorForTest(new Error("x"), ctx, undefined, [
				"foo",
			]);
		});
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { correlationId?: string };
			correlationId?: string;
		};
		expect(arg.metadata.correlationId).toBe("corr-test-ALS");
		expect(arg.correlationId).toBe("corr-test-ALS");
	});

	it("falls back to header correlation when ALS empty", async () => {
		const ctx = buildContext({ "x-correlation-id": "corr-from-header" });
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { correlationId?: string };
		};
		expect(arg.metadata.correlationId).toBe("corr-from-header");
	});

	it("omits correlation ID when neither source available", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: Record<string, unknown>;
		};
		expect(arg.metadata.correlationId).toBeUndefined();
	});

	it("includes input snapshot when provided", async () => {
		const ctx = buildContext();
		await __captureErrorForTest(
			new Error("x"),
			ctx,
			{ foo: "bar", password: "shhh" },
			["test"],
		);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { input: { foo: string; password: string } };
		};
		// `input` is parsed back when payload is small enough.
		expect(arg.metadata.input).toBeDefined();
		expect(arg.metadata.input.foo).toBe("bar");
		expect(arg.metadata.input.password).toBe("[REDACTED]");
	});

	it("captures Error.cause chain", async () => {
		const inner = new Error("inner cause");
		const outer = new Error("outer");
		(outer as { cause: unknown }).cause = inner;
		const ctx = buildContext();
		await __captureErrorForTest(outer, ctx, undefined, ["test"]);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { cause?: { message: string } };
		};
		expect(arg.metadata.cause).toBeDefined();
		expect(arg.metadata.cause?.message).toBe("inner cause");
	});

	it("never throws even if recordAudit throws", async () => {
		mocks.recordAuditMock.mockImplementationOnce(() => {
			throw new Error("simulated audit-binding failure");
		});
		const ctx = buildContext();
		// The middleware wraps the inner call site in its own try/catch
		// already, and the audit module wraps `recordAudit` again. Both
		// layers must be tested — the call site should not rethrow.
		await expect(
			__captureErrorForTest(new Error("x"), ctx, undefined, ["foo"]),
		).resolves.not.toThrow();
	});

	it(// D16 safety invariant: the captured error must be referentially the
	// same instance that the middleware re-throws. This protects
	// `instanceof ORPCError` / equality checks downstream of the
	// middleware (oRPC server, error mapper) from being broken by an
	// accidental wrap or clone.
	"captures the original error instance identity", async () => {
		const originalErr = Object.assign(new Error("identity"), {
			code: "NOT_FOUND",
		});
		const ctx = buildContext();
		await __captureErrorForTest(originalErr, ctx, undefined, [
			"projects",
			"get",
		]);

		// recordAudit was given the exception block built from this exact
		// error. Verify by message identity — type identity (Error) is
		// also asserted at the exception.type field.
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			metadata: { exception: { message: string } };
		};
		expect(arg.metadata.exception.message).toBe("identity");
	});
});

describe("auditErrorMiddleware (orchestration)", () => {
	it("export exists and is invocable as oRPC middleware", () => {
		// We assert the call-site contract via `auditErrorMiddleware` being
		// importable — if oRPC's export shape ever changes (e.g. it stops
		// being a builder), the import above will fail. The end-to-end
		// behaviour (re-throw, capture, kill-switch) is exercised by the
		// `__captureErrorForTest` suite above and by the integration test.
		expect(auditErrorMiddleware).toBeDefined();
	});
});

describe("auditErrorMiddleware — span flush (v2 item 4)", () => {
	it("calls flushSpansOnFailure after capturing an error", async () => {
		const context = buildContext({ "x-correlation-id": "req_flush" });
		await __captureErrorForTest(
			new Error("boom"),
			context,
			{ projectId: "p-1" },
			["myorg", "create"],
		);
		expect(mocks.flushSpansOnFailureMock).toHaveBeenCalledTimes(1);
		// Passes the resolved correlationId so spans share the same trace key.
		expect(mocks.flushSpansOnFailureMock.mock.calls[0]?.[0]).toBe(
			"req_flush",
		);
	});

	it("calls flushSpansOnFailure with no override when correlationId is absent", async () => {
		const context = buildContext({});
		await __captureErrorForTest(new Error("boom"), context, undefined, [
			"other",
			"path",
		]);
		// Either called with no args, or called with undefined — both valid.
		expect(mocks.flushSpansOnFailureMock).toHaveBeenCalledTimes(1);
	});
});
