import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	snapshotUpdateMany: vi.fn(),
	snapshotFindFirst: vi.fn(),
	memberFindMany: vi.fn(),
	orgMemberFindMany: vi.fn(),
	userFindUnique: vi.fn(),
	notificationCreate: vi.fn(),
	canRead: vi.fn(),
	enabled: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectInstructionSnapshot: {
			updateMany: mocks.snapshotUpdateMany,
			findFirst: mocks.snapshotFindFirst,
		},
		projectMember: { findMany: mocks.memberFindMany },
		member: { findMany: mocks.orgMemberFindMany },
		user: { findUnique: mocks.userFindUnique },
		notification: { create: mocks.notificationCreate },
	},
	NotificationCategory: { PROJECT: "PROJECT" },
	NotificationType: {
		CODING_INSTRUCTIONS_PUBLISHED: "CODING_INSTRUCTIONS_PUBLISHED",
	},
}));
vi.mock("../prisma/queries/projects/projects", () => ({
	canReadProjectInstructions: mocks.canRead,
}));
vi.mock("../prisma/queries/notification-preferences", () => ({
	getEnabledRecipientsForCategory: mocks.enabled,
}));

import { createInstructionPublishedNotifications } from "../prisma/queries/instruction-publish-notifications";

const args = {
	snapshotId: "snap",
	projectId: "proj",
	organizationId: "org",
	actorUserId: "actor",
	via: "manual" as const,
};

beforeEach(() => {
	for (const fn of Object.values(mocks)) {
		fn.mockReset();
	}
	mocks.snapshotUpdateMany.mockResolvedValue({ count: 1 });
	mocks.snapshotFindFirst.mockResolvedValue({
		version: 4,
		source: "UPLOAD",
		sourceRef: null,
		sourceCommitSha: null,
		project: { name: "Example project", userId: "owner" },
	});
	mocks.memberFindMany.mockResolvedValue([
		{ userId: "member" },
		{ userId: "actor" },
		{ userId: "guest-no-read" },
	]);
	mocks.orgMemberFindMany.mockResolvedValue([
		{ userId: "member" },
		{ userId: "actor" },
	]);
	mocks.userFindUnique.mockResolvedValue({ name: "Example Actor" });
	mocks.canRead.mockImplementation(
		async (_projectId: string, userId: string) =>
			userId !== "guest-no-read",
	);
	mocks.enabled.mockImplementation(async (ids: string[]) => new Set(ids));
	mocks.notificationCreate.mockImplementation(
		async ({ data }: { data: { userId: string } }) => ({
			id: `n-${data.userId}`,
			userId: data.userId,
		}),
	);
});

describe("createInstructionPublishedNotifications", () => {
	it("claims the snapshot, then tells readable members and the owner, never the actor", async () => {
		const rows = await createInstructionPublishedNotifications(args);

		expect(mocks.snapshotUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "snap",
				projectId: "proj",
				organizationId: "org",
				publishNotifiedAt: null,
			},
			data: { publishNotifiedAt: expect.any(Date) },
		});
		expect(rows.map((row) => row.userId).sort()).toEqual([
			"member",
			"owner",
		]);
		expect(mocks.memberFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "proj",
					acceptedAt: { not: null },
				}),
			}),
		);
		expect(mocks.enabled).toHaveBeenCalledWith(
			expect.arrayContaining(["owner", "member"]),
			"PROJECT",
		);
		const data = mocks.notificationCreate.mock.calls[0]![0].data;
		expect(data).toMatchObject({
			organizationId: "org",
			type: "CODING_INSTRUCTIONS_PUBLISHED",
			category: "PROJECT",
			title: "Coding instructions v4 published",
			link: "projects/proj?tab=coding-instructions",
			projectId: "proj",
			actorUserId: "actor",
			payload: {
				version: 4,
				source: "UPLOAD",
				via: "manual",
				publishedByName: "Example Actor",
				update: {
					kind: "cli_sync",
					command: "fabric instructions sync --project proj",
				},
			},
		});
		expect(data.dedupeKey).toMatch(/^instructionsPublished:snap:/);
		expect(data.snippet).toContain(
			"fabric instructions sync --project proj",
		);
	});

	it("never tells an organization member who is not on the project, even one whose organization role grants read", async () => {
		mocks.orgMemberFindMany.mockResolvedValue([
			{ userId: "org-reader" },
			{ userId: "member" },
		]);

		const rows = await createInstructionPublishedNotifications(args);

		expect(mocks.orgMemberFindMany).not.toHaveBeenCalled();
		expect(mocks.canRead).not.toHaveBeenCalledWith("proj", "org-reader");
		expect(rows.map((row) => row.userId).sort()).toEqual([
			"member",
			"owner",
		]);
	});

	it("announces nothing once the claim is taken: a retry, or a rollback to an announced version", async () => {
		mocks.snapshotUpdateMany.mockResolvedValue({ count: 0 });

		expect(await createInstructionPublishedNotifications(args)).toEqual([]);
		expect(mocks.notificationCreate).not.toHaveBeenCalled();
	});

	it("names the branch and short commit, and says to pull, for a repository version", async () => {
		mocks.snapshotFindFirst.mockResolvedValue({
			version: 7,
			source: "REPOSITORY",
			sourceRef: "main",
			sourceCommitSha: "0123456789abcdef",
			project: { name: "Example project", userId: "owner" },
		});

		await createInstructionPublishedNotifications({
			...args,
			via: "automatic",
		});

		const data = mocks.notificationCreate.mock.calls[0]![0].data;
		expect(data.payload).toMatchObject({
			source: "REPOSITORY",
			sourceRef: "main",
			shortCommitSha: "0123456",
			update: { kind: "git_pull", ref: "main" },
		});
		expect(data.snippet).toContain("repository sync from main at 0123456");
	});

	it("leaves out members who switched project notifications off", async () => {
		mocks.enabled.mockResolvedValue(new Set(["owner"]));

		const rows = await createInstructionPublishedNotifications(args);

		expect(rows.map((row) => row.userId)).toEqual(["owner"]);
	});

	it("never throws into the publish, whatever fails", async () => {
		mocks.memberFindMany.mockRejectedValue(new Error("database down"));
		const warn = vi
			.spyOn(console, "warn")
			.mockImplementation(() => undefined);

		await expect(
			createInstructionPublishedNotifications(args),
		).resolves.toEqual([]);
		warn.mockRestore();
	});
});
