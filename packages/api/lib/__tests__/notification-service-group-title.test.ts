/**
 * Verifies the optional `groupLabel` support on `fanOut.mention` and
 * `fanOut.documentMention` (Stage 5 @Group mentions, prerequisite for
 * tasks 6/8 which will pass a real group label through).
 *
 * When `groupLabel` is set the notification title switches to
 * "{actor} mentioned @{groupLabel}[ in {documentTitle}]"; when it is
 * absent (existing callers), the title is byte-for-byte the legacy
 * "{actor} mentioned you[ in {documentTitle}]" copy — back-compat.
 *
 * Mocks `db.notification.*`, `getNotificationPreferences`, the cache, and
 * external delivery at the boundary so the test exercises pure fan-out +
 * createNotification logic, matching notification-service-storyShared.test.ts.
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

beforeEach(() => {
	vi.clearAllMocks();
	getPrefsMock.mockResolvedValue(ALL_ENABLED);
});

describe("fanOut.mention groupLabel", () => {
	it('writes "Alice mentioned @Developers" when groupLabel is set', async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.mention({
			recipientUserIds: ["user-2"],
			commentId: "comment-1",
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
			actorName: "Alice",
			target: { storyId: "story-1" },
			link: "projects/proj-1/stories/story-1",
			snippet: "please review",
			groupLabel: "Developers",
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string };
		};
		expect(data.title).toBe("Alice mentioned @Developers");
	});

	it('writes "Alice mentioned you" when groupLabel is absent (back-compat)', async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.mention({
			recipientUserIds: ["user-2"],
			commentId: "comment-1",
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
			actorName: "Alice",
			target: { storyId: "story-1" },
			link: "projects/proj-1/stories/story-1",
			snippet: "please review",
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string };
		};
		expect(data.title).toBe("Alice mentioned you");
	});
});

describe("fanOut.documentMention groupLabel", () => {
	it('writes "Alice mentioned @Developers in Spec" when groupLabel is set', async () => {
		const db = await getMockDb();
		db.notification.create.mockImplementation(
			async ({ data }: { data: { userId: string } }) => ({
				id: `n-${data.userId}`,
				...data,
			}),
		);
		const { fanOut } = await import("../notification-service");

		await fanOut.documentMention({
			recipients: [{ userId: "user-2", anchorId: "m_abc" }],
			documentId: "doc-1",
			projectId: "proj-1",
			organizationId: null,
			actorUserId: "user-1",
			actorName: "Alice",
			documentTitle: "Spec",
			link: "projects/proj-1/documents/doc-1",
			snippetByAnchor: { m_abc: "please review" },
			groupLabel: "Developers",
		});

		const { data } = db.notification.create.mock.calls[0][0] as {
			data: { title: string };
		};
		expect(data.title).toBe("Alice mentioned @Developers in Spec");
	});
});
