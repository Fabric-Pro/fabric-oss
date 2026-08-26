/**
 * Tests for the `audit.export` procedure handler.
 *
 * Same pattern as list.test.ts — call `handler` directly, mock the
 * database boundary. Middleware-level FORBIDDEN is covered by the
 * middleware unit test.
 *
 * Spec: docs/audit-log/README.md §13.3.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	countAuditLog: vi.fn(),
	fetchAuditLogForExport: vi.fn(),
	recordAudit: vi.fn(),
	getTrustedClientIp: vi.fn().mockReturnValue("127.0.0.1"),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		countAuditLog: mocks.countAuditLog,
		fetchAuditLogForExport: mocks.fetchAuditLogForExport,
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

vi.mock("@repo/payments", () => ({
	AiUsageLimitExceededError: class {},
}));

import { exportAuditLogProcedure } from "../procedures/export";

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
		metadata: { method: "password" },
		createdAt: new Date("2026-05-15T12:00:00Z"),
		...over,
	};
}

const handler = (
	exportAuditLogProcedure as unknown as {
		"~orpc": {
			handler: (args: {
				context: ReturnType<typeof makeContext>;
				input: Record<string, unknown>;
			}) => Promise<unknown>;
		};
	}
)["~orpc"].handler;

beforeEach(() => {
	mocks.countAuditLog.mockReset();
	mocks.fetchAuditLogForExport.mockReset();
	mocks.recordAudit.mockReset();
});

describe("audit.export handler", () => {
	it("rejects BAD_REQUEST when the result set exceeds the 50k cap", async () => {
		mocks.countAuditLog.mockResolvedValue(50_001);

		await expect(
			handler({
				context: makeContext(),
				input: {
					organizationId: "org-1",
					format: "csv",
					filter: {},
				},
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});

	it("produces a CSV body with header + 1 row and ISO-8601 UTC timestamp", async () => {
		mocks.countAuditLog.mockResolvedValue(1);
		mocks.fetchAuditLogForExport.mockResolvedValue([makeRow()]);

		const result = (await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				format: "csv",
				filter: {},
			},
		})) as { body: string; rowCount: number; contentType: string };

		const lines = result.body.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(
			"timestamp,actor_email,actor_name,actor_type,action,category,severity,outcome,resource_type,resource_id,resource_name,project_id,ip_address,user_agent,request_id,session_id,impersonated_by_id",
		);
		expect(lines[1]).toContain("2026-05-15T12:00:00.000Z");
		expect(result.contentType).toBe("text/csv");
		expect(result.rowCount).toBe(1);
	});

	it("produces NDJSON with one JSON object per line including metadata", async () => {
		mocks.countAuditLog.mockResolvedValue(2);
		mocks.fetchAuditLogForExport.mockResolvedValue([
			makeRow({ id: "a", metadata: { method: "password" } }),
			makeRow({ id: "b", metadata: { ip: "1.2.3.4" } }),
		]);

		const result = (await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				format: "ndjson",
				filter: {},
			},
		})) as { body: string; rowCount: number; contentType: string };

		const lines = result.body.split("\n").filter(Boolean);
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0]!);
		expect(first.id).toBe("a");
		expect(first.metadata).toEqual({ method: "password" });
		expect(result.contentType).toBe("application/x-ndjson");
	});

	it("returns header-only CSV when the filter matches zero rows", async () => {
		mocks.countAuditLog.mockResolvedValue(0);
		mocks.fetchAuditLogForExport.mockResolvedValue([]);

		const result = (await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				format: "csv",
				filter: {},
			},
		})) as { body: string; rowCount: number };

		const lines = result.body.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(result.rowCount).toBe(0);
	});

	it("emits one `audit.exported` event per successful export", async () => {
		mocks.countAuditLog.mockResolvedValue(1);
		mocks.fetchAuditLogForExport.mockResolvedValue([makeRow()]);

		await handler({
			context: makeContext(),
			input: {
				organizationId: "org-1",
				format: "csv",
				filter: {},
			},
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		const audit = mocks.recordAudit.mock.calls[0]?.[0] as {
			action: string;
			metadata: { format: string; rowCount: number };
		};
		expect(audit.action).toBe("audit.exported");
		expect(audit.metadata.format).toBe("csv");
		expect(audit.metadata.rowCount).toBe(1);
	});
});
