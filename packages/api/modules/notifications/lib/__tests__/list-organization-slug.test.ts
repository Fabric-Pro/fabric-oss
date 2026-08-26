/**
 * Verifies the `list` procedure hydrates each notification's owning-org slug so
 * the client can build the click target from the notification's OWN org rather
 * than the workspace the user is currently in.
 *
 *  - Rows with an `organizationId` return `organizationSlug` from the Organization
 *    table (batch-looked-up, deduped).
 *  - Personal rows (`organizationId: null`) return `organizationSlug: null` and
 *    never touch the Organization table.
 */

import { describe, expect, it, vi } from "vitest";

const { findMany, userFindMany, orgFindMany } = vi.hoisted(() => ({
	findMany: vi.fn(),
	userFindMany: vi.fn(),
	orgFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		notification: { findMany },
		user: { findMany: userFindMany },
		organization: { findMany: orgFindMany },
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

describe("listNotificationsProcedure — organization slug hydration", () => {
	it("hydrates organizationSlug from the Organization table", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		orgFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n1",
				organizationId: "org-a",
				actorUserId: null,
				title: "x",
				category: "MENTION",
				createdAt: new Date(),
				readAt: null,
				link: "projects/p1/stories/s1",
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([]);
		orgFindMany.mockResolvedValue([{ id: "org-a", slug: "team-alpha" }]);

		const out = await (listNotificationsProcedure as any)({
			input: { organizationId: "org-a", status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(orgFindMany).toHaveBeenCalledTimes(1);
		const args = orgFindMany.mock.calls[0][0];
		expect(args.where).toEqual({ id: { in: ["org-a"] } });
		// `name` joined this select for the stacked-card chip (#2117); the slug
		// this suite is about still comes from the same single lookup.
		expect(args.select).toEqual({ id: true, slug: true, name: true });
		expect(out.items[0].organizationSlug).toBe("team-alpha");
	});

	it("returns organizationSlug: null for personal notifications", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		orgFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n2",
				organizationId: null,
				actorUserId: null,
				title: "y",
				category: "SYSTEM",
				createdAt: new Date(),
				readAt: null,
				link: "projects/p2",
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([]);

		const out = await (listNotificationsProcedure as any)({
			input: { status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		// No org ids → skip the Organization query entirely.
		expect(orgFindMany).not.toHaveBeenCalled();
		expect(out.items[0].organizationSlug).toBeNull();
	});

	it("deduplicates organizationIds before the Organization query", async () => {
		findMany.mockReset();
		userFindMany.mockReset();
		orgFindMany.mockReset();
		findMany.mockResolvedValue([
			{
				id: "n1",
				organizationId: "org-a",
				actorUserId: null,
				title: "a",
				category: "MENTION",
				createdAt: new Date(),
				readAt: null,
				link: "projects/p1",
				snippet: null,
				archivedAt: null,
			},
			{
				id: "n2",
				organizationId: "org-a",
				actorUserId: null,
				title: "b",
				category: "REPLY",
				createdAt: new Date(),
				readAt: null,
				link: "projects/p2",
				snippet: null,
				archivedAt: null,
			},
		]);
		userFindMany.mockResolvedValue([]);
		orgFindMany.mockResolvedValue([{ id: "org-a", slug: "team-alpha" }]);

		const out = await (listNotificationsProcedure as any)({
			input: { organizationId: "org-a", status: "all", limit: 20 },
			context: { user: { id: "u1" }, session: {} },
		});

		expect(orgFindMany).toHaveBeenCalledTimes(1);
		expect(orgFindMany.mock.calls[0][0].where).toEqual({
			id: { in: ["org-a"] },
		});
		expect(out.items[0].organizationSlug).toBe("team-alpha");
		expect(out.items[1].organizationSlug).toBe("team-alpha");
	});
});
