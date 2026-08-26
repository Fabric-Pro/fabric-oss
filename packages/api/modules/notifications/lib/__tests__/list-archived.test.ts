/**
 * Verifies the `list` procedure scopes results by the `status` filter:
 *  - `status: "archived"` returns archived rows only (archivedAt: { not: null })
 *  - `status: "all"` / `status: "unread"` excludes archived rows (archivedAt: null)
 *
 * The archive tab on the web client depends on `status: "archived"` filtering
 * archived rows in, while the regular Inbox depends on archived rows being
 * filtered out.
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

describe("listNotificationsProcedure", () => {
	it("filters to archived-only when status='archived'", async () => {
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "archived", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.archivedAt).toEqual({ not: null });
		expect(where.readAt).toBeUndefined();
	});

	it("filters to non-archived by default (status='all')", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.archivedAt).toBeNull();
	});

	it("filters to unread non-archived when status='unread'", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "unread", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.archivedAt).toBeNull();
		expect(where.readAt).toBeNull();
	});
});
