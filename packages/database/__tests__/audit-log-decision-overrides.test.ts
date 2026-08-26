/**
 * Unit tests for `listDecisionOverrideAuditRows` — the thin read wrapper that
 * backs the read-only Overrides view. Proves it constrains the query to the
 * `decision.override_accepted` action, scopes it to the project, and honors the
 * XOR tenant filter (org isolation vs. personal-context user anchoring).
 *
 * Run with: pnpm --filter @repo/database test __tests__/audit-log-decision-overrides.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	findManyMock: vi.fn(),
	countMock: vi.fn(),
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), log: vi.fn() },
	logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@repo/utils/correlation-id", () => ({
	getCorrelationIdFromContext: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../prisma/client", () => ({
	db: {
		auditLog: {
			findMany: (args: unknown) => mocks.findManyMock(args),
			count: (args: unknown) => mocks.countMock(args),
		},
	},
	Prisma: {},
}));

import { listDecisionOverrideAuditRows } from "../prisma/queries/audit-log";

beforeEach(() => {
	mocks.findManyMock.mockReset();
	mocks.countMock.mockReset();
	mocks.findManyMock.mockResolvedValue([]);
	mocks.countMock.mockResolvedValue(0);
});

describe("listDecisionOverrideAuditRows", () => {
	it("filters to the decision.override_accepted action for the project", async () => {
		await listDecisionOverrideAuditRows({
			scope: { organizationId: null, userId: "user-1" },
			projectId: "proj-1",
		});

		expect(mocks.findManyMock).toHaveBeenCalledTimes(1);
		const args = mocks.findManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
			orderBy: unknown;
			take: number;
		};
		expect(args.where.projectId).toBe("proj-1");
		expect(args.where.action).toEqual({
			in: ["decision.override_accepted"],
		});
		// Newest-first plan, +1 row for the has-more probe (default limit 100).
		expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
		expect(args.take).toBe(101);
	});

	it("anchors to the caller's user id in personal context (XOR)", async () => {
		await listDecisionOverrideAuditRows({
			scope: { organizationId: null, userId: "user-1" },
			projectId: "proj-1",
		});
		const args = mocks.findManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(args.where.organizationId).toBeNull();
		expect(args.where.userId).toBe("user-1");
	});

	it("isolates to the org (not the user) in org context (XOR)", async () => {
		await listDecisionOverrideAuditRows({
			scope: { organizationId: "org-1", userId: "user-1" },
			projectId: "proj-1",
		});
		const args = mocks.findManyMock.mock.calls[0]?.[0] as {
			where: Record<string, unknown>;
		};
		expect(args.where.organizationId).toBe("org-1");
		expect(args.where.userId).toBeUndefined();
	});

	it("returns the rows newest-first", async () => {
		const rows = [
			{ id: "b", createdAt: new Date("2026-07-10T00:00:00Z") },
			{ id: "a", createdAt: new Date("2026-07-09T00:00:00Z") },
		];
		mocks.findManyMock.mockResolvedValue(rows);
		const result = await listDecisionOverrideAuditRows({
			scope: { organizationId: "org-1", userId: "user-1" },
			projectId: "proj-1",
		});
		expect(result).toEqual(rows);
	});

	it("respects an explicit limit", async () => {
		await listDecisionOverrideAuditRows({
			scope: { organizationId: "org-1", userId: "user-1" },
			projectId: "proj-1",
			limit: 5,
		});
		const args = mocks.findManyMock.mock.calls[0]?.[0] as { take: number };
		expect(args.take).toBe(6);
	});
});
