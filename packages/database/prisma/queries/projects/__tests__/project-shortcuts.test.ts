import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const projectFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../../../client", () => ({
	db: {
		projectUserPreference: {
			findMany: (...args: unknown[]) => findMany(...args),
			updateMany: (...args: unknown[]) => updateMany(...args),
			create: (...args: unknown[]) => create(...args),
		},
		// Only the create path reads this — to denormalize the project's org onto
		// a brand-new preference row.
		project: {
			findUnique: (...args: unknown[]) => projectFindUnique(...args),
		},
	},
	Prisma: {},
}));

import {
	listProjectShortcuts,
	recordProjectVisit,
	setProjectFavorite,
} from "../project-shortcuts";

function row(id: string, name: string, slug: string | null = null) {
	return {
		favoritedAt: null,
		project: {
			id,
			name,
			organization: slug ? { slug } : null,
		},
	};
}

/** findMany is called twice — favorites branch first, recents branch second. */
function resolveBranches(favorites: unknown[], recents: unknown[]) {
	findMany.mockImplementation((args: { where: { favoritedAt: unknown } }) =>
		Promise.resolve(args.where.favoritedAt === null ? recents : favorites),
	);
}

const favoritesCall = () =>
	findMany.mock.calls.find(
		(c) =>
			(c[0] as { where: { favoritedAt: unknown } }).where.favoritedAt !==
			null,
	)?.[0] as {
		where: Record<string, unknown>;
		orderBy: unknown;
		take: number;
	};

const recentsCall = () =>
	findMany.mock.calls.find(
		(c) =>
			(c[0] as { where: { favoritedAt: unknown } }).where.favoritedAt ===
			null,
	)?.[0] as {
		where: Record<string, unknown>;
		orderBy: unknown;
		take: number;
	};

beforeEach(() => {
	findMany.mockReset();
	updateMany.mockReset();
	create.mockReset();
	projectFindUnique.mockReset();
	projectFindUnique.mockResolvedValue({ organizationId: null });
});

describe("listProjectShortcuts — merge and ordering", () => {
	it("puts one favorite first and fills the rest by recency", async () => {
		resolveBranches(
			[row("f1", "Favorite")],
			[
				row("r1", "Recent A"),
				row("r2", "Recent B"),
				row("r3", "Recent C"),
			],
		);

		const result = await listProjectShortcuts({
			userId: "u1",
			organizationId: null,
		});

		expect(result.map((s) => s.id)).toEqual(["f1", "r1", "r2"]);
		expect(result[0].isFavorite).toBe(true);
		expect(result[1].isFavorite).toBe(false);
	});

	it("shows only favorites when there are enough of them", async () => {
		resolveBranches(
			[row("f1", "A"), row("f2", "B"), row("f3", "C"), row("f4", "D")],
			[row("r1", "Recent")],
		);

		const result = await listProjectShortcuts({
			userId: "u1",
			organizationId: "org-1",
		});

		expect(result).toHaveLength(3);
		expect(result.every((s) => s.isFavorite)).toBe(true);
	});

	it("returns a single entry when only one project qualifies", async () => {
		resolveBranches([], [row("r1", "Only")]);

		const result = await listProjectShortcuts({
			userId: "u1",
			organizationId: null,
		});

		expect(result).toEqual([
			{
				id: "r1",
				name: "Only",
				organizationSlug: null,
				isFavorite: false,
			},
		]);
	});

	it("returns nothing when the caller has no favorites and no visits", async () => {
		resolveBranches([], []);

		await expect(
			listProjectShortcuts({ userId: "u1", organizationId: null }),
		).resolves.toEqual([]);
	});

	it("carries the host organization slug for a guest-held project", async () => {
		resolveBranches([], [row("g1", "Shared", "acme")]);

		const [shortcut] = await listProjectShortcuts({
			userId: "guest",
			organizationId: null,
		});

		expect(shortcut.organizationSlug).toBe("acme");
	});
});

describe("listProjectShortcuts — legacy rows and eligibility", () => {
	it("requires a non-null timestamp on each branch so legacy rows cannot rank", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "u1", organizationId: null });

		// A row that only carries a dismissed widget or a saved view has null in
		// both columns; a plain DESC sort would place it FIRST in Postgres.
		expect(favoritesCall().where.favoritedAt).toEqual({ not: null });
		expect(recentsCall().where.lastVisitedAt).toEqual({ not: null });
	});

	it("sorts never-visited favorites last, then by when they were starred", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "u1", organizationId: null });

		expect(favoritesCall().orderBy).toEqual([
			{ lastVisitedAt: { sort: "desc", nulls: "last" } },
			{ favoritedAt: "desc" },
		]);
	});

	it("excludes draft and archived projects and soft-deleted ones", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "u1", organizationId: "org-1" });

		const project = favoritesCall().where.project as Record<
			string,
			unknown
		>;
		expect(project.deletedAt).toBeNull();
		expect(project.status).toEqual({ notIn: ["DRAFT", "ARCHIVED"] });
	});

	it("bounds each branch by the display limit", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({
			userId: "u1",
			organizationId: null,
			limit: 3,
		});

		expect(favoritesCall().take).toBe(3);
		expect(recentsCall().take).toBe(3);
	});
});

