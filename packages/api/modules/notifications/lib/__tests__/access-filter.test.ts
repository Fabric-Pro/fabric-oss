/**
 * Verifies the read-time RBAC re-check drops notifications whose source
 * project the user can no longer access, while keeping rows with no
 * projectId (system-level / account-scope notifications).
 *
 * AND THAT IT ASKS FOR THE RIGHT PROJECTS IN THE FIRST PLACE. The behavioural
 * tests below all reach the filter through a MOCKED `project.findMany`, so
 * every one of them passes whatever the `where` clause says: the rows the mock
 * returns are the rows the filter keeps. That left the three access arms —
 * personal owner, active project member, organization member — assertable by
 * nothing at all, in one of the five places this codebase renders that rule.
 * The arm suite at the bottom is the guard, and it is structural on purpose:
 * this file's copy of the rule is a union rather than a precedence, so a
 * widening here cannot be caught by asking it about one notification.
 */

import type { Notification } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		project: { findMany: vi.fn() },
	},
}));

async function loadModule() {
	return await import("../access-filter");
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		project: { findMany: ReturnType<typeof vi.fn> };
	};
}

beforeEach(async () => {
	const db = await getMockDb();
	db.project.findMany.mockReset();
});

function notif(over: Partial<Notification>): Notification {
	return {
		id: "n",
		userId: "user-bob",
		organizationId: null,
		type: "STORY_MENTION",
		category: "MENTION",
		title: "x",
		snippet: null,
		link: null,
		iconKey: null,
		projectId: null,
		storyId: null,
		taskId: null,
		commentId: null,
		documentId: null,
		actorUserId: null,
		payload: {},
		readAt: null,
		archivedAt: null,
		dedupeKey: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as Notification;
}

describe("filterByCurrentAccess", () => {
	it("returns the input unchanged when no notifications carry a projectId", async () => {
		const { filterByCurrentAccess } = await loadModule();
		const db = await getMockDb();
		const input = [notif({ id: "a" }), notif({ id: "b" })];

		const result = await filterByCurrentAccess(input, "user-bob");

		expect(result).toEqual(input);
		expect(db.project.findMany).not.toHaveBeenCalled();
	});

	it("drops rows whose projectId is not in the allowed set", async () => {
		const { filterByCurrentAccess } = await loadModule();
		const db = await getMockDb();
		db.project.findMany.mockResolvedValue([{ id: "p1" }]); // p2 NOT returned

		const result = await filterByCurrentAccess(
			[
				notif({ id: "a", projectId: "p1" }),
				notif({ id: "b", projectId: "p2" }),
			],
			"user-bob",
		);

		expect(result.map((n) => n.id)).toEqual(["a"]);
	});

	it("keeps system-scope rows (projectId=null) even when project lookup is empty", async () => {
		const { filterByCurrentAccess } = await loadModule();
		const db = await getMockDb();
		db.project.findMany.mockResolvedValue([]);

		const result = await filterByCurrentAccess(
			[
				notif({ id: "sys", projectId: null }),
				notif({ id: "drop", projectId: "p1" }),
			],
			"user-bob",
		);

		expect(result.map((n) => n.id)).toEqual(["sys"]);
	});

	it("issues a single bulk query regardless of how many distinct projects appear", async () => {
		const { filterByCurrentAccess } = await loadModule();
		const db = await getMockDb();
		db.project.findMany.mockResolvedValue([
			{ id: "p1" },
			{ id: "p2" },
			{ id: "p3" },
		]);

		await filterByCurrentAccess(
			[
				notif({ id: "a", projectId: "p1" }),
				notif({ id: "b", projectId: "p2" }),
				notif({ id: "c", projectId: "p3" }),
				notif({ id: "d", projectId: "p1" }),
			],
			"user-bob",
		);

		expect(db.project.findMany).toHaveBeenCalledTimes(1);
		const where = db.project.findMany.mock.calls[0][0].where;
		expect(where.id.in.sort()).toEqual(["p1", "p2", "p3"]);
	});
});

// ---------------------------------------------------------------------------
// The access arms themselves
// ---------------------------------------------------------------------------

describe("filterByCurrentAccess — the arms it asks for", () => {
	/** Run the filter once and hand back the `where` it queried with. */
	async function projectWhere(): Promise<Record<string, unknown>> {
		const db = await getMockDb();
		db.project.findMany.mockResolvedValue([]);
		const { filterByCurrentAccess } = await loadModule();

		await filterByCurrentAccess(
			[notif({ id: "n1", projectId: "project-1" })],
			"user-bob",
		);

		return db.project.findMany.mock.calls[0]?.[0]?.where ?? {};
	}

	it("narrows to the notifications' own projects", async () => {
		const where = await projectWhere();

		// Without this the filter would resolve the caller's whole project
		// list on every notification read, and the arms below would be
		// answering about projects nobody asked about.
		expect(where.id).toEqual({ in: ["project-1"] });
	});

	it("offers exactly three arms, and they are the documented three", async () => {
		const arms = ((await projectWhere()).OR ?? []) as Array<
			Record<string, unknown>
		>;

		expect(arms).toHaveLength(3);

		// 1. The personal-project owner. `organizationId: null` is the whole of
		// its safety: a bare `{ userId }` would hand the creator of an
		// ORGANIZATION project their notifications after they left the
		// organization.
		expect(arms).toContainEqual({
			userId: "user-bob",
			organizationId: null,
		});

		// 2. An accepted, unexpired project membership. Both halves matter: a
		// pending invitation is not access, and an expired one stopped being
		// access.
		const membership = arms.find((arm) => "members" in arm) as {
			members: {
				some: {
					userId: string;
					acceptedAt: unknown;
					OR: Array<Record<string, unknown>>;
				};
			};
		};
		expect(membership.members.some.userId).toBe("user-bob");
		expect(membership.members.some.acceptedAt).toEqual({ not: null });
		expect(membership.members.some.OR).toHaveLength(2);
		expect(membership.members.some.OR[0]).toEqual({ expiresAt: null });
		expect(
			(membership.members.some.OR[1] as { expiresAt: { gt: Date } })
				.expiresAt.gt,
		).toBeInstanceOf(Date);

		// 3. Membership of the host organization. This arm is why the filter is
		// WIDER than `buildProjectAccessWhere`, and that is deliberate here:
		// a notification is a record that something already happened to you,
		// not an invitation to open the project it came from.
		expect(arms).toContainEqual({
			organization: { members: { some: { userId: "user-bob" } } },
		});
	});

	it("asks only for the id, so a widening cannot also become a leak", async () => {
		const select = (await (async () => {
			const db = await getMockDb();
			db.project.findMany.mockResolvedValue([]);
			const { filterByCurrentAccess } = await loadModule();
			await filterByCurrentAccess(
				[notif({ id: "n1", projectId: "project-1" })],
				"user-bob",
			);
			return db.project.findMany.mock.calls[0]?.[0];
		})()).select;

		expect(select).toEqual({ id: true });
	});
});
