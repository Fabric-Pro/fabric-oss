/**
 * Verifies the read-time RBAC re-check drops notifications whose source
 * project the user can no longer access, while keeping rows with no
 * projectId (system-level / account-scope notifications).
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
