/**
 * Unit tests for the weekly project service-alert digest (AC-9).
 *
 * Mocks at the Prisma client boundary. Verifies the aggregation, the
 * project-admin-only fan-out (OWNER/PROJECT_ADMIN + personal owner), and the
 * no-alerts no-op.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	pmSyncLogFindMany,
	projectFindMany,
	projectMemberFindMany,
	memberFindMany,
	create,
} = vi.hoisted(() => ({
	pmSyncLogFindMany: vi.fn(),
	projectFindMany: vi.fn(),
	projectMemberFindMany: vi.fn(),
	memberFindMany: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		pmSyncLog: { findMany: pmSyncLogFindMany },
		project: { findMany: projectFindMany },
		projectMember: { findMany: projectMemberFindMany },
		member: { findMany: memberFindMany },
		notification: { create },
	},
}));

import { dispatchProjectServiceAlertDigest } from "../prisma/queries/project-service-alert-digest";

const WEEK_END = new Date("2026-06-15T09:00:00.000Z");

describe("dispatchProjectServiceAlertDigest", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		pmSyncLogFindMany.mockResolvedValue([]);
		projectFindMany.mockResolvedValue([]);
		projectMemberFindMany.mockResolvedValue([]);
		memberFindMany.mockResolvedValue([]);
		create.mockResolvedValue({});
	});

	it("no-ops when no project had alerts in the window", async () => {
		const result = await dispatchProjectServiceAlertDigest(WEEK_END);
		expect(result).toEqual({
			projectsNotified: 0,
			adminsNotified: 0,
			skipped: true,
			skipReason: "no-alerts-this-week",
		});
		expect(create).not.toHaveBeenCalled();
	});

	it("fans out one digest per project admin (members + personal owner), none for non-admins", async () => {
		pmSyncLogFindMany.mockResolvedValue([
			{ projectId: "p1", status: "FAILURE" },
			{ projectId: "p1", status: "CONFLICT" },
			{ projectId: "p2", status: "FAILURE" },
		]);
		projectFindMany.mockResolvedValue([
			{
				// Org project whose creator (creator1) has LEFT the org — no
				// member row returned below, so they must NOT be notified.
				id: "p1",
				name: "Proj One",
				organizationId: "org1",
				userId: "creator1",
			},
			{
				id: "p2",
				name: "Proj Two",
				organizationId: null,
				userId: "owner2",
			},
		]);
		// Only OWNER/PROJECT_ADMIN rows are returned (the query filters them).
		projectMemberFindMany.mockResolvedValue([
			{ projectId: "p1", userId: "admin1" },
			{ projectId: "p1", userId: "owner1" },
		]);
		// creator1 is NOT a current member of org1 → excluded.
		memberFindMany.mockResolvedValue([]);

		const result = await dispatchProjectServiceAlertDigest(WEEK_END);

		// p1 → admin1 + owner1 (2); p2 → personal owner2 (1). The departed org
		// creator (creator1) gets nothing.
		expect(result).toEqual({
			projectsNotified: 2,
			adminsNotified: 3,
			skipped: false,
		});
		expect(create).toHaveBeenCalledTimes(3);

		const recipients = create.mock.calls
			.map((c) => c[0].data.userId)
			.sort();
		expect(recipients).toEqual(["admin1", "owner1", "owner2"]);
		expect(recipients).not.toContain("creator1");

		// Admin lookup must be OWNER/PROJECT_ADMIN, accepted, and NOT expired.
		const memberWhere = projectMemberFindMany.mock.calls[0][0].where;
		expect(memberWhere.role).toEqual({ in: ["OWNER", "PROJECT_ADMIN"] });
		expect(memberWhere.acceptedAt).toEqual({ not: null });
		expect(memberWhere.OR).toEqual([
			{ expiresAt: null },
			{ expiresAt: { gt: expect.any(Date) } },
		]);

		// p1's row: 1 failure + 1 conflict = 2 alerts, SYSTEM category, dedupe key.
		const p1Row = create.mock.calls.find(
			(c) => c[0].data.userId === "admin1",
		)?.[0].data;
		expect(p1Row.type).toBe("PROJECT_SERVICE_ALERT_DIGEST");
		expect(p1Row.category).toBe("SYSTEM");
		expect(p1Row.organizationId).toBe("org1");
		expect(p1Row.dedupeKey).toBe(
			"project-service-digest:p1:2026-06-15:admin1",
		);

		// Payload must match the registered PROJECT_SERVICE_ALERT_DIGEST schema
		// in @repo/api notifications/lib/payloads.ts (the helper writes the row
		// directly and cannot run the API validator, so lock the shape here).
		expect(p1Row.payload).toEqual({
			projectId: "p1",
			projectName: "Proj One",
			weekKey: "2026-06-15",
			weekStart: "2026-06-08T09:00:00.000Z",
			weekEnd: "2026-06-15T09:00:00.000Z",
			totalAlerts: 2,
			syncFailureCount: 1,
			conflictCount: 1,
			link: "projects/p1",
		});
	});

	it("includes an org-project creator who is still a current org member", async () => {
		pmSyncLogFindMany.mockResolvedValue([
			{ projectId: "p1", status: "FAILURE" },
		]);
		projectFindMany.mockResolvedValue([
			{
				id: "p1",
				name: "Proj One",
				organizationId: "org1",
				userId: "creator1",
			},
		]);
		// No explicit project-admin rows — the creator is the only candidate.
		projectMemberFindMany.mockResolvedValue([]);
		// creator1 still belongs to org1 → must be notified.
		memberFindMany.mockResolvedValue([
			{ userId: "creator1", organizationId: "org1" },
		]);

		const result = await dispatchProjectServiceAlertDigest(WEEK_END);

		expect(result.adminsNotified).toBe(1);
		expect(create.mock.calls.map((c) => c[0].data.userId)).toEqual([
			"creator1",
		]);
	});

	it("swallows P2002 dedupe collisions without throwing", async () => {
		pmSyncLogFindMany.mockResolvedValue([
			{ projectId: "p1", status: "FAILURE" },
		]);
		projectFindMany.mockResolvedValue([
			{
				id: "p1",
				name: "Proj One",
				organizationId: null,
				userId: "owner1",
			},
		]);
		projectMemberFindMany.mockResolvedValue([]);
		create.mockRejectedValue({ code: "P2002" });

		const result = await dispatchProjectServiceAlertDigest(WEEK_END);
		// Write was attempted but coalesced — not counted as notified.
		expect(result.skipped).toBe(false);
		expect(result.adminsNotified).toBe(0);
		expect(create).toHaveBeenCalledTimes(1);
	});
});
