/**
 * Tests for the `audit.list` procedure handler.
 *
 * Each test calls the handler directly via `procedure["~orpc"].handler`
 * to bypass the middleware pipeline (the deployment-admin/membership
 * check is covered by `require-audit-log-read.test.ts`). This is the
 * same pattern other procedure tests in this repo use (see
 * `__tests__/mcp-tenant-isolation.test.ts`).
 *
 * Spec: docs/audit-log/README.md §13.2.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listAuditLog: vi.fn(),
	recordAudit: vi.fn(),
	getTrustedClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

// `importActual` lets the procedures' transitive dependencies (e.g.
// `@repo/ai` reading `DB_GATEWAY_PROVIDERS`) keep working. We only
// override the symbols we drive directly. Per the warning in
// `mcp-tenant-isolation.test.ts`, importActual loads the real Prisma
// singleton — that's fine for unit tests because we never call the
// real `db.auditLog.create` (we mock `listAuditLog` and `recordAudit`).
vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		listAuditLog: mocks.listAuditLog,
		recordAudit: mocks.recordAudit,
	};
});

vi.mock("@repo/auth/lib/client-ip", () => ({
	getTrustedClientIp: mocks.getTrustedClientIp,
}));

vi.mock("@repo/observability", () => ({
	auditWriteFailures: { inc: vi.fn() },
	auditWritesTotal: { inc: vi.fn() },
}));

// `protectedProcedure` imports lazily from `@repo/payments` only on the
// catch path of the AI-usage-limit error mapper, but the procedures
// module re-exports its types eagerly. Stub the whole package so module
// load doesn't blow up.
vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { listAuditLogProcedure } from "../procedures/list";

function makeContext() {
	return {
		user: {
			id: "user-1",
			email: "alice@example.com",
			name: "Alice",
		},
		session: { id: "session-1" },
		headers: new Headers(),
	};
}

function makeRow(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "audit-1",
		organizationId: "org-1",
		userId: "user-1",
		actorType: "user",
		actorEmailSnapshot: "alice@example.com",
		actorNameSnapshot: "Alice",
		impersonatedById: null,
		action: "auth.login.success",
		category: "auth",
		severity: "info",
		outcome: "success",
		resourceType: null,
		resourceId: null,
		resourceName: null,
		projectId: null,
		ipAddress: null,
		userAgent: null,
		requestId: null,
		sessionId: null,
		metadata: null,
		createdAt: new Date("2026-05-15T12:00:00Z"),
		...over,
	};
}

const handler = (
	listAuditLogProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<unknown>;
		};
	}
)["~orpc"].handler;

beforeEach(() => {
	mocks.listAuditLog.mockReset();
	mocks.recordAudit.mockReset();
});

describe("audit.list handler", () => {
	it("returns the list-query result for an org call and propagates totalCount on the initial page", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow()],
			nextCursor: null,
			totalCount: 42,
		});

		const result = (await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: {},
			},
		})) as { items: unknown[]; totalCount?: number };

		expect(result.items).toHaveLength(1);
		expect(result.totalCount).toBe(42);
		expect(mocks.listAuditLog).toHaveBeenCalledTimes(1);
		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
			limit: number;
		};
		expect(call.scope.organizationId).toBe("org-1");
		expect(call.limit).toBe(50);
	});

	it("scopes personal-context calls to the caller's userId", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [],
			nextCursor: null,
			totalCount: 0,
		});

		await handler({
			context: makeContext(),
			input: {
				organizationId: null,
				limit: 50,
				filter: {},
			},
		});

		const call = mocks.listAuditLog.mock.calls[0]?.[0] as {
			scope: { organizationId: string | null; userId: string | null };
		};
		expect(call.scope.organizationId).toBeNull();
		expect(call.scope.userId).toBe("user-1");
	});

	it("emits one `audit.viewed` event per successful call", async () => {
		mocks.listAuditLog.mockResolvedValue({
			items: [makeRow(), makeRow({ id: "audit-2" })],
			nextCursor: null,
			totalCount: 2,
		});

		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				limit: 50,
				filter: { categories: ["auth"] },
			},
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0]?.[0] as {
			action: string;
			category: string;
			metadata: { resultCount: number };
		};
		expect(audit.action).toBe("audit.viewed");
		expect(audit.category).toBe("audit");
		expect(audit.metadata.resultCount).toBe(2);
	});

	it("rejects BAD_REQUEST when dateFrom > dateTo", async () => {
		await expect(
			handler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					limit: 50,
					filter: {
						dateFrom: new Date("2026-06-01"),
						dateTo: new Date("2026-05-01"),
					},
				},
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});

	it("rejects BAD_REQUEST when the query reports an invalid cursor", async () => {
		mocks.listAuditLog.mockImplementation(() => {
			throw new Error("Invalid cursor");
		});

		await expect(
			handler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					limit: 50,
					cursor: "garbage",
					filter: {},
				},
			}),
		).rejects.toThrow(/Invalid cursor/);
	});
});
