/**
 * AC-5 regression: disabling a notification category must NOT remove or hide
 * EXISTING notifications.
 *
 * Suppression is WRITE-TIME only — the `create`/dispatch path consults user
 * preferences before persisting a row. The READ path (`list` procedure) never
 * looks at preferences, so already-persisted rows survive a later opt-out.
 *
 * These tests prove that invariant from the read side:
 *  (a) rows the DB returns are passed through unchanged regardless of category;
 *  (b) the generated `where` contains NONE of the preference toggle fields, so
 *      the read path is structurally incapable of suppressing existing rows
 *      based on a user's notification preferences.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		notification: { findMany: vi.fn() },
	},
	NotificationCategory: new Proxy({}, { get: (_t, p) => String(p) }),
	NotificationType: new Proxy({}, { get: (_t, p) => String(p) }),
}));

vi.mock("../../lib/access-filter", () => ({
	filterByCurrentAccess: async (rows: unknown[]) => rows,
}));

vi.mock("../../../../orpc/procedures", () => {
	const passthrough = {
		use: () => passthrough,
		route: () => passthrough,
		input: () => passthrough,
		handler: (h: any) => h,
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		resolveOrganizationId: (id: string | null | undefined) => id ?? null,
		tenantProtectedProcedure: passthrough,
	};
});

import { db } from "@repo/database";
import { listNotificationsProcedure } from "../../procedures/list";

describe("listNotificationsProcedure — existing rows survive a category opt-out", () => {
	it("returns existing rows of a category unchanged (prefs never consulted on read)", async () => {
		const existingRows = [
			{
				id: "n1",
				category: "MENTION",
				actorUserId: null,
				organizationId: null,
			},
			{
				id: "n2",
				category: "MENTION",
				actorUserId: null,
				organizationId: null,
			},
		];
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue(existingRows);

		const result = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(result.items).toHaveLength(2);
		expect(result.items.map((n: any) => n.id)).toEqual(["n1", "n2"]);
		// Rows pass through intact — the category is preserved, not stripped.
		expect(result.items.every((n: any) => n.category === "MENTION")).toBe(
			true,
		);
	});

	it("never references any preference toggle field in the generated where", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);

		await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		const whereKeys = JSON.stringify(where);
		// None of the per-user preference toggles may leak into the read query.
		for (const prefField of [
			"mentions",
			"replies",
			"assignments",
			"syncProject",
			"aiAgent",
			"preferences",
			"preference",
			"NotificationPreference",
		]) {
			expect(where).not.toHaveProperty(prefField);
			expect(whereKeys).not.toContain(prefField);
		}
		// `status` here means the input-tab status, which maps only to
		// archivedAt/readAt — never to a stored preference "status" column.
		expect(where).not.toHaveProperty("status");
	});

	it("returns rows even when filtered by the now-disabled category", async () => {
		const existingRows = [
			{
				id: "m1",
				category: "MENTION",
				actorUserId: null,
				organizationId: null,
			},
		];
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue(existingRows);

		const result = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20, category: "MENTION" },
			context: { user: { id: "u1" }, session: {} },
		});

		// Asking for the MENTION category still yields the stored row; the read
		// path keys off the row's stored category, not whether the user has the
		// MENTION preference currently enabled.
		expect(result.items).toHaveLength(1);
		expect(result.items[0].id).toBe("m1");
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.category).toBe("MENTION");
	});
});
