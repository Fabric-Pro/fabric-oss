/**
 * Tests for `emitCompletionNotification()` — the temporal-side notification
 * insert called by `updateParentStatusActivity` on terminal status.
 *
 * Covers (per spec §13.1 + tasks.md 6.6):
 *   - Notification payload shape for COMPLETED (title = "Indexed ${url}",
 *     snippet = "${pagesIndexed} pages ready for AI", correct dedupeKey).
 *   - Notification payload shape for FAILED (title = "Failed to index
 *     ${url}", snippet = extractionError ?? "Crawl failed").
 *   - Silent-on-CANCELLED: invoking with status=CANCELLED inserts no row.
 *   - Silent-on-no-userId: workflows kicked off without a userId (e.g.,
 *     reconciliation) don't emit a notification.
 *   - P2002 coalesce: a duplicate dedupeKey collision falls into updateMany
 *     instead of bubbling the error.
 *
 * Spec ref: `2026-05-23-unified-context-uploader-wizard/spec.md` §8.2, §6.4.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database/prisma/client", () => ({
	db: {
		notification: {
			create: vi.fn(),
			updateMany: vi.fn(),
		},
		organization: {
			findUnique: vi.fn(),
		},
	},
}));

vi.mock("../../../src/activities/lib/activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { db } from "@repo/database/prisma/client";
import { emitCompletionNotification } from "../../src/activities/url-source/lib/emit-completion-notification";

const mockNotificationCreate = db.notification.create as ReturnType<
	typeof vi.fn
>;
const mockNotificationUpdate = db.notification.updateMany as ReturnType<
	typeof vi.fn
>;
const mockOrgFindUnique = db.organization.findUnique as ReturnType<
	typeof vi.fn
>;

beforeEach(() => {
	vi.clearAllMocks();
	mockNotificationCreate.mockResolvedValue({ id: "notif-1" });
	mockNotificationUpdate.mockResolvedValue({ count: 1 });
	mockOrgFindUnique.mockResolvedValue(null);
});

describe("emitCompletionNotification — COMPLETED success path", () => {
	it("inserts a CONTEXT_INDEXING_COMPLETED row with success title + snippet", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "COMPLETED",
			pagesIndexed: 12,
		});

		expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
		const call = mockNotificationCreate.mock.calls[0][0];
		expect(call.data).toMatchObject({
			userId: "user-1",
			organizationId: null,
			type: "CONTEXT_INDEXING_COMPLETED",
			category: "CONTEXT_INDEXING_COMPLETED",
			title: "Indexed example.com/docs",
			snippet: "12 pages ready for AI",
			link: "/app/projects/proj-1/context",
			projectId: "proj-1",
			dedupeKey: "context-indexing-completed:ctx-1",
		});
		expect(call.data.payload).toMatchObject({
			contextId: "ctx-1",
			sourceUrl: "https://example.com/docs",
			status: "COMPLETED",
			pagesIndexed: 12,
			extractionError: null,
		});
	});

	it("uses org-scoped link when organizationId resolves to a slug", async () => {
		mockOrgFindUnique.mockResolvedValue({ slug: "acme" });

		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			sourceUrl: "https://example.com/docs",
			extractionStatus: "COMPLETED",
			pagesIndexed: 3,
		});

		expect(mockNotificationCreate.mock.calls[0][0].data).toMatchObject({
			organizationId: "org-1",
			link: "/app/acme/projects/proj-1/context",
		});
	});

	it("falls back to personal link when org lookup throws", async () => {
		// Org slug lookup is best-effort — if it throws, the notification
		// still goes out, just with the personal-form link.
		mockOrgFindUnique.mockRejectedValue(new Error("db connection lost"));

		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: "org-1",
			sourceUrl: "https://example.com/docs",
			extractionStatus: "COMPLETED",
			pagesIndexed: 1,
		});

		// Note: organizationId is still the org id (correct tenancy) but the
		// link defaults to personal form since the slug couldn't be resolved.
		expect(mockNotificationCreate.mock.calls[0][0].data).toMatchObject({
			organizationId: "org-1",
			link: "/app/projects/proj-1/context",
		});
	});
});

describe("emitCompletionNotification — FAILED branch", () => {
	it("uses the failure title and the extractionError as snippet", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "FAILED",
			extractionError: "robots.txt disallowed crawl",
		});

		const call = mockNotificationCreate.mock.calls[0][0];
		expect(call.data).toMatchObject({
			type: "CONTEXT_INDEXING_COMPLETED",
			title: "Failed to index example.com/docs",
			snippet: "robots.txt disallowed crawl",
		});
		expect(call.data.payload.status).toBe("FAILED");
	});

	it("falls back to 'Crawl failed' when extractionError is null", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "FAILED",
			extractionError: null,
		});

		expect(mockNotificationCreate.mock.calls[0][0].data.snippet).toBe(
			"Crawl failed",
		);
	});
});

describe("emitCompletionNotification — silent paths", () => {
	it("skips on CANCELLED status (spec §6.4 silent-cancel)", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "CANCELLED",
		});

		expect(mockNotificationCreate).not.toHaveBeenCalled();
	});

	it("skips when status is non-terminal (defensive guard)", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "EXTRACTING",
		});

		expect(mockNotificationCreate).not.toHaveBeenCalled();
	});

	it("skips when userId is null (no recipient — reconciliation workflows)", async () => {
		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: null,
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "COMPLETED",
			pagesIndexed: 1,
		});

		expect(mockNotificationCreate).not.toHaveBeenCalled();
	});
});

describe("emitCompletionNotification — dedupe coalesce", () => {
	it("coalesces into updateMany on P2002 unique-violation", async () => {
		// Simulate the partial unique index firing — a duplicate dedupeKey
		// hit within the 60s live window. Per spec §8.5 the second emit
		// should silently update the existing live row instead of throwing.
		mockNotificationCreate.mockRejectedValue(
			Object.assign(new Error("Unique constraint failed"), {
				code: "P2002",
			}),
		);

		await emitCompletionNotification({
			contextId: "ctx-1",
			projectId: "proj-1",
			userId: "user-1",
			organizationId: null,
			sourceUrl: "https://example.com/docs",
			extractionStatus: "COMPLETED",
			pagesIndexed: 7,
		});

		expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
		expect(mockNotificationUpdate).toHaveBeenCalledTimes(1);
		expect(mockNotificationUpdate.mock.calls[0][0]).toMatchObject({
			where: {
				userId: "user-1",
				dedupeKey: "context-indexing-completed:ctx-1",
				readAt: null,
				archivedAt: null,
			},
			data: expect.objectContaining({
				title: "Indexed example.com/docs",
				snippet: "7 pages ready for AI",
			}),
		});
	});

	it("swallows non-P2002 errors so the activity never fails on notification dispatch", async () => {
		mockNotificationCreate.mockRejectedValue(
			new Error("db connection lost"),
		);

		// Should NOT throw — the notification is best-effort.
		await expect(
			emitCompletionNotification({
				contextId: "ctx-1",
				projectId: "proj-1",
				userId: "user-1",
				organizationId: null,
				sourceUrl: "https://example.com/docs",
				extractionStatus: "COMPLETED",
				pagesIndexed: 1,
			}),
		).resolves.toBeUndefined();

		// Non-P2002 errors do NOT trigger the coalesce updateMany.
		expect(mockNotificationUpdate).not.toHaveBeenCalled();
	});
});
