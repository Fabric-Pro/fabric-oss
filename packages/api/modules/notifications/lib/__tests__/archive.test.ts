/**
 * Archive and restore procedures.
 *
 * The handlers must:
 *  - Filter `updateMany` by the caller's `userId` AND `organizationId` so a
 *    user cannot archive someone else's notification by guessing an id.
 *  - For archive: target only currently-unarchived rows (`archivedAt: null`).
 *  - For restore: target only currently-archived rows (`archivedAt: { not: null }`).
 *  - Invalidate the Redis unread-count cache for the affected scope, so the
 *    bell badge reacts immediately when archiving an unread notification.
 *  - Reject empty id arrays at the schema layer.
 */

import { describe, expect, it, vi } from "vitest";

const { updateMany, invalidateUnreadCount } = vi.hoisted(() => ({
	updateMany: vi.fn(),
	invalidateUnreadCount: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: { notification: { updateMany } },
}));

vi.mock("../../../../lib/notification-cache", () => ({
	invalidateUnreadCount,
}));

vi.mock("../../../../orpc/procedures", () => {
	// Each `.input(schema).handler(h)` chain returns the handler function
	// directly, but we tag it with `__schema` so tests can introspect the
	// zod schema (e.g., to assert validation rejects empty id arrays).
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: (schema: any) => ({
				...chain,
				handler: (h: any) => {
					(h as any).__schema = schema;
					return h;
				},
			}),
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => () => undefined,
		resolveOrganizationId: (id: string | null | undefined) => id ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { archiveNotificationsProcedure } from "../../procedures/archive";
import { restoreNotificationsProcedure } from "../../procedures/restore";

describe("archive/restore procedures", () => {
	it("archives only the caller's notifications by id", async () => {
		updateMany.mockReset();
		invalidateUnreadCount.mockReset();
		updateMany.mockResolvedValue({ count: 2 });

		const result = await (archiveNotificationsProcedure as any)({
			input: { ids: ["n1", "n2"], organizationId: null },
			context: { user: { id: "u1" }, session: {} },
		});

		const where = updateMany.mock.calls[0][0].where;
		expect(where.userId).toBe("u1");
		expect(where.id).toEqual({ in: ["n1", "n2"] });
		expect(where.archivedAt).toBeNull();
		expect(updateMany.mock.calls[0][0].data.archivedAt).toBeInstanceOf(
			Date,
		);
		expect(result).toEqual({ archived: 2 });
		expect(invalidateUnreadCount).toHaveBeenCalledWith("u1", null);
	});

	it("archive scopes to the caller's organization", async () => {
		updateMany.mockReset();
		invalidateUnreadCount.mockReset();
		updateMany.mockResolvedValue({ count: 1 });

		await (archiveNotificationsProcedure as any)({
			input: { ids: ["n1"], organizationId: "org-a" },
			context: { user: { id: "u1" }, session: {} },
		});

		const where = updateMany.mock.calls[0][0].where;
		expect(where.userId).toBe("u1");
		expect(where.organizationId).toBe("org-a");
		expect(invalidateUnreadCount).toHaveBeenCalledWith("u1", "org-a");
	});

	it("restore clears archivedAt only on archived rows owned by the caller", async () => {
		updateMany.mockReset();
		invalidateUnreadCount.mockReset();
		updateMany.mockResolvedValue({ count: 1 });

		const result = await (restoreNotificationsProcedure as any)({
			input: { ids: ["n3"], organizationId: null },
			context: { user: { id: "u1" }, session: {} },
		});

		const args = updateMany.mock.calls.at(-1)[0];
		expect(args.where.userId).toBe("u1");
		expect(args.where.id).toEqual({ in: ["n3"] });
		expect(args.where.archivedAt).toEqual({ not: null });
		expect(args.data.archivedAt).toBeNull();
		expect(result).toEqual({ restored: 1 });
		expect(invalidateUnreadCount).toHaveBeenCalledWith("u1", null);
	});

	it("rejects empty id arrays at the schema layer", async () => {
		// Pull the zod schema captured by the mocked .input() passthrough.
		const schema = (archiveNotificationsProcedure as any).__schema;
		expect(schema).toBeDefined();
		const result = schema.safeParse({ ids: [], organizationId: null });
		expect(result.success).toBe(false);
	});

	it("rejects id arrays larger than 200", async () => {
		const schema = (archiveNotificationsProcedure as any).__schema;
		const ids = Array.from({ length: 201 }, (_, i) => `n${i}`);
		const result = schema.safeParse({ ids, organizationId: null });
		expect(result.success).toBe(false);
	});
});
