/**
 * Verifies fanOut.subscriptionUpdate:
 *  - loads subscribers for the subject, filters out the actor
 *  - drops subscribers who lost project access (authorization filter)
 *  - writes one SUBSCRIPTION notification per remaining subscriber, with the
 *    coalescing dedupeKey and the right type per subjectType
 *  - validates the DOCUMENT_UPDATED / FEATURE_UPDATED payloads (real validator)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPrefsMock, authFilterMock } = vi.hoisted(() => ({
	getPrefsMock: vi.fn(),
	authFilterMock: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	// Spread the real barrel (enums, CATEGORY_TO_TOGGLE, isCategoryEnabled, and
	// the many transitive exports the module graph needs) and override only the
	// bits under test. `...actual` copies the lazy `db` Proxy by reference but
	// never triggers its get-trap, so no real Prisma init — then `db` below
	// replaces it wholesale. Mirrors notification-service.test.ts.
	const actual = (await vi.importActual("@repo/database")) as Record<
		string,
		unknown
	>;
	return {
		...actual,
		getNotificationPreferences: getPrefsMock,
		db: {
			subscription: { findMany: vi.fn() },
			notification: {
				findFirst: vi.fn(),
				create: vi.fn(),
				updateMany: vi.fn(),
			},
		},
	};
});

vi.mock("../../modules/projects/lib/user-mention", () => ({
	filterAuthorizedMentionRecipients: authFilterMock,
}));

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

async function loadModule() {
	return await import("../notification-service");
}

async function getMockDb() {
	const mod = await import("@repo/database");
	return mod.db as unknown as {
		subscription: { findMany: ReturnType<typeof vi.fn> };
		notification: {
			findFirst: ReturnType<typeof vi.fn>;
			create: ReturnType<typeof vi.fn>;
			updateMany: ReturnType<typeof vi.fn>;
		};
	};
}

beforeEach(async () => {
	const db = await getMockDb();
	db.subscription.findMany.mockReset();
	db.notification.findFirst.mockReset();
	db.notification.create.mockReset();
	db.notification.updateMany.mockReset();
	// create echoes back a row-ish object so createNotification returns cleanly.
	db.notification.create.mockImplementation(async ({ data }) => ({
		id: "notif-1",
		...data,
	}));
	getPrefsMock.mockReset();
	// SUBSCRIPTION is always-on (absent from CATEGORY_TO_TOGGLE), so prefs are
	// never consulted — but default to a benign value regardless.
	getPrefsMock.mockResolvedValue({});
	authFilterMock.mockReset();
});

const baseArgs = {
	subjectType: "FEATURE" as const,
	subjectId: "story-1",
	projectId: "p1",
	organizationId: "org-A",
	actorUserId: "user-actor",
	actorName: "Alice",
	title: "Login flow",
	link: "projects/p1/stories/story-1",
	changeKind: "content" as const,
};

describe("fanOut.subscriptionUpdate", () => {
	it("filters out the actor and notifies the remaining subscribers", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.subscription.findMany.mockResolvedValue([
			{ userId: "user-actor" }, // the actor — must be skipped
			{ userId: "user-bob" },
		]);
		// Authorization filter receives only the non-actor candidates.
		authFilterMock.mockResolvedValue(["user-bob"]);

		await fanOut.subscriptionUpdate(baseArgs);

		expect(authFilterMock).toHaveBeenCalledWith(
			["user-bob"],
			"p1",
			"org-A",
		);
		expect(db.notification.create).toHaveBeenCalledTimes(1);
		const arg = db.notification.create.mock.calls[0][0].data;
		expect(arg.userId).toBe("user-bob");
		expect(arg.type).toBe("FEATURE_UPDATED");
		expect(arg.category).toBe("SUBSCRIPTION");
		expect(arg.title).toBe("Alice updated Login flow");
		expect(arg.dedupeKey).toBe("sub:FEATURE:story-1:user-bob");
		expect(arg.storyId).toBe("story-1");
	});

	it("drops subscribers who lost project access", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.subscription.findMany.mockResolvedValue([
			{ userId: "user-bob" },
			{ userId: "user-gone" },
		]);
		authFilterMock.mockResolvedValue(["user-bob"]); // user-gone filtered

		await fanOut.subscriptionUpdate(baseArgs);

		expect(db.notification.create).toHaveBeenCalledTimes(1);
		expect(db.notification.create.mock.calls[0][0].data.userId).toBe(
			"user-bob",
		);
	});

	it("maps DOCUMENT subjectType to DOCUMENT_UPDATED with a document source", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.subscription.findMany.mockResolvedValue([{ userId: "user-bob" }]);
		authFilterMock.mockResolvedValue(["user-bob"]);

		await fanOut.subscriptionUpdate({
			...baseArgs,
			subjectType: "DOCUMENT",
			subjectId: "doc-9",
			link: "projects/p1/documents/doc-9",
		});

		const arg = db.notification.create.mock.calls[0][0].data;
		expect(arg.type).toBe("DOCUMENT_UPDATED");
		expect(arg.documentId).toBe("doc-9");
		expect(arg.storyId).toBeUndefined();
		expect(arg.dedupeKey).toBe("sub:DOCUMENT:doc-9:user-bob");
	});

	it("no-ops when there are no subscribers", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.subscription.findMany.mockResolvedValue([]);

		await fanOut.subscriptionUpdate(baseArgs);

		expect(authFilterMock).not.toHaveBeenCalled();
		expect(db.notification.create).not.toHaveBeenCalled();
	});

	it("no-ops when the only subscriber is the actor", async () => {
		const { fanOut } = await loadModule();
		const db = await getMockDb();
		db.subscription.findMany.mockResolvedValue([{ userId: "user-actor" }]);

		await fanOut.subscriptionUpdate(baseArgs);

		expect(authFilterMock).not.toHaveBeenCalled();
		expect(db.notification.create).not.toHaveBeenCalled();
	});
});
