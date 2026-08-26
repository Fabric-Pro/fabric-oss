/**
 * Tests for createPmAttachmentSyncFailedNotification (Fizzy #1745, AC-4).
 *
 * AC-4 and AC-10 both require a failed attachment upload to reach the
 * NOTIFICATION CENTRE, not only the sync log. This module is the fan-out;
 * the Prisma client and the preference helper are mocked so the recipient
 * and dedupe rules are exercised in isolation.
 *
 * Unlike the conflict fan-out, the ACTING user is a recipient here: they
 * pressed push, and they are the person who can retry it or widen the
 * token's scope.
 *
 * Run with: pnpm --filter @repo/database test __tests__/pm-attachment-notifications.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUniqueMock, createMock, enabledMock } = vi.hoisted(() => ({
	findUniqueMock: vi.fn(),
	createMock: vi.fn(),
	enabledMock: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		project: { findUnique: findUniqueMock },
		notification: { create: createMock },
	},
	NotificationCategory: { PROJECT: "PROJECT" },
	NotificationType: {
		PM_ATTACHMENT_SYNC_FAILED: "PM_ATTACHMENT_SYNC_FAILED",
	},
	ProjectMemberRole: { OWNER: "OWNER", PROJECT_ADMIN: "PROJECT_ADMIN" },
}));

vi.mock("../prisma/queries/notification-preferences", () => ({
	getEnabledRecipientsForCategory: enabledMock,
}));

import { createPmAttachmentSyncFailedNotification } from "../prisma/queries/pm-attachment-notifications";

const baseArgs = {
	actorUserId: "actor-1",
	organizationId: "org-1",
	projectId: "proj-1",
	storyId: "story-1",
	storyTitle: "Add login",
	pmToolLabel: "GitLab",
	failureSummary:
		"1 of 2 attachments failed to upload: spec.pdf (GitLab upload failed for spec.pdf: the configured GitLab token lacks the 'api' scope required to upload files (HTTP 403))",
	link: "projects/proj-1/stories/story-1",
};

const recipientsOf = () =>
	createMock.mock.calls.map((c) => c[0].data.userId).sort();

describe("createPmAttachmentSyncFailedNotification (Fizzy #1745, AC-4)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		enabledMock.mockImplementation((ids: string[]) =>
			Promise.resolve(new Set(ids)),
		);
		createMock.mockResolvedValue({});
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [{ userId: "admin-1" }],
		});
	});

	it("fans out to the acting user plus the project's owners/admins", async () => {
		await createPmAttachmentSyncFailedNotification(baseArgs);

		expect(recipientsOf()).toEqual(["actor-1", "admin-1", "owner-creator"]);
	});

	it("dedupes an actor who is also the project owner to a single row", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "actor-1",
			members: [{ userId: "actor-1" }],
		});

		await createPmAttachmentSyncFailedNotification(baseArgs);

		expect(createMock).toHaveBeenCalledTimes(1);
		expect(recipientsOf()).toEqual(["actor-1"]);
	});

	it("drops recipients who disabled the PROJECT notification category", async () => {
		enabledMock.mockResolvedValue(new Set(["actor-1"]));

		await createPmAttachmentSyncFailedNotification(baseArgs);

		expect(recipientsOf()).toEqual(["actor-1"]);
	});

	it("quotes the failure summary so the reader learns the file and the cause without leaving the inbox", async () => {
		await createPmAttachmentSyncFailedNotification(baseArgs);

		const row = createMock.mock.calls[0]?.[0].data;
		expect(row.snippet).toContain("spec.pdf");
		expect(row.snippet).toMatch(/api.*scope/i);
		expect(row.title).toContain("Add login");
		expect(row.type).toBe("PM_ATTACHMENT_SYNC_FAILED");
		expect(row.category).toBe("PROJECT");
		expect(row.projectId).toBe("proj-1");
		expect(row.storyId).toBe("story-1");
	});

	// The caller owns the claim about what happened; this module must not add
	// one of its own. A persist-kind failure means the file DID reach GitLab
	// and Fabric lost the link — a tail asserting "GitLab does not have them"
	// is then the exact reverse of the truth.
	it("does not append a claim about where the files ended up", async () => {
		await createPmAttachmentSyncFailedNotification({
			...baseArgs,
			failureSummary:
				"1 reached GitLab but Fabric could not record the link, so the next push will upload a duplicate: spec.pdf (db down)",
		});

		const row = createMock.mock.calls[0]?.[0].data;
		expect(row.snippet).not.toMatch(/does not have them/i);
		expect(row.snippet).not.toMatch(/nothing was lost/i);
		expect(row.snippet).toContain("reached GitLab");
	});

	it("caps the snippet at the same 280 characters as the sibling PM writer", async () => {
		await createPmAttachmentSyncFailedNotification({
			...baseArgs,
			failureSummary: `${"x".repeat(400)} tail`,
		});

		const row = createMock.mock.calls[0]?.[0].data;
		expect(row.snippet.length).toBeLessThanOrEqual(280);
	});

	it("keys the dedupe per story and recipient, so a re-push does not stack a second unread row", async () => {
		await createPmAttachmentSyncFailedNotification(baseArgs);

		const keys = createMock.mock.calls.map((c) => c[0].data.dedupeKey);
		expect(new Set(keys).size).toBe(keys.length);
		for (const key of keys) {
			expect(key).toContain("story-1");
		}
	});

	// The module contract is "never throws": notification dispatch must never
	// take down the sync activity that is reporting a failure — that would
	// turn a partial attachment failure into a failed push.
	it("never throws when the notification write fails", async () => {
		createMock.mockRejectedValue(new Error("db down"));

		await expect(
			createPmAttachmentSyncFailedNotification(baseArgs),
		).resolves.toBeUndefined();
	});

	it("never throws when recipient resolution fails", async () => {
		findUniqueMock.mockRejectedValue(new Error("db down"));

		await expect(
			createPmAttachmentSyncFailedNotification(baseArgs),
		).resolves.toBeUndefined();
	});
});
