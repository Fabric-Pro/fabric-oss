/**
 * Unit Tests for PM Sync Log + Review Center procedures
 *
 * Covers:
 *  - list-pm-sync-log (Sync History tab data)
 *  - get-review-center-items (bounded, grouped actionable list)
 *  - get-review-center-count (actionable-only badge count)
 *
 * Asserts: project-access gating (FORBIDDEN when access denied), XOR tenant
 * filter forwarding, filter/pagination forwarding, grouping/order, bounded
 * cap, and that NO PmSyncLog read backs the Review Center (live per-item
 * query only).
 *
 * Run with: pnpm --filter @repo/api test
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockListPmSyncLog,
	mockGetReviewCenterItems,
	mockGetReviewCenterCount,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return {
		handlers,
		mockHasProjectAccess: vi.fn().mockResolvedValue(true),
		mockListPmSyncLog: vi.fn(),
		mockGetReviewCenterItems: vi.fn(),
		mockGetReviewCenterCount: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mockHasProjectAccess,
	listPmSyncLog: mockListPmSyncLog,
	getReviewCenterItems: mockGetReviewCenterItems,
	getReviewCenterCount: mockGetReviewCenterCount,
}));

vi.mock("../../../../orpc/procedures", () => {
	let idx = 0;
	// Import order below: list-pm-sync-log, get-review-center-items,
	// get-review-center-count.
	const names = ["listLog", "items", "count"];
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const name = names[idx] ?? `handler_${idx}`;
			handlers[name] = fn;
			idx++;
			return { _handler: fn };
		},
	};

	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId,
		),
	};
});

// Register handlers (order matters — see `names` above).
import "../list-pm-sync-log";
import "../get-review-center-items";
import "../get-review-center-count";

const orgContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-1" },
};
const personalContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};

describe("listPmSyncLogProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
	});

	it("gates on access (FORBIDDEN when hasProjectAccess is false)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.listLog({
				input: {
					projectId: "proj-1",
					organizationId: null,
					limit: 50,
					offset: 0,
				},
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);

		expect(mockListPmSyncLog).not.toHaveBeenCalled();
	});

	it("forwards filters + pagination and the personal XOR tenant filter", async () => {
		const rows = [{ id: "log-1" }, { id: "log-2" }];
		mockListPmSyncLog.mockResolvedValue({ rows, total: 2 });

		const dateFrom = new Date("2026-01-01");
		const dateTo = new Date("2026-02-01");
		const result = (await handlers.listLog({
			input: {
				projectId: "proj-1",
				organizationId: null,
				pmTool: "azure-devops",
				entityId: "story-1",
				status: "FAILURE",
				dateFrom,
				dateTo,
				limit: 25,
				offset: 50,
			},
			context: personalContext,
		})) as any;

		expect(result.total).toBe(2);
		expect(result.rows).toHaveLength(2);
		expect(mockListPmSyncLog).toHaveBeenCalledWith({
			projectId: "proj-1",
			userId: "user-1",
			pmTool: "azure-devops",
			entityId: "story-1",
			status: "FAILURE",
			dateFrom,
			dateTo,
			limit: 25,
			offset: 50,
		});
		// Personal context: no organizationId leaks into the query.
		const arg = mockListPmSyncLog.mock.calls[0][0];
		expect(arg).not.toHaveProperty("organizationId");
	});

	it("uses the organization XOR tenant filter in org context", async () => {
		mockListPmSyncLog.mockResolvedValue({ rows: [], total: 0 });

		await handlers.listLog({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: orgContext,
		});

		const arg = mockListPmSyncLog.mock.calls[0][0];
		expect(arg.organizationId).toBe("org-1");
		expect(arg).not.toHaveProperty("userId");
	});

	// This endpoint is PROJECT_READ, so every project member can read the
	// response. `errorPayload` holds whatever the sync path threw — PM API
	// bodies, request context — and must never cross the boundary; only the one
	// line the tab renders does.
	it("reduces errorPayload to statusDetail and never returns the raw payload", async () => {
		mockListPmSyncLog.mockResolvedValue({
			total: 3,
			rows: [
				{
					id: "log-1",
					status: "FAILURE",
					errorPayload: {
						errorMessage: "PM rejected the push",
						requestBody: { secret: "do-not-leak" },
					},
				},
				{
					id: "log-2",
					status: "CONFLICT",
					errorPayload: { reason: "push-time-hash-drift" },
				},
				{ id: "log-3", status: "SUCCESS", errorPayload: null },
			],
		});

		const result = (await handlers.listLog({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as any;

		expect(result.rows.map((r: any) => r.statusDetail)).toEqual([
			"PM rejected the push",
			"push-time-hash-drift",
			null,
		]);
		for (const row of result.rows) {
			expect(row).not.toHaveProperty("errorPayload");
		}
		expect(JSON.stringify(result)).not.toContain("do-not-leak");
	});

	it("truncates an oversized failure reason", async () => {
		mockListPmSyncLog.mockResolvedValue({
			total: 1,
			rows: [
				{
					id: "log-1",
					status: "FAILURE",
					errorPayload: { errorMessage: "x".repeat(5000) },
				},
			],
		});

		const result = (await handlers.listLog({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as any;

		expect(result.rows[0].statusDetail).toHaveLength(500);
	});
});

describe("getReviewCenterItemsProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
	});

	it("gates on access (FORBIDDEN when hasProjectAccess is false)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.items({
				input: { projectId: "proj-1", organizationId: "org-1" },
				context: orgContext,
			}),
		).rejects.toThrow(ORPCError);

		expect(mockGetReviewCenterItems).not.toHaveBeenCalled();
	});

	it("returns the grouped result and forwards the XOR tenant scope", async () => {
		const grouped = {
			conflicts: [{ id: "c-1", type: "conflict" }],
			failures: [{ id: "f-1", type: "failure" }],
			pullDrift: [{ id: "p-1", type: "pull-drift" }],
			total: 3,
		};
		mockGetReviewCenterItems.mockResolvedValue(grouped);

		const result = (await handlers.items({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: orgContext,
		})) as any;

		// Fixed group order is preserved end-to-end.
		expect(Object.keys(result)).toEqual([
			"conflicts",
			"failures",
			"pullDrift",
			"total",
		]);
		expect(result.total).toBe(3);
		expect(mockGetReviewCenterItems).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
		// The Review Center never reads the PM sync log.
		expect(mockListPmSyncLog).not.toHaveBeenCalled();
	});

	it("uses the personal XOR tenant filter in personal context", async () => {
		mockGetReviewCenterItems.mockResolvedValue({
			conflicts: [],
			failures: [],
			pullDrift: [],
			total: 0,
		});

		await handlers.items({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		});

		const arg = mockGetReviewCenterItems.mock.calls[0][0];
		expect(arg.userId).toBe("user-1");
		expect(arg).not.toHaveProperty("organizationId");
	});
});

describe("getReviewCenterCountProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
	});

	it("gates on access (FORBIDDEN when hasProjectAccess is false)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		await expect(
			handlers.count({
				input: { projectId: "proj-1", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);

		expect(mockGetReviewCenterCount).not.toHaveBeenCalled();
	});

	it("returns per-category counts plus the total and forwards the tenant scope", async () => {
		mockGetReviewCenterCount.mockResolvedValue({
			conflictsCount: 3,
			failuresCount: 2,
			pullDriftCount: 2,
			total: 7,
		});

		const result = (await handlers.count({
			input: { projectId: "proj-1", organizationId: "org-1" },
			context: orgContext,
		})) as any;

		expect(result).toEqual({
			conflictsCount: 3,
			failuresCount: 2,
			pullDriftCount: 2,
			total: 7,
		});
		expect(mockGetReviewCenterCount).toHaveBeenCalledWith({
			projectId: "proj-1",
			organizationId: "org-1",
		});
		// The badge count never reads PmSyncLog rows.
		expect(mockListPmSyncLog).not.toHaveBeenCalled();
	});

	it("returns zeroed counts cleanly", async () => {
		mockGetReviewCenterCount.mockResolvedValue({
			conflictsCount: 0,
			failuresCount: 0,
			pullDriftCount: 0,
			total: 0,
		});

		const result = (await handlers.count({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as any;

		expect(result.total).toBe(0);
		expect(result).toEqual({
			conflictsCount: 0,
			failuresCount: 0,
			pullDriftCount: 0,
			total: 0,
		});
	});
});
