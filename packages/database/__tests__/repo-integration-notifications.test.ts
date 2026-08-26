/**
 * Tests for createRepoIntegrationCredentialNotification's recipient fan-out.
 *
 * The notification now reaches the connecting user PLUS the project's
 * owners/admins, one deduped row per recipient. Mocks the Prisma client and the
 * notification-preference helpers so the fan-out logic is exercised in
 * isolation.
 *
 * Run with: pnpm --filter @repo/database test __tests__/repo-integration-notifications.test.ts
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
		REPO_INTEGRATION_TOKEN_EXPIRED: "REPO_INTEGRATION_TOKEN_EXPIRED",
	},
	ProjectMemberRole: { OWNER: "OWNER", PROJECT_ADMIN: "PROJECT_ADMIN" },
}));

vi.mock("../prisma/queries/notification-preferences", () => ({
	getEnabledRecipientsForCategory: enabledMock,
}));

import { createRepoIntegrationCredentialNotification } from "../prisma/queries/repo-integration-notifications";

const baseArgs = {
	recipientUserId: "configurer-1",
	organizationId: "org-1",
	integrationId: "int-1",
	projectId: "proj-1",
	projectName: "Proj",
	provider: "GITHUB",
	repositoryOwner: "Owner",
	repositoryName: "repo",
	status: "TOKEN_EXPIRED" as const,
	link: "projects/proj-1?tab=settings",
};

const recipientsOf = () =>
	createMock.mock.calls.map((c) => c[0].data.userId).sort();

describe("createRepoIntegrationCredentialNotification fan-out", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Default: every resolved recipient is enabled for the PROJECT category.
		enabledMock.mockImplementation((ids: string[]) =>
			Promise.resolve(new Set(ids)),
		);
		createMock.mockResolvedValue({});
	});

	it("fans out to the configurer plus project owners/admins, one row each (AE5)", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [{ userId: "admin-1" }],
		});

		await createRepoIntegrationCredentialNotification(baseArgs);

		expect(createMock).toHaveBeenCalledTimes(3);
		expect(recipientsOf()).toEqual([
			"admin-1",
			"configurer-1",
			"owner-creator",
		]);
	});

	it("dedupes a configurer who is also the project owner to a single row", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [{ userId: "owner-creator" }],
		});

		await createRepoIntegrationCredentialNotification({
			...baseArgs,
			recipientUserId: "owner-creator",
		});

		expect(createMock).toHaveBeenCalledTimes(1);
		expect(recipientsOf()).toEqual(["owner-creator"]);
	});

	it("uses a per-recipient, per-status dedupe key so the fan-out does not self-collide", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [],
		});

		await createRepoIntegrationCredentialNotification(baseArgs);

		const dedupeKeys = createMock.mock.calls
			.map((c) => c[0].data.dedupeKey)
			.sort();
		expect(dedupeKeys).toEqual([
			"repoIntegrationExpired:int-1:TOKEN_EXPIRED:configurer-1",
			"repoIntegrationExpired:int-1:TOKEN_EXPIRED:owner-creator",
		]);
	});

	it("a status change produces a fresh dedupe key, so the new remedy is not suppressed by an unread old row", async () => {
		findUniqueMock.mockResolvedValue({ userId: null, members: [] });

		await createRepoIntegrationCredentialNotification({
			...baseArgs,
			status: "REPO_UNAVAILABLE",
		});

		expect(createMock.mock.calls[0][0].data.dedupeKey).toBe(
			"repoIntegrationExpired:int-1:REPO_UNAVAILABLE:configurer-1",
		);
	});

	it("skips a recipient who disabled the PROJECT notification category", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [{ userId: "admin-1" }],
		});
		enabledMock.mockImplementation((ids: string[]) =>
			Promise.resolve(new Set(ids.filter((id) => id !== "admin-1"))),
		);

		await createRepoIntegrationCredentialNotification(baseArgs);

		expect(recipientsOf()).toEqual(["configurer-1", "owner-creator"]);
	});

	it("writes nothing when every recipient disabled the PROJECT category", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [],
		});
		enabledMock.mockResolvedValue(new Set<string>());

		await createRepoIntegrationCredentialNotification(baseArgs);

		expect(createMock).not.toHaveBeenCalled();
	});

	it("swallows a P2002 dedupe collision without throwing", async () => {
		findUniqueMock.mockResolvedValue({
			userId: "owner-creator",
			members: [],
		});
		createMock.mockRejectedValue({ code: "P2002" });

		await expect(
			createRepoIntegrationCredentialNotification(baseArgs),
		).resolves.toBeUndefined();
	});
});
