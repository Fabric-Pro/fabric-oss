import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: { findMany: vi.fn(), deleteMany: vi.fn() },
	storyAttachment: { findMany: vi.fn() },
	$queryRaw: vi.fn(),
}));

// The SUT (prisma/queries/projects/stories.ts) imports `db` AND `Prisma` from
// "../../client", which resolves to packages/database/prisma/client. From THIS
// test file (packages/database/__tests__/) that same module is "../prisma/client"
// — vitest matches mocks by resolved path, so mock THAT specifier (matches existing
// DB tests). `Prisma.join` must be provided (the SUT calls it for the FOR UPDATE
// IN-list); a passthrough is fine since `$queryRaw` is a no-op stub here.
vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
	},
	Prisma: { join: (arr: unknown[]) => arr },
}));

import { clearProjectStories } from "../prisma/queries/projects/stories";

beforeEach(() => {
	tx.userStory.findMany.mockReset();
	tx.userStory.deleteMany.mockReset();
	tx.storyAttachment.findMany.mockReset();
	tx.$queryRaw.mockReset();
});

describe("clearProjectStories", () => {
	it("captures the pipeline subset's story IDs and deletes ONLY those IDs", async () => {
		tx.userStory.findMany.mockResolvedValue([{ id: "s1" }, { id: "s2" }]);
		tx.storyAttachment.findMany.mockResolvedValue([
			{ storageKey: "story-attachments/p/s1/a.png" },
			{ storageKey: "story-attachments/p/s2/b.png" },
		]);
		tx.userStory.deleteMany.mockResolvedValue({ count: 2 });

		const res = await clearProjectStories("p", true);

		// Story selection filtered to the pipeline subset
		expect(tx.userStory.findMany).toHaveBeenCalledWith({
			where: { projectId: "p", pipelineExecutionId: { not: null } },
			select: { id: true },
		});
		// Keys captured for exactly the captured story IDs
		expect(tx.storyAttachment.findMany).toHaveBeenCalledWith({
			where: { storyId: { in: ["s1", "s2"] } },
			select: { storageKey: true },
		});
		// Delete targets the captured IDs, NOT the broad project filter
		expect(tx.userStory.deleteMany).toHaveBeenCalledWith({
			where: { id: { in: ["s1", "s2"] } },
		});
		expect(res).toEqual({
			count: 2,
			attachmentKeys: [
				"story-attachments/p/s1/a.png",
				"story-attachments/p/s2/b.png",
			],
		});
	});

	it("early-returns without locking/deleting when no stories match", async () => {
		tx.userStory.findMany.mockResolvedValue([]);
		const res = await clearProjectStories("p", true);
		expect(tx.$queryRaw).not.toHaveBeenCalled();
		expect(tx.storyAttachment.findMany).not.toHaveBeenCalled();
		expect(tx.userStory.deleteMany).not.toHaveBeenCalled();
		expect(res).toEqual({ count: 0, attachmentKeys: [] });
	});

	it("locks the captured story rows FOR UPDATE before reading attachment keys", async () => {
		tx.userStory.findMany.mockResolvedValue([{ id: "s1" }]);
		tx.storyAttachment.findMany.mockResolvedValue([]);
		tx.userStory.deleteMany.mockResolvedValue({ count: 1 });
		await clearProjectStories("p", true);
		expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
		// Tagged-template first arg is the TemplateStringsArray; join it to inspect the SQL.
		const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join("?");
		expect(sql).toMatch(/user_story/i);
		expect(sql).toMatch(/FOR UPDATE/i);
		// The lock is taken BEFORE attachment capture (serializes vs create-attachment).
		expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			tx.storyAttachment.findMany.mock.invocationCallOrder[0],
		);
	});

	it("without clearPipelineOnly, selects all project stories", async () => {
		tx.userStory.findMany.mockResolvedValue([{ id: "s1" }]);
		tx.storyAttachment.findMany.mockResolvedValue([]);
		tx.userStory.deleteMany.mockResolvedValue({ count: 1 });
		await clearProjectStories("p");
		expect(tx.userStory.findMany).toHaveBeenCalledWith({
			where: { projectId: "p" },
			select: { id: true },
		});
	});
});