describe("listProjectShortcuts — tenant boundary", () => {
	it("scopes organization context to that organization", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "u1", organizationId: "org-1" });

		const project = favoritesCall().where.project as Record<
			string,
			unknown
		>;
		expect(project.organizationId).toBe("org-1");
	});

	it("uses a two-arm union in personal context so guests resolve", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "u1", organizationId: null });

		const project = favoritesCall().where.project as {
			OR: Array<Record<string, unknown>>;
		};
		expect(project.OR).toHaveLength(2);

		const [personalArm, guestArm] = project.OR;
		expect(personalArm.organizationId).toBeNull();
		expect(guestArm.organizationId).toEqual({ not: null });
		// Without this exclusion a full org member's projects leak into their
		// personal navigation.
		expect(guestArm.organization).toEqual({
			members: { none: { userId: "u1" } },
		});
	});

	it("never filters preference rows by organization", async () => {
		resolveBranches([], []);
		await listProjectShortcuts({ userId: "guest", organizationId: null });

		// The column is a denormalized copy of the project's org; filtering on it
		// would hide a guest's own row from them.
		expect(favoritesCall().where).not.toHaveProperty("organizationId");
		expect(recentsCall().where).not.toHaveProperty("organizationId");
	});
});

describe("setProjectFavorite", () => {
	it("updates the existing row without creating a second one", async () => {
		updateMany.mockResolvedValue({ count: 1 });

		await setProjectFavorite({
			projectId: "p1",
			userId: "u1",
			favorited: true,
		});

		expect(create).not.toHaveBeenCalled();
	});

	it("creates the row when the caller has no preferences yet", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		create.mockResolvedValue({});
		projectFindUnique.mockResolvedValue({ organizationId: "org-1" });

		await setProjectFavorite({
			projectId: "p1",
			userId: "u1",
			favorited: true,
		});

		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].data).toMatchObject({
			projectId: "p1",
			userId: "u1",
			// Denormalized from the project by id — never from the caller's tenant
			// context, which for a guest resolving in personal context is null.
			organizationId: "org-1",
		});
	});

	it("denormalizes a guest's host organization onto a new row", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		create.mockResolvedValue({});
		projectFindUnique.mockResolvedValue({ organizationId: "host-org" });

		await setProjectFavorite({
			projectId: "shared",
			userId: "guest",
			favorited: true,
		});

		// A tenant-scoped project lookup would have found nothing here.
		expect(projectFindUnique.mock.calls[0][0].where).toEqual({
			id: "shared",
		});
		expect(create.mock.calls[0][0].data.organizationId).toBe("host-org");
	});

	it("still lands its value after losing the create race", async () => {
		// Both writers miss the update, both attempt create, this one loses.
		updateMany
			.mockResolvedValueOnce({ count: 0 })
			.mockResolvedValueOnce({ count: 1 });
		create.mockRejectedValueOnce(
			Object.assign(new Error("dup"), { code: "P2002" }),
		);

		await setProjectFavorite({
			projectId: "p1",
			userId: "u1",
			favorited: true,
		});

		// Treating the collision as success would have discarded the favorite.
		expect(updateMany).toHaveBeenCalledTimes(2);
	});

	it("clears the timestamp when unfavoriting", async () => {
		updateMany.mockResolvedValue({ count: 1 });

		await setProjectFavorite({
			projectId: "p1",
			userId: "u1",
			favorited: false,
		});

		expect(updateMany.mock.calls[0][0].data).toEqual({ favoritedAt: null });
	});

	it("rethrows a non-collision failure", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		create.mockRejectedValue(new Error("connection lost"));

		await expect(
			setProjectFavorite({
				projectId: "p1",
				userId: "u1",
				favorited: true,
			}),
		).rejects.toThrow("connection lost");
	});
});

describe("recordProjectVisit", () => {
	it("guards on the stored timestamp so recency cannot move backwards", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const now = new Date("2026-08-04T12:00:00Z");

		await recordProjectVisit({
			projectId: "p1",
			userId: "u1",
			now,
		});

		expect(updateMany.mock.calls[0][0].where.OR).toEqual([
			{ lastVisitedAt: null },
			{ lastVisitedAt: { lt: now } },
		]);
	});

	it("writes the timestamp without disturbing other preference fields", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const now = new Date("2026-08-04T12:00:00Z");

		await recordProjectVisit({
			projectId: "p1",
			userId: "u1",
			now,
		});

		expect(updateMany.mock.calls[0][0].data).toEqual({
			lastVisitedAt: now,
		});
	});

	it("creates the row on a first visit", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		create.mockResolvedValue({});

		await recordProjectVisit({
			projectId: "p1",
			userId: "u1",
		});

		expect(create).toHaveBeenCalledTimes(1);
	});

	it("resolves quietly when a concurrent write already stored a newer visit", async () => {
		// Update matches nothing (guard rejected it), create collides, retry also
		// matches nothing — the stored value is newer, which is correct.
		updateMany.mockResolvedValue({ count: 0 });
		create.mockRejectedValue(
			Object.assign(new Error("dup"), { code: "P2002" }),
		);

		await expect(
			recordProjectVisit({
				projectId: "p1",
				userId: "u1",
			}),
		).resolves.toBeUndefined();
	});
});
