/**
 * Verifies the `list` procedure hydrates each notification's actor user.
 *
 *  - Rows whose `actorUserId` resolves to a User return
 *    `actor: { id, name, image }`.
 *  - Rows without an `actorUserId` (system / agent-originated) return
 *    `actor: null` so the UI can fall back to the category-icon bubble.
 *
 * The frontend NotificationListItem depends on this shape to swap the muted
 * category-icon bubble for the actor avatar with a category badge overlay.
 */

import { describe, expect, it, vi } from "vitest";

const { findMany, userFindMany } = vi.hoisted(() => ({
	findMany: vi.fn(),
	userFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		notification: { findMany },
		user: { findMany: userFindMany },
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

import { listNotificationsProcedure } from "../../procedures/list";

describe("listNotificationsProcedure — actor hydration", () => {
	it("hydrates actor from the User table when actorUserId is present", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n1",
				actorUserId: "u9",
				title: "x",
				category: "MENTION",
				createdAt: new Date(),
				readAt: null,
				link: null,
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([
			{ id: "u9", name: "Ada", image: "img" },
		]);

		const out = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		// Joined the User table on the deduped actor id set.
		expect(userFindMany).toHaveBeenCalledTimes(1);
		const userArgs = userFindMany.mock.calls[0][0];
		expect(userArgs.where).toEqual({ id: { in: ["u9"] } });
		expect(userArgs.select).toEqual({ id: true, name: true, image: true });

		expect(out.items[0].actor).toEqual({
			id: "u9",
			name: "Ada",
			image: "img",
		});
		// The cursor pagination response shape must be preserved.
		expect(out).toHaveProperty("items");
		expect(out).toHaveProperty("nextCursor");
	});

	it("returns actor: null when the row has no actorUserId", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n2",
				actorUserId: null,
				title: "y",
				category: "SYSTEM",
				createdAt: new Date(),
				readAt: null,
				link: null,
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([]);

		const out = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		// No actor ids to look up — skip the User query entirely.
		expect(userFindMany).not.toHaveBeenCalled();
		expect(out.items[0].actor).toBeNull();
	});

	it("deduplicates actor ids before the User query", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n3",
				actorUserId: "u9",
				title: "a",
				category: "MENTION",
				createdAt: new Date(),
				readAt: null,
				link: null,
				snippet: null,
				archivedAt: null,
			},
			{
				id: "n4",
				actorUserId: "u9",
				title: "b",
				category: "REPLY",
				createdAt: new Date(),
				readAt: null,
				link: null,
				snippet: null,
				archivedAt: null,
			},
			{
				id: "n5",
				actorUserId: null,
				title: "c",
				category: "SYSTEM",
				createdAt: new Date(),
				readAt: null,
				link: null,
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([
			{ id: "u9", name: "Ada", image: null },
		]);

		const out = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(userFindMany).toHaveBeenCalledTimes(1);
		expect(userFindMany.mock.calls[0][0].where).toEqual({
			id: { in: ["u9"] },
		});
		expect(out.items[0].actor?.id).toBe("u9");
		expect(out.items[1].actor?.id).toBe("u9");
		expect(out.items[2].actor).toBeNull();
	});
});
