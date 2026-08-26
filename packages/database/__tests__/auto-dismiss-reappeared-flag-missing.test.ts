import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
	pendingPmStateChange: { findMany: vi.fn(), deleteMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({ db: dbMock }));

import { autoDismissReappearedFlagMissing } from "../prisma/queries/pending-pm-state-changes";

beforeEach(() => vi.clearAllMocks());

describe("autoDismissReappearedFlagMissing", () => {
	it("returns [] without querying when externalIds is empty", async () => {
		const r = await autoDismissReappearedFlagMissing({
			projectId: "p1",
			externalIds: [],
			activeServerId: "srv-1",
		});
		expect(r).toEqual([]);
		expect(dbMock.pendingPmStateChange.findMany).not.toHaveBeenCalled();
	});

	it("finds PENDING FLAG_MISSING rows scoped to the active server and deletes each WHERE status=PENDING", async () => {
		dbMock.pendingPmStateChange.findMany.mockResolvedValue([
			{
				id: "row-1",
				entityType: "STORY",
				entityId: "s1",
				externalId: "123",
			},
			{
				id: "row-2",
				entityType: "EPIC",
				entityId: "e1",
				externalId: "123",
			},
		]);
		dbMock.pendingPmStateChange.deleteMany.mockResolvedValue({ count: 1 });

		const r = await autoDismissReappearedFlagMissing({
			projectId: "p1",
			externalIds: ["123"],
			activeServerId: "srv-1",
		});

		expect(dbMock.pendingPmStateChange.findMany).toHaveBeenCalledWith({
			where: {
				projectId: "p1",
				externalId: { in: ["123"] },
				proposedAction: "FLAG_MISSING",
				status: "PENDING",
				expectedExternalMcpServerId: "srv-1",
			},
			select: {
				id: true,
				entityType: true,
				entityId: true,
				externalId: true,
			},
		});
		// per-row delete is a snapshot CAS (id + status + lane + externalId + server)
		expect(dbMock.pendingPmStateChange.deleteMany).toHaveBeenCalledWith({
			where: {
				id: "row-1",
				status: "PENDING",
				proposedAction: "FLAG_MISSING",
				externalId: "123",
				expectedExternalMcpServerId: "srv-1",
			},
		});
		expect(r).toEqual([
			{ entityType: "STORY", entityId: "s1", externalId: "123" },
			{ entityType: "EPIC", entityId: "e1", externalId: "123" },
		]);
	});

	it("excludes a candidate whose snapshot CAS misses (deleteMany count 0 — concurrently consumed OR refreshed in place)", async () => {
		dbMock.pendingPmStateChange.findMany.mockResolvedValue([
			{
				id: "row-1",
				entityType: "STORY",
				entityId: "s1",
				externalId: "123",
			},
			{
				id: "row-2",
				entityType: "STORY",
				entityId: "s2",
				externalId: "456",
			},
		]);
		dbMock.pendingPmStateChange.deleteMany
			.mockResolvedValueOnce({ count: 1 }) // row-1 deleted
			.mockResolvedValueOnce({ count: 0 }); // row-2 consumed-by-Accept or refreshed to a new ticket → CAS miss

		const r = await autoDismissReappearedFlagMissing({
			projectId: "p1",
			externalIds: ["123", "456"],
			activeServerId: "srv-1",
		});

		// row-2 not deleted → not reported → not audited; the refreshed row survives.
		expect(r).toEqual([
			{ entityType: "STORY", entityId: "s1", externalId: "123" },
		]);
	});

	it("returns [] when nothing matches", async () => {
		dbMock.pendingPmStateChange.findMany.mockResolvedValue([]);
		const r = await autoDismissReappearedFlagMissing({
			projectId: "p1",
			externalIds: ["123"],
			activeServerId: "srv-1",
		});
		expect(r).toEqual([]);
		expect(dbMock.pendingPmStateChange.deleteMany).not.toHaveBeenCalled();
	});
});
