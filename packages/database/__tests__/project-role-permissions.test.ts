import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	project: {
		findFirst: vi.fn(),
		findUnique: vi.fn(),
		update: vi.fn(),
		findMany: vi.fn(),
		delete: vi.fn(),
	},
	$transaction: vi.fn(),
	member: { findFirst: vi.fn() },
	projectMember: { findFirst: vi.fn(), findUnique: vi.fn() },
}));

vi.mock("../prisma/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("../prisma/client")>()),
	db: mocks,
}));

import { Prisma } from "../prisma/client";
import {
	canCreateArchitectureDecisions,
	canEditProjectSettings,
	canReadProjectInstructions,
	canUpdateProjectStory,
	getProjectMemberRole,
	getProjectRole,
	getProjectsNeedingDeletionReminder,
	getProjectsReadyForPermanentDeletion,
	markDeletionReminderSent,
	permanentDeleteProject,
	restoreProject,
	softDeleteProject,
} from "../prisma/queries/projects/projects";

const projectId = "example-project";
const userId = "example-user";
const organizationId = "example-org";
const project = { userId: "example-owner", organizationId };
const now = new Date("2026-01-10T00:00:00Z");

beforeEach(() => {
	vi.resetAllMocks();
	mocks.project.findFirst.mockResolvedValue(project);
	mocks.project.findUnique.mockResolvedValue(project);
	mocks.projectMember.findFirst.mockResolvedValue(null);
	mocks.projectMember.findUnique.mockResolvedValue(null);
	mocks.member.findFirst.mockResolvedValue(null);
});

describe.each([
	{ read: getProjectRole, owner: "owner", editor: "editor" },
	{ read: getProjectMemberRole, owner: "OWNER", editor: "EDITOR" },
])("$read.name", ({ read, owner, editor }) => {
	it("returns null for a missing project", async () => {
		mocks.project.findFirst.mockResolvedValue(null);
		await expect(read(projectId, userId)).resolves.toBeNull();
		expect(mocks.project.findFirst).toHaveBeenCalledWith({
			where: { id: projectId },
			select: { userId: true, organizationId: true },
		});
		expect(mocks.member.findFirst).not.toHaveBeenCalled();
	});

	it("does not display stale project standing without host membership", async () => {
		mocks.project.findFirst.mockResolvedValue({ ...project, userId });
		await expect(read(projectId, userId)).resolves.toBeNull();
		expect(mocks.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId, userId },
			select: { id: true },
		});
		expect(mocks.projectMember.findFirst).not.toHaveBeenCalled();
	});

	it.each([null, organizationId])(
		"returns the owner's role for tenant %s",
		async (org) => {
			mocks.project.findFirst.mockResolvedValue({
				userId,
				organizationId: org,
			});
			mocks.member.findFirst.mockResolvedValue({
				id: "example-membership",
			});
			await expect(read(projectId, userId)).resolves.toBe(owner);
			expect(mocks.member.findFirst).toHaveBeenCalledTimes(org ? 1 : 0);
			expect(mocks.projectMember.findFirst).not.toHaveBeenCalled();
		},
	);

	it.each([null, organizationId])(
		"returns only the accepted, unexpired project role for tenant %s",
		async (org) => {
			mocks.project.findFirst.mockResolvedValue({
				...project,
				organizationId: org,
			});
			mocks.member.findFirst.mockResolvedValue({
				id: "example-membership",
			});
			mocks.projectMember.findFirst.mockResolvedValueOnce({
				role: "EDITOR",
			});
			await expect(read(projectId, userId)).resolves.toBe(editor);
			await expect(read(projectId, userId)).resolves.toBeNull();
			expect(mocks.projectMember.findFirst).toHaveBeenCalledWith({
				where: {
					projectId,
					userId,
					acceptedAt: { not: null },
					OR: [
						{ expiresAt: null },
						{ expiresAt: { gt: expect.any(Date) } },
					],
				},
				select: { role: true },
			});
		},
	);
});

describe.each([
	{
		check: canEditProjectSettings,
		editorAllowed: false,
		viewerAllowed: false,
	},
	{
		check: canReadProjectInstructions,
		editorAllowed: true,
		viewerAllowed: true,
	},
	{
		check: canCreateArchitectureDecisions,
		editorAllowed: true,
		viewerAllowed: false,
	},
	{ check: canUpdateProjectStory, editorAllowed: true, viewerAllowed: false },
])("$check.name", ({ check, editorAllowed, viewerAllowed }) => {
	it.each(["PROJECT_ADMIN", "EDITOR", "VIEWER"] as const)(
		"applies the invited %s role only on its project",
		async (role) => {
			mocks.projectMember.findUnique.mockResolvedValueOnce({
				role,
				acceptedAt: now,
				expiresAt: null,
			});
			const allowed =
				role === "PROJECT_ADMIN" ||
				(role === "EDITOR" ? editorAllowed : viewerAllowed);
			await expect(check(projectId, userId)).resolves.toBe(allowed);
			expect(mocks.member.findFirst).not.toHaveBeenCalled();
			await expect(check("other-project", userId)).resolves.toBe(false);
			expect(mocks.projectMember.findUnique).toHaveBeenNthCalledWith(1, {
				where: { projectId_userId: { projectId, userId } },
				select: { role: true, acceptedAt: true, expiresAt: true },
			});
			expect(mocks.projectMember.findUnique).toHaveBeenNthCalledWith(2, {
				where: {
					projectId_userId: { projectId: "other-project", userId },
				},
				select: { role: true, acceptedAt: true, expiresAt: true },
			});
		},
	);

	it("denies an organization admin on a project outside their reach", async () => {
		mocks.member.findFirst.mockResolvedValue({ role: "admin" });
		await expect(check(projectId, userId)).resolves.toBe(false);
		expect(mocks.member.findFirst).toHaveBeenCalledWith({
			where: { organizationId, userId },
			select: { role: true },
		});
	});
});

