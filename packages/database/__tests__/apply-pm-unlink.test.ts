import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: { updateMany: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: vi.fn(async (fn: any) => fn(tx)) },
}));

import { applyPmUnlink } from "../prisma/queries/apply-pm-unlink";

beforeEach(() => vi.clearAllMocks());

describe("applyPmUnlink", () => {
	it("severs the link when externalId + projectId + server match (count 1)", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 1 });
		tx.pmTicketMissingStreak.deleteMany.mockResolvedValue({ count: 1 });
		const r = await applyPmUnlink({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			expectedExternalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		expect(r).toEqual({ applied: true });
		const where = tx.userStory.updateMany.mock.calls[0][0].where;
		expect(where).toEqual({
			id: "s1",
			projectId: "p1",
			externalId: "123",
			externalMcpServerId: "srv-1",
		});
		const data = tx.userStory.updateMany.mock.calls[0][0].data;
		expect(data.externalId).toBeNull();
		expect(data.externalMcpServerId).toBeNull();
		expect(data.pmAutoHidden).toBe(false);
		expect(data.pmTicketTerminal).toBe(false);
		expect(data.pmTicketTerminalStatus).toBeNull();
		expect(data.version).toBeUndefined(); // NO version bump
		expect(tx.pmTicketMissingStreak.deleteMany).toHaveBeenCalledWith({
			where: { projectId: "p1", entityType: "STORY", entityId: "s1" },
		});
	});

	it("returns {applied:false} and clears nothing when externalId differs (count 0)", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });
		const r = await applyPmUnlink({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			expectedExternalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		expect(r).toEqual({ applied: false });
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});

	// Fix B: the server guard refuses a retool/import to a different server even
	// when the externalId string is unchanged (same id, new server → count 0).
	it("returns {applied:false} when the story was retooled to a different server", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });
		const r = await applyPmUnlink({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			expectedExternalId: "123",
			expectedExternalMcpServerId: "srv-OLD",
		});
		expect(r).toEqual({ applied: false });
		// The where carries the OLD server, so a row now on srv-NEW won't match.
		expect(tx.userStory.updateMany.mock.calls[0][0].where).toEqual({
			id: "s1",
			projectId: "p1",
			externalId: "123",
			externalMcpServerId: "srv-OLD",
		});
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});

	// Legacy EPIC/FEATURE pending rows are no-ops: the Epic/Feature folder
	// tables were dropped, so the unlink resolves {applied:false} without
	// touching the user_story table or the streak rows.
	it.each(["EPIC", "FEATURE"] as const)(
		"returns {applied:false} for a legacy %s row without any write",
		async (entityType) => {
			const r = await applyPmUnlink({
				projectId: "p1",
				entityType,
				entityId: "legacy-1",
				expectedExternalId: "123",
				expectedExternalMcpServerId: "srv-1",
			});
			expect(r).toEqual({ applied: false });
			expect(tx.userStory.updateMany).not.toHaveBeenCalled();
			expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
		},
	);
});

import { applyPmUnlinkTx } from "../prisma/queries/apply-pm-unlink";

describe("applyPmUnlinkTx", () => {
	it("runs on the provided tx and severs when count 1", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 1 });
		tx.pmTicketMissingStreak.deleteMany.mockResolvedValue({ count: 1 });
		const r = await applyPmUnlinkTx(tx as any, {
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			expectedExternalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		expect(r).toEqual({ applied: true });
		// uses the passed tx directly — db.$transaction NOT opened by the Tx form
		expect(tx.userStory.updateMany).toHaveBeenCalled();
	});

	it("returns {applied:false} on count 0 and skips streak delete", async () => {
		tx.userStory.updateMany.mockResolvedValue({ count: 0 });
		const r = await applyPmUnlinkTx(tx as any, {
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			expectedExternalId: "123",
			expectedExternalMcpServerId: "srv-1",
		});
		expect(r).toEqual({ applied: false });
		expect(tx.pmTicketMissingStreak.deleteMany).not.toHaveBeenCalled();
	});
});
