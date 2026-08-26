/**
 * Verifies fanOut.storyShared:
 * - filters out the actor (self) before writing
 * - returns the count of rows ACTUALLY written (not the request size)
 * - a preference-suppressed recipient is not counted
 * - self-only recipient list writes nothing and returns 0
 *
 * Mocks `db.notification.*`, `getNotificationPreferences`, the cache, and
 * external delivery at the boundary so the test exercises pure fan-out +
 * createNotification logic. `isCategoryEnabled` / `CATEGORY_TO_TOGGLE` stay real.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPrefsMock } = vi.hoisted(() => ({ getPrefsMock: vi.fn() }));

const ALL_ENABLED = {
	mentions: true,
	replies: true,
	assignments: true,
	status: true,
	syncProject: true,
	aiAgent: true,
};
const MENTIONS_OFF = { ...ALL_ENABLED, mentions: false };

vi.mock("@repo/database", async () => {
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		getNotificationPreferences: getPrefsMock,
		db: {
			notification: {
				findFirst: vi.fn(),
				create: vi.fn(),
				updateMany: vi.fn(),
			},
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../notification-cache", () => ({
	invalidateUnreadCount: vi.fn().mockResolvedValue(undefined),
	getCachedUnreadCount: vi.fn().mockResolvedValue(null),
	setCachedUnreadCount: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../notification-delivery", () => ({
	dispatchExternalDelivery: vi.fn().mockResolvedValue(undefined),
}));

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		notification: {
			create: ReturnType<typeof vi.fn>;
		};
	};
}

const baseArgs = {
	storyId: "story-1",
	projectId: "proj-1",
	organizationId: null,
	actorUserId: "user-1",
	actorName: "Alice",
	featureTitle: "Dark mode",
	identifier: "F-007",
	link: "projects/proj-1/stories/story-1",
	message: "please review",
};

beforeEach(() => {
	vi.clearAllMocks();
	getPrefsMock.mockResolvedValue(ALL_ENABLED);
});

describe("fanOut.storyShared", () => {
	it("filters out the actor and returns the count of rows written", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.storyShared({
			...baseArgs,
			// actor included in the list — must be filtered, not written.
			recipientUserIds: ["user-1", "user-2", "user-3"],
		});

		expect(count).toBe(2);
		const calls = db.notification.create.mock.calls.map(
			(c) => (c[0] as { data: { userId: string; title: string } }).data,
		);
		const writtenUserIds = calls.map((d) => d.userId);
		expect(writtenUserIds.sort()).toEqual(["user-2", "user-3"]);
		expect(writtenUserIds).not.toContain("user-1");
		// Title carries the F-XXX identifier + feature title as context.
		expect(calls[0].title).toBe("Alice shared F-007 · Dark mode");
	});

	it("omits the 'a feature' filler in the title when there is no identifier", async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.storyShared({
			...baseArgs,
			identifier: null,
			recipientUserIds: ["user-2"],
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string };
		};
		expect(data.title).toBe("Alice shared Dark mode");
	});

	it("does not count a recipient whose MENTION preference is disabled", async () => {
		getPrefsMock.mockImplementation(async (userId: string) =>
			userId === "user-3" ? MENTIONS_OFF : ALL_ENABLED,
		);
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.storyShared({
			...baseArgs,
			recipientUserIds: ["user-2", "user-3"],
		});

		// user-3 is suppressed at write time → one row written, count = 1.
		expect(count).toBe(1);
		expect(db.notification.create).toHaveBeenCalledTimes(1);
	});

	it("writes nothing and returns 0 when the only recipient is the actor", async () => {
		const db = await getMockDb();
		const { fanOut } = await import("../notification-service");

		const count = await fanOut.storyShared({
			...baseArgs,
			recipientUserIds: ["user-1"],
		});

		expect(count).toBe(0);
		expect(db.notification.create).not.toHaveBeenCalled();
	});
});
