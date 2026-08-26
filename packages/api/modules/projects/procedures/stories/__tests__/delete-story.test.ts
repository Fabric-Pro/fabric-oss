import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findFirst: vi.fn() },
		storyAttachment: { findMany: vi.fn() },
	},
	deleteStory: vi.fn(),
}));
vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { projectContexts: "project-contexts" } },
	},
}));
vi.mock("@repo/storage", () => ({ getStorageProvider: vi.fn() }));
vi.mock("../../../../lib/audit", () => ({ recordAuditFromRequest: vi.fn() }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		resolveOrganizationId: (orgId: unknown) => orgId ?? null,
		Permissions: { STORY_DELETE: "story:delete" },
	};
});

import { db, deleteStory } from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import { deleteStoryProcedure } from "../delete-story";

const handler = (deleteStoryProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = { projectId: "p1", storyId: "s1", organizationId: null };
let deleteFile: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue({
		title: "My Story",
	} as never);
	vi.mocked(db.storyAttachment.findMany).mockResolvedValue([]);
	vi.mocked(deleteStory).mockResolvedValue(undefined as never);
	deleteFile = vi.fn().mockResolvedValue(undefined);
	vi.mocked(getStorageProvider).mockReturnValue({ deleteFile } as never);
});

describe("deleteStoryProcedure", () => {
	it("is gated on STORY_DELETE", () => {
		expect(
			(deleteStoryProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("story:delete");
	});

	it("calls deleteStory and returns { success: true }", async () => {
		const res = await handler({ input, context: ctx });
		expect(deleteStory).toHaveBeenCalledWith("s1", "p1");
		expect(res).toEqual({ success: true });
	});

	it("deletes R2 objects for all attachment keys when attachments exist", async () => {
		vi.mocked(db.storyAttachment.findMany).mockResolvedValue([
			{ storageKey: "story-attachments/p1/s1/file1.pdf" },
			{ storageKey: "story-attachments/p1/s1/file2.png" },
		] as never);

		const res = await handler({ input, context: ctx });

		expect(res).toEqual({ success: true });
		expect(deleteFile).toHaveBeenCalledTimes(2);
		expect(deleteFile).toHaveBeenCalledWith(
			"story-attachments/p1/s1/file1.pdf",
			{
				bucket: "project-contexts",
			},
		);
		expect(deleteFile).toHaveBeenCalledWith(
			"story-attachments/p1/s1/file2.png",
			{
				bucket: "project-contexts",
			},
		);
	});

	it("still returns { success: true } when a deleteFile call rejects (orphan tolerated)", async () => {
		vi.mocked(db.storyAttachment.findMany).mockResolvedValue([
			{ storageKey: "story-attachments/p1/s1/file1.pdf" },
			{ storageKey: "story-attachments/p1/s1/file2.png" },
		] as never);
		deleteFile.mockRejectedValue(new Error("R2 unavailable"));

		const res = await handler({ input, context: ctx });

		expect(res).toEqual({ success: true });
	});

	it("does not call getStorageProvider when there are no attachments", async () => {
		vi.mocked(db.storyAttachment.findMany).mockResolvedValue([]);

		await handler({ input, context: ctx });

		expect(getStorageProvider).not.toHaveBeenCalled();
		expect(deleteFile).not.toHaveBeenCalled();
	});

	it("captures attachment keys BEFORE deleteStory is called", async () => {
		const callOrder: string[] = [];
		vi.mocked(db.storyAttachment.findMany).mockImplementation(async () => {
			callOrder.push("findMany");
			return [];
		});
		vi.mocked(deleteStory).mockImplementation(async () => {
			callOrder.push("deleteStory");
		});

		await handler({ input, context: ctx });

		expect(callOrder.indexOf("findMany")).toBeLessThan(
			callOrder.indexOf("deleteStory"),
		);
	});

	it("captures ALL attachment keys with NO deletedAt filter (#1702 Part 5 — pending-purge objects must be cleaned on story delete)", async () => {
		// Binding constraint: the capture must NOT narrow by deletedAt, so a
		// story's soft-deleted (pending retention purge) attachment objects are still
		// reclaimed when the story is hard-deleted. An exact where-match here fails if a
		// future change adds `deletedAt: null`, which would orphan those objects.
		await handler({ input, context: ctx });

		expect(db.storyAttachment.findMany).toHaveBeenCalledWith({
			where: { storyId: "s1" },
			select: { storageKey: true },
		});
	});
});