describe("project deletion and reminder queries", () => {
	beforeEach(() => vi.useFakeTimers({ now }));
	afterEach(() => vi.useRealTimers());

	const ownership = [
		{ userId },
		{
			members: {
				some: {
					userId,
					role: "OWNER",
					acceptedAt: { not: null },
					OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
				},
			},
		},
	];

	it.each([organizationId, undefined])(
		"scopes soft deletion and schedules a seven-day grace period for %s",
		async (org) => {
			const missing = new Prisma.PrismaClientKnownRequestError(
				"No matching project",
				{ code: "P2025", clientVersion: "example" },
			);
			mocks.project.update.mockRejectedValue(missing);
			await expect(
				softDeleteProject(projectId, userId, org),
			).rejects.toMatchObject({ code: "P2025" });
			expect(mocks.project.update).toHaveBeenCalledExactlyOnceWith({
				where: {
					id: projectId,
					organizationId: org ?? null,
					OR: ownership,
				},
				data: {
					deletedAt: now,
					deletedBy: userId,
					scheduledPermanentDeleteAt: new Date(
						"2026-01-17T00:00:00Z",
					),
				},
			});
		},
	);

	it("restores only a deleted project in the selected organization and clears the reminder", async () => {
		mocks.project.update.mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError(
				"No matching deleted project",
				{ code: "P2025", clientVersion: "example" },
			),
		);
		await expect(
			restoreProject(projectId, userId, organizationId),
		).rejects.toMatchObject({ code: "P2025" });
		expect(mocks.project.update).toHaveBeenCalledExactlyOnceWith({
			where: {
				id: projectId,
				organizationId,
				deletedAt: { not: null },
				OR: ownership,
			},
			data: {
				deletedAt: null,
				deletedBy: null,
				scheduledPermanentDeleteAt: null,
				deletionReminderSentAt: null,
			},
		});
	});

	it("guards the transactional hard delete against a concurrent restore", async () => {
		mocks.$transaction.mockImplementation(async (callback) =>
			callback(mocks),
		);
		mocks.project.findFirst.mockResolvedValue(null);
		mocks.project.delete.mockRejectedValue(
			new Prisma.PrismaClientKnownRequestError(
				"Project already restored",
				{ code: "P2025", clientVersion: "example" },
			),
		);
		await expect(permanentDeleteProject(projectId)).rejects.toMatchObject({
			code: "P2025",
		});
		const where = { id: projectId, deletedAt: { not: null } };
		expect(mocks.$transaction).toHaveBeenCalledOnce();
		expect(mocks.project.findFirst).toHaveBeenCalledExactlyOnceWith({
			where,
			select: { organizationId: true },
		});
		expect(mocks.project.delete).toHaveBeenCalledExactlyOnceWith({ where });
	});

	it("lists only due soft-deleted projects, oldest deadline first", async () => {
		const selected = {
			id: projectId,
			name: "Example Project",
			userId,
			organizationId,
		};
		mocks.project.findMany.mockResolvedValue([selected]);
		await expect(getProjectsReadyForPermanentDeletion(4)).resolves.toEqual([
			selected,
		]);
		expect(mocks.project.findMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				deletedAt: { not: null },
				scheduledPermanentDeleteAt: { lte: now },
			},
			select: {
				id: true,
				name: true,
				userId: true,
				organizationId: true,
			},
			take: 4,
			orderBy: { scheduledPermanentDeleteAt: "asc" },
		});
	});

	it("lists only unsent reminders for deletions due in the next 24 to 48 hours", async () => {
		const selected = {
			id: projectId,
			name: "Example Project",
			userId,
			organizationId,
			scheduledPermanentDeleteAt: new Date("2026-01-11T12:00:00Z"),
			user: { email: "user@example.com", name: "Example User" },
		};
		mocks.project.findMany.mockResolvedValue([selected]);
		await expect(getProjectsNeedingDeletionReminder(4)).resolves.toEqual([
			selected,
		]);
		expect(mocks.project.findMany).toHaveBeenCalledExactlyOnceWith({
			where: {
				deletedAt: { not: null },
				scheduledPermanentDeleteAt: {
					gt: new Date("2026-01-11T00:00:00Z"),
					lte: new Date("2026-01-12T00:00:00Z"),
				},
				deletionReminderSentAt: null,
			},
			select: {
				id: true,
				name: true,
				userId: true,
				organizationId: true,
				scheduledPermanentDeleteAt: true,
				user: { select: { email: true, name: true } },
			},
			take: 4,
			orderBy: { scheduledPermanentDeleteAt: "asc" },
		});
	});

	it("timestamps the sent reminder for just the specified project", async () => {
		await markDeletionReminderSent(projectId);
		expect(mocks.project.update).toHaveBeenCalledExactlyOnceWith({
			where: { id: projectId },
			data: { deletionReminderSentAt: now },
		});
	});
});
