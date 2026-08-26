/**
 * The stacked-card chip (#2117) needs display NAMES, not the slug the link
 * builder uses.
 *
 * The organization name rides the batched Organization lookup the handler
 * already runs. The project name needs its own lookup, and the safety property
 * comes from WHERE its ids are taken: `filterByCurrentAccess` has already
 * dropped every notification whose project the caller can no longer see, so
 * every projectId surviving into `items` is access-checked by construction.
 * Keying the lookup off `items` — never off the raw `rows` — is what makes it
 * impossible to return a name for a project the caller has lost access to.
 */

import { describe, expect, it, vi } from "vitest";

const { findMany, userFindMany, orgFindMany, projectFindMany } = vi.hoisted(
	() => ({
		findMany: vi.fn(),
		userFindMany: vi.fn(),
		orgFindMany: vi.fn(),
		projectFindMany: vi.fn(),
	}),
);

vi.mock("@repo/database", () => ({
	db: {
		notification: { findMany },
		user: { findMany: userFindMany },
		organization: { findMany: orgFindMany },
		project: { findMany: projectFindMany },
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

function row(over: Record<string, unknown> = {}) {
	return {
		id: "n1",
		organizationId: "org-a",
		projectId: null,
		actorUserId: null,
		title: "x",
		category: "MENTION",
		createdAt: new Date(),
		readAt: null,
		link: "projects/p1",
		snippet: null,
		archivedAt: null,
		...over,
	};
}

function reset() {
	findMany.mockReset();
	userFindMany.mockReset();
	orgFindMany.mockReset();
	projectFindMany.mockReset();
	userFindMany.mockResolvedValue([]);
	orgFindMany.mockResolvedValue([
		{ id: "org-a", slug: "team-alpha", name: "Team Alpha" },
	]);
	projectFindMany.mockResolvedValue([]);
}

async function call(input: Record<string, unknown> = {}) {
	return (listNotificationsProcedure as any)({
		input: { organizationId: "org-a", status: "all", limit: 20, ...input },
		context: { user: { id: "u1" }, session: {} },
	});
}

describe("list — chip name hydration", () => {
	it("returns the organization name alongside the slug", async () => {
		reset();
		findMany.mockResolvedValue([row()]);

		const out = await call();

		expect(out.items[0].organizationSlug).toBe("team-alpha");
		expect(out.items[0].organizationName).toBe("Team Alpha");
	});

	it("returns the project name when the notification has a project", async () => {
		reset();
		findMany.mockResolvedValue([row({ projectId: "p1" })]);
		projectFindMany.mockResolvedValue([
			{ id: "p1", name: "Fabric Portal" },
		]);

		const out = await call();

		expect(out.items[0].projectName).toBe("Fabric Portal");
		expect(projectFindMany).toHaveBeenCalledTimes(1);
		const args = projectFindMany.mock.calls[0][0];
		expect(args.where).toEqual({ id: { in: ["p1"] } });
		expect(args.select).toEqual({ id: true, name: true });
	});

	it("skips the Project query entirely when no row has a project", async () => {
		reset();
		findMany.mockResolvedValue([row()]);

		const out = await call();

		expect(projectFindMany).not.toHaveBeenCalled();
		expect(out.items[0].projectName).toBeNull();
	});

	it("returns a null project name when the project no longer resolves", async () => {
		reset();
		findMany.mockResolvedValue([row({ projectId: "p-gone" })]);
		projectFindMany.mockResolvedValue([]);

		const out = await call();

		expect(out.items[0].projectName).toBeNull();
	});

	it("deduplicates projectIds before the Project query", async () => {
		reset();
		findMany.mockResolvedValue([
			row({ id: "n1", projectId: "p1" }),
			row({ id: "n2", projectId: "p1" }),
			row({ id: "n3", projectId: "p2" }),
		]);
		projectFindMany.mockResolvedValue([
			{ id: "p1", name: "One" },
			{ id: "p2", name: "Two" },
		]);

		await call();

		expect(projectFindMany).toHaveBeenCalledTimes(1);
		expect(projectFindMany.mock.calls[0][0].where).toEqual({
			id: { in: ["p1", "p2"] },
		});
	});

	it("resolves names only for rows inside the returned page, not the over-fetched tail", async () => {
		// The handler over-fetches (limit * 2 + 1) to absorb access-filter
		// rejections, then slices to `limit`. Name resolution must key off the
		// slice — resolving the tail would query projects the caller may never
		// be shown.
		reset();
		findMany.mockResolvedValue([
			row({ id: "n1", projectId: "p-visible" }),
			row({ id: "n2", projectId: "p-beyond-page" }),
		]);
		projectFindMany.mockResolvedValue([
			{ id: "p-visible", name: "Visible" },
		]);

		const out = await call({ limit: 1 });

		expect(out.items).toHaveLength(1);
		expect(projectFindMany.mock.calls[0][0].where).toEqual({
			id: { in: ["p-visible"] },
		});
	});
});
