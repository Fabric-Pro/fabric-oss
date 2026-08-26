/**
 * Unit tests for the action-aware `upsertPendingChange` dedup
 * (`@repo/database`).
 *
 * Mocks the Prisma client (`../prisma/client`) — no real DB. Mirrors the
 * `pm-sync-resolve.test.ts` convention.
 *
 * Covers:
 * - HIDE + CONTENT_DRIFT rows for the same entity coexist (no stomp — both
 *   lookups are scoped by `proposedAction`).
 * - CONTENT_DRIFT DISMISSED short-circuit matches on the exact `detectedPmHash`
 *   (dismissed-at-hash-X stays dismissed at X; a newer hash Y re-surfaces).
 * - An open CONTENT_DRIFT row advances its `detectedPmHash` → "updated".
 * - The legacy HIDE/UNHIDE/FLAG_MISSING dismissed-match-on-`newState` behavior
 *   is preserved (now additionally scoped by action).
 *
 * Run with: pnpm --filter @repo/database test __tests__/pending-pm-state-changes.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findFirst, update, create } = vi.hoisted(() => ({
	findFirst: vi.fn(),
	update: vi.fn(),
	create: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		pendingPmStateChange: { findFirst, update, create },
	},
}));

import { upsertPendingChange } from "../prisma/queries/pending-pm-state-changes";

const BASE = {
	projectId: "proj_1",
	entityType: "STORY" as const,
	entityId: "story_1",
	externalId: "ADO-1",
};

beforeEach(() => {
	findFirst.mockReset();
	update.mockReset();
	create.mockReset();
});

describe("upsertPendingChange — action-aware dedup", () => {
	it("scopes the DISMISSED + PENDING lookups by proposedAction (no stomp between lanes)", async () => {
		// No dismissed, no pending → insert.
		findFirst.mockResolvedValue(null);
		create.mockResolvedValue({ id: "new_1" });

		await upsertPendingChange({
			...BASE,
			previousState: "Active",
			newState: "Closed",
			proposedAction: "HIDE",
		});

		// Both findFirst calls (DISMISSED then PENDING) must carry proposedAction.
		const dismissedWhere = findFirst.mock.calls[0]?.[0]?.where;
		const pendingWhere = findFirst.mock.calls[1]?.[0]?.where;
		expect(dismissedWhere).toMatchObject({
			proposedAction: "HIDE",
			status: "DISMISSED",
			newState: "Closed",
		});
		expect(pendingWhere).toMatchObject({
			proposedAction: "HIDE",
			status: "PENDING",
		});
		// A HIDE lookup never filters on detectedPmHash.
		expect(dismissedWhere).not.toHaveProperty("detectedPmHash");
	});

	it("inserts a CONTENT_DRIFT row with detectedPmHash + sentinel CONTENT state", async () => {
		findFirst.mockResolvedValue(null);
		create.mockResolvedValue({ id: "drift_1" });

		const result = await upsertPendingChange({
			...BASE,
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: "hashX",
		});

		expect(result).toEqual({ action: "created", pendingId: "drift_1" });
		// DISMISSED lookup for content drift keys on detectedPmHash, not newState.
		const dismissedWhere = findFirst.mock.calls[0]?.[0]?.where;
		expect(dismissedWhere).toMatchObject({
			proposedAction: "CONTENT_DRIFT",
			status: "DISMISSED",
			detectedPmHash: "hashX",
		});
		expect(dismissedWhere).not.toHaveProperty("newState");
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				proposedAction: "CONTENT_DRIFT",
				detectedPmHash: "hashX",
				previousState: "CONTENT",
				newState: "CONTENT",
				status: "PENDING",
			}),
			select: { id: true },
		});
	});

	it("HIDE and CONTENT_DRIFT for the same entity coexist (independent lanes)", async () => {
		// Simulate: a HIDE PENDING row exists, but CONTENT_DRIFT lookups must not
		// find it — the mock returns a HIDE row only when the query targets HIDE.
		findFirst.mockImplementation(async ({ where }) => {
			if (where.status === "DISMISSED") {
				return null;
			}
			if (where.proposedAction === "HIDE") {
				return { id: "hide_pending" };
			}
			return null; // no CONTENT_DRIFT pending row
		});
		create.mockResolvedValue({ id: "drift_new" });

		const result = await upsertPendingChange({
			...BASE,
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: "hashX",
		});

		// CONTENT_DRIFT inserts a fresh row — it did NOT update the HIDE row.
		expect(result).toEqual({ action: "created", pendingId: "drift_new" });
		expect(update).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("dismissed at hash X → stays dismissed when re-observed at hash X (skip)", async () => {
		findFirst.mockImplementation(async ({ where }) => {
			if (
				where.status === "DISMISSED" &&
				where.detectedPmHash === "hashX"
			) {
				return { id: "dismissed_x" };
			}
			return null;
		});

		const result = await upsertPendingChange({
			...BASE,
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: "hashX",
		});

		expect(result).toEqual({ action: "skipped", pendingId: null });
		expect(create).not.toHaveBeenCalled();
		expect(update).not.toHaveBeenCalled();
	});

	it("dismissed at hash X → re-surfaces when a NEWER hash Y is observed (created)", async () => {
		findFirst.mockImplementation(async ({ where }) => {
			// Dismissed row only matches its own hash X — not Y.
			if (
				where.status === "DISMISSED" &&
				where.detectedPmHash === "hashX"
			) {
				return { id: "dismissed_x" };
			}
			return null; // hashY: no dismissed match, no pending row
		});
		create.mockResolvedValue({ id: "drift_y" });

		const result = await upsertPendingChange({
			...BASE,
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: "hashY",
		});

		expect(result).toEqual({ action: "created", pendingId: "drift_y" });
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({ detectedPmHash: "hashY" }),
			select: { id: true },
		});
	});

	it("open CONTENT_DRIFT row advances its detectedPmHash on a newer edit (updated)", async () => {
		findFirst.mockImplementation(async ({ where }) => {
			if (where.status === "DISMISSED") {
				return null;
			}
			if (
				where.status === "PENDING" &&
				where.proposedAction === "CONTENT_DRIFT"
			) {
				return { id: "drift_open" };
			}
			return null;
		});
		update.mockResolvedValue({});

		const result = await upsertPendingChange({
			...BASE,
			previousState: "CONTENT",
			newState: "CONTENT",
			proposedAction: "CONTENT_DRIFT",
			detectedPmHash: "hashZ",
		});

		expect(result).toEqual({ action: "updated", pendingId: "drift_open" });
		// Update payload advances the hash, not previous/new state.
		expect(update).toHaveBeenCalledWith({
			where: { id: "drift_open" },
			data: expect.objectContaining({ detectedPmHash: "hashZ" }),
		});
		const updateData = update.mock.calls[0]?.[0]?.data ?? {};
		expect(updateData).not.toHaveProperty("newState");
		expect(create).not.toHaveBeenCalled();
	});

	it("preserves the legacy HIDE updated path (refreshes prev/new state)", async () => {
		findFirst.mockImplementation(async ({ where }) => {
			if (where.status === "DISMISSED") {
				return null;
			}
			if (where.status === "PENDING" && where.proposedAction === "HIDE") {
				return { id: "hide_open" };
			}
			return null;
		});
		update.mockResolvedValue({});

		const result = await upsertPendingChange({
			...BASE,
			previousState: "Active",
			newState: "Closed",
			proposedAction: "HIDE",
		});

		expect(result).toEqual({ action: "updated", pendingId: "hide_open" });
		expect(update).toHaveBeenCalledWith({
			where: { id: "hide_open" },
			data: expect.objectContaining({
				previousState: "Active",
				newState: "Closed",
				proposedAction: "HIDE",
			}),
		});
	});
});

describe("upsertPendingChange — FLAG_MISSING", () => {
	it("dismissed-dedup keys on externalId (dismiss A does not suppress B)", async () => {
		// DISMISSED row exists for ticket A; incoming flag is for ticket B.
		findFirst
			.mockResolvedValueOnce(null) // DISMISSED lookup for B → none
			.mockResolvedValueOnce(null) // PENDING same-action lookup → none
			.mockResolvedValueOnce(null); // any-action PENDING (arbitration) → none
		create.mockResolvedValue({ id: "pc1" });
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "B",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
		});
		expect(r.action).toBe("created");
		// the DISMISSED lookup matched on externalId, not newState:
		const dismissedWhere = findFirst.mock.calls[0][0].where;
		expect(dismissedWhere.externalId).toBe("B");
		expect(dismissedWhere.newState).toBeUndefined();
	});

	it("re-flag of the same dismissed ticket is suppressed", async () => {
		findFirst.mockResolvedValueOnce({ id: "old" }); // DISMISSED for A
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "A",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
		});
		expect(r.action).toBe("skipped");
	});

	it("dismissed-dedup is server-scoped: a server-A dismissal does NOT suppress a server-B flag with the same externalId (#1360)", async () => {
		// The table holds only a server-A DISMISSED row for externalId "123".
		// The incoming flag is for server B / externalId "123" — a genuinely
		// different ticket that must NOT be suppressed.
		findFirst.mockImplementation(async ({ where }: { where: any }) => {
			if (where.status === "DISMISSED") {
				return where.expectedExternalMcpServerId === "srv-A"
					? { id: "old-A" }
					: null;
			}
			return null; // PENDING same-action + arbitration lookups → none
		});
		create.mockResolvedValue({ id: "pcB" });
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "123",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
			expectedExternalMcpServerId: "srv-B",
		});
		expect(r.action).toBe("created"); // not suppressed by the server-A dismissed row
		const dismissedWhere = findFirst.mock.calls[0][0].where;
		expect(dismissedWhere.expectedExternalMcpServerId).toBe("srv-B");
		expect(dismissedWhere.externalId).toBe("123");
	});

	it("skips when a different-action PENDING row occupies the active slot", async () => {
		findFirst
			.mockResolvedValueOnce(null) // DISMISSED → none
			.mockResolvedValueOnce(null) // same-action PENDING → none
			.mockResolvedValueOnce({ id: "hide1", proposedAction: "HIDE" }); // any-action PENDING
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "B",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
		});
		expect(r.action).toBe("skipped");
		expect(create).not.toHaveBeenCalled();
	});

	it("refreshes externalId on an existing PENDING FLAG_MISSING row", async () => {
		findFirst
			.mockResolvedValueOnce(null) // DISMISSED → none
			.mockResolvedValueOnce({ id: "pc1" }); // same-action PENDING exists
		update.mockResolvedValue({ id: "pc1" });
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "C",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
		});
		expect(r.action).toBe("updated");
		expect(update.mock.calls[0][0].data.externalId).toBe("C");
	});

	it("returns skipped on a P2002 for FLAG_MISSING (not thrown)", async () => {
		findFirst.mockResolvedValue(null);
		create.mockRejectedValue({ code: "P2002" });
		const r = await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "B",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
		});
		expect(r.action).toBe("skipped");
	});

	it("rethrows a P2002 for non-FLAG_MISSING actions", async () => {
		findFirst.mockResolvedValue(null);
		create.mockRejectedValue({ code: "P2002" });
		await expect(
			upsertPendingChange({
				projectId: "p1",
				entityType: "STORY",
				entityId: "s1",
				externalId: "B",
				previousState: "DRAFT",
				newState: "open",
				proposedAction: "HIDE",
			}),
		).rejects.toMatchObject({ code: "P2002" });
	});

	// Fix B: server provenance persisted on the FLAG_MISSING row.
	it("persists expectedExternalMcpServerId on create for FLAG_MISSING", async () => {
		findFirst.mockResolvedValue(null);
		create.mockResolvedValue({ id: "pc1" });
		await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "B",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
			expectedExternalMcpServerId: "srv-1",
		});
		expect(create.mock.calls[0][0].data.expectedExternalMcpServerId).toBe(
			"srv-1",
		);
	});

	it("refreshes expectedExternalMcpServerId on the PENDING update path", async () => {
		findFirst
			.mockResolvedValueOnce(null) // DISMISSED → none
			.mockResolvedValueOnce({ id: "pc1" }); // same-action PENDING exists
		update.mockResolvedValue({ id: "pc1" });
		await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "C",
			previousState: "DRAFT",
			newState: "MISSING",
			proposedAction: "FLAG_MISSING",
			expectedExternalMcpServerId: "srv-2",
		});
		expect(update.mock.calls[0][0].data.expectedExternalMcpServerId).toBe(
			"srv-2",
		);
	});

	it("stores null expectedExternalMcpServerId for non-FLAG_MISSING actions (HIDE)", async () => {
		findFirst.mockResolvedValue(null);
		create.mockResolvedValue({ id: "pc1" });
		await upsertPendingChange({
			projectId: "p1",
			entityType: "STORY",
			entityId: "s1",
			externalId: "B",
			previousState: "DRAFT",
			newState: "Closed",
			proposedAction: "HIDE",
		});
		expect(
			create.mock.calls[0][0].data.expectedExternalMcpServerId,
		).toBeNull();
	});
});
