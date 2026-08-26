/**
 * Verifies the `list` procedure's optional `types` filter — the discriminator
 * behind the Inbound/Conflicts tabs (AC-10):
 *  - `types: [...]` → `where.type = { in: [...] }`
 *  - omitted/empty → no `type` filter (so the broad tabs are unaffected)
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { notification: { findMany: vi.fn() } },
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

const ctx = { user: { id: "u1" }, session: {} };

describe("listNotificationsProcedure types filter (AC-10 tabs)", () => {
	it("filters by type when types are provided (conflict tab)", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 50, types: ["PM_SYNC_CONFLICT"] },
			context: ctx,
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.type).toEqual({ in: ["PM_SYNC_CONFLICT"] });
	});

	it("omits the type filter when no types are provided", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 50 },
			context: ctx,
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.type).toBeUndefined();
	});

	it("omits the type filter when types is an empty array", async () => {
		(db.notification.findMany as any).mockReset();
		(db.notification.findMany as any).mockResolvedValue([]);
		await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 50, types: [] },
			context: ctx,
		});
		const where = (db.notification.findMany as any).mock.calls[0][0].where;
		expect(where.type).toBeUndefined();
	});
});
