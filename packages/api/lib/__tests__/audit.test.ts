/**
 * Unit tests for `recordAuditFromRequest` and `wireAuditObservability`.
 *
 * Verifies the request-context wrapper:
 *  - Pulls ipAddress / userAgent / requestId / sessionId / impersonatedById
 *    from the active oRPC context shape.
 *  - Defaults the actor from context.user when no override is provided.
 *  - Honours an explicit actor override.
 *  - Falls back to system actor when context.user is missing.
 *  - Reads `x-correlation-id` as a fallback for `x-request-id`.
 *  - Normalises "unknown" from getTrustedClientIp to null.
 *
 * Run with: pnpm --filter @repo/api test lib/__tests__/audit.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories are hoisted by vitest. Use vi.hoisted to create the
// shared mock fns so the factory can close over them safely.
const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
	setAuditCountersMock: vi.fn(),
	setPrismaQueryObserverMock: vi.fn(),
	auditWriteFailuresIncMock: vi.fn(),
	auditWritesTotalIncMock: vi.fn(),
	getTrustedClientIpMock: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	recordAudit: mocks.recordAuditMock,
	setAuditCounters: mocks.setAuditCountersMock,
	setPrismaQueryObserver: mocks.setPrismaQueryObserverMock,
	// `db` is imported by the module under test. A getter that throws would be
	// closer to production, but nothing here touches it and the real client
	// demands DATABASE_URL at first property access.
	db: {},
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: mocks.auditWriteFailuresIncMock },
	auditWritesTotal: { inc: mocks.auditWritesTotalIncMock },
}));

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: (headers: Headers) =>
		mocks.getTrustedClientIpMock(headers),
}));

import { recordAuditFromRequest, wireAuditObservability } from "../audit";

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
	mocks.setAuditCountersMock.mockReset();
	mocks.setPrismaQueryObserverMock.mockReset();
	mocks.auditWriteFailuresIncMock.mockReset();
	mocks.auditWritesTotalIncMock.mockReset();
	mocks.getTrustedClientIpMock.mockReset();
	mocks.getTrustedClientIpMock.mockReturnValue("203.0.113.42");
});

afterEach(() => {
	vi.restoreAllMocks();
});

function buildContext(
	overrides: {
		ip?: string;
		userAgent?: string | null;
		requestId?: string | null;
		correlationId?: string | null;
		user?: { id: string; email: string; name?: string | null } | null;
		session?: {
			id: string;
			impersonatedBy?: string | null;
			activeOrganizationId?: string | null;
		} | null;
	} = {},
) {
	const headers = new Headers();
	if (overrides.userAgent !== null && overrides.userAgent !== undefined) {
		headers.set("user-agent", overrides.userAgent);
	}
	if (overrides.requestId) {
		headers.set("x-request-id", overrides.requestId);
	}
	if (overrides.correlationId) {
		headers.set("x-correlation-id", overrides.correlationId);
	}
	if (overrides.ip) {
		mocks.getTrustedClientIpMock.mockReturnValue(overrides.ip);
	}
	return {
		headers,
		user:
			overrides.user === undefined
				? {
						id: "user-1",
						email: "alice@example.com",
						name: "Alice",
					}
				: overrides.user,
		session:
			overrides.session === undefined
				? {
						id: "sess-1",
						impersonatedBy: null,
						activeOrganizationId: "org-1",
					}
				: overrides.session,
	};
}

describe("recordAuditFromRequest", () => {
	it("pulls ipAddress, userAgent, requestId, sessionId from context", () => {
		const ctx = buildContext({
			ip: "198.51.100.7",
			userAgent: "Mozilla/5.0",
			requestId: "req-abc",
		});

		recordAuditFromRequest(ctx, {
			action: "auth.login.success",
			organizationId: "org-1",
		});

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;
		expect(arg.ipAddress).toBe("198.51.100.7");
		expect(arg.userAgent).toBe("Mozilla/5.0");
		expect(arg.requestId).toBe("req-abc");
		expect(arg.sessionId).toBe("sess-1");
	});

	it("defaults the actor from context.user when no override given", () => {
		const ctx = buildContext();

		recordAuditFromRequest(ctx, {
			action: "auth.login.success",
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: Record<string, unknown>;
		};
		expect(arg.actor.type).toBe("user");
		expect(arg.actor.userId).toBe("user-1");
		expect(arg.actor.emailSnapshot).toBe("alice@example.com");
		expect(arg.actor.nameSnapshot).toBe("Alice");
	});

	it("includes impersonatedById from session", () => {
		const ctx = buildContext({
			session: {
				id: "sess-2",
				impersonatedBy: "admin-99",
				activeOrganizationId: null,
			},
		});

		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: { impersonatedById: string | null };
		};
		expect(arg.actor.impersonatedById).toBe("admin-99");
	});

	it("falls back to x-correlation-id when x-request-id is missing", () => {
		const ctx = buildContext({ correlationId: "corr-xyz" });

		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			requestId: string | null;
		};
		expect(arg.requestId).toBe("corr-xyz");
	});

	it("returns null requestId when neither header is set", () => {
		const ctx = buildContext({});

		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			requestId: string | null;
		};
		expect(arg.requestId).toBeNull();
	});

	it("normalises 'unknown' from getTrustedClientIp to null", () => {
		const ctx = buildContext({ ip: "unknown" });

		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			ipAddress: string | null;
		};
		expect(arg.ipAddress).toBeNull();
	});

	it("falls back to system actor when context.user is null", () => {
		const ctx = buildContext({ user: null });

		recordAuditFromRequest(ctx, {
			action: "audit.retention.purged",
			category: "audit",
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: { type: string };
		};
		expect(arg.actor.type).toBe("system");
	});

	it("honours an explicit actor override", () => {
		const ctx = buildContext();

		recordAuditFromRequest(ctx, {
			action: "org.api_key.created",
			organizationId: "org-1",
			actor: {
				type: "api_key",
				userId: null,
				emailSnapshot: null,
				nameSnapshot: "key-deadbeef",
			},
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			actor: { type: string; nameSnapshot: string | null };
		};
		expect(arg.actor.type).toBe("api_key");
		expect(arg.actor.nameSnapshot).toBe("key-deadbeef");
	});
});

describe("recordAuditFromRequest - correlation ID (D16)", () => {
	it("prefers AsyncLocalStorage over header", async () => {
		const { runWithCorrelationId } = await import(
			"@repo/utils/correlation-id"
		);

		const ctx = buildContext({ correlationId: "from-header" });
		runWithCorrelationId("from-als", () => {
			recordAuditFromRequest(ctx, { action: "auth.login.success" });
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			correlationId: string | null;
		};
		expect(arg.correlationId).toBe("from-als");
	});

	it("falls back to header when ALS is empty", () => {
		const ctx = buildContext({ correlationId: "from-header-only" });
		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			correlationId: string | null;
		};
		expect(arg.correlationId).toBe("from-header-only");
	});

	it("returns null when neither ALS nor header is set", () => {
		const ctx = buildContext({});
		recordAuditFromRequest(ctx, { action: "auth.login.success" });

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			correlationId: string | null;
		};
		expect(arg.correlationId).toBeNull();
	});

	it("honors an explicit correlationId override in input", () => {
		const ctx = buildContext({ correlationId: "would-be-overridden" });
		recordAuditFromRequest(ctx, {
			action: "auth.login.success",
			correlationId: "explicit-override",
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			correlationId: string | null;
		};
		expect(arg.correlationId).toBe("explicit-override");
	});

	it("honors an explicit null override", () => {
		const ctx = buildContext({ correlationId: "would-be-overridden" });
		recordAuditFromRequest(ctx, {
			action: "auth.login.success",
			correlationId: null,
		});

		const arg = mocks.recordAuditMock.mock.calls[0]?.[0] as {
			correlationId: string | null;
		};
		expect(arg.correlationId).toBeNull();
	});
});

describe("wireAuditObservability", () => {
	it("calls setAuditCounters with wrappers around the Prometheus counters", () => {
		wireAuditObservability();

		expect(mocks.setAuditCountersMock).toHaveBeenCalledTimes(1);
		const counters = mocks.setAuditCountersMock.mock.calls[0]?.[0] as {
			incFailure: (a: string, c: string) => void;
			incWrite: (a: string, c: string, o: string) => void;
		};

		counters.incFailure("auth.login.success", "auth");
		expect(mocks.auditWriteFailuresIncMock).toHaveBeenCalledWith({
			action: "auth.login.success",
			category: "auth",
		});

		counters.incWrite("auth.login.success", "auth", "success");
		expect(mocks.auditWritesTotalIncMock).toHaveBeenCalledWith({
			action: "auth.login.success",
			category: "auth",
			outcome: "success",
		});
	});
});
