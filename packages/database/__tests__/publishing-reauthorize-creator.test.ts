/**
 * Re-authorizing a publishing recipient on an organization project admits an
 * organization member with no project row only when they created the project.
 * The cycle's tenant carries a null userId there, so the creator must come from
 * the project row itself.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	projectMemberFindUnique: vi.fn(),
	memberFindFirst: vi.fn(),
}));
vi.mock("../prisma/client", async (original) => ({
	...(await original<typeof import("../prisma/client")>()),
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectMember: { findUnique: mocks.projectMemberFindUnique },
		member: { findFirst: mocks.memberFindFirst },
	},
}));
vi.mock("../prisma/queries/notification-preferences", () => ({
	getEnabledRecipientsForCategory: async (ids: string[]) => new Set(ids),
	getRecipientsWithEmailFlagEnabled: async (ids: string[]) => new Set(ids),
}));

import { reauthorizePublishingRecipient } from "../prisma/queries/projects/publishing-recipients";

const ORG_ID = "org-example";

function reauthorize(recipientUserId: string) {
	return reauthorizePublishingRecipient({
		projectId: "project-example",
		recipientUserId,
		cycleTenant: { organizationId: ORG_ID, userId: null },
		channel: "IN_APP",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		organizationId: ORG_ID,
		userId: "user-creator",
		status: "ACTIVE",
		deletedAt: null,
	});
	mocks.projectMemberFindUnique.mockResolvedValue(null);
});

describe("reauthorizePublishingRecipient — the org-role path", () => {
	it("admits the project's creator with no project row", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			userId: "user-creator",
			role: "member",
		});

		await expect(reauthorize("user-creator")).resolves.toBe("OK");
	});

	it("refuses an org admin with no project row who did not create the project", async () => {
		mocks.memberFindFirst.mockResolvedValue({
			userId: "user-admin",
			role: "admin",
		});

		await expect(reauthorize("user-admin")).resolves.toBe(
			"RECIPIENT_UNAUTHORIZED",
		);
	});

	it("still admits an org member with an active Editor row", async () => {
		mocks.projectMemberFindUnique.mockResolvedValue({
			userId: "user-editor",
			role: "EDITOR",
			acceptedAt: new Date("2026-01-01T00:00:00.000Z"),
			expiresAt: null,
		});
		mocks.memberFindFirst.mockResolvedValue({
			userId: "user-editor",
			role: "member",
		});

		await expect(reauthorize("user-editor")).resolves.toBe("OK");
	});
});
