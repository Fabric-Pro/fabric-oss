import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { storyAttachment: { updateMany: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("../../../../../../orpc/procedures", () => {
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
		Permissions: { STORY_UPDATE: "story:update", STORY_READ: "story:read" },
	};
});

import { db } from "@repo/database";
import { setAttachmentDesignationProcedure } from "../set-attachment-designation";

const handler = (
	setAttachmentDesignationProcedure as unknown as { handler: Function }
).handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = {
	projectId: "p1",
	userStoryId: "s1",
	attachmentId: "a1",
	designation: "UNLOCKED" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
});

describe("setAttachmentDesignation", () => {
	it("is gated on STORY_UPDATE", () => {
		expect(
			(
				setAttachmentDesignationProcedure as unknown as {
					__permission: string;
				}
			).__permission,
		).toBe("story:update");
	});

	it("NOT_FOUND when the attachment is not in the story/project", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue(null);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(vi.mocked(db.storyAttachment.updateMany)).not.toHaveBeenCalled();
	});

	it("FORBIDDEN when the row is an un-promoted PM_SYNCED inbound file (AI-isolation invariant)", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			source: "PM_SYNCED",
			promotedAt: null,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(vi.mocked(db.storyAttachment.updateMany)).not.toHaveBeenCalled();
	});

	it("succeeds for a promoted PM_SYNCED row", async () => {
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({
				source: "PM_SYNCED",
				promotedAt: new Date(5),
			} as never) // pre-update guard read
			.mockResolvedValueOnce({
				id: "a1",
				designation: "UNLOCKED",
			} as never); // post-update read
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachment.designation).toBe("UNLOCKED");
	});

	it("succeeds for a FABRIC-origin row", async () => {
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({
				source: "FABRIC",
				promotedAt: null,
			} as never) // pre-update guard read
			.mockResolvedValueOnce({
				id: "a1",
				designation: "UNLOCKED",
			} as never); // post-update read
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachment.designation).toBe("UNLOCKED");
	});

	it("updates the designation and returns the row", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			designation: "UNLOCKED",
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res.attachment.designation).toBe("UNLOCKED");
	});

	it("NOT_FOUND when updateMany succeeds but re-read returns null (concurrent delete race)", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({ id: "a1", designation: "LOCKED" } as never) // pre-update guard read
			.mockResolvedValueOnce(null); // post-update read
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("returns NOT_FOUND if the attachment was soft-deleted between the update and the post-update read", async () => {
		// updateMany succeeds (count 1) on a live row, but the post-update findFirst
		// returns null because a concurrent removeAttachment soft-deleted it.
		// Assert: the post-update findFirst was called with deletedAt: null in its where,
		// and the procedure throws NOT_FOUND.
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({ id: "a1", designation: "LOCKED" } as never) // pre-update guard read
			.mockResolvedValueOnce(null); // post-update read
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(
			vi.mocked(db.storyAttachment.findFirst),
		).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ deletedAt: null }),
			}),
		);
	});

	it("scopes the designation updateMany to live rows (deletedAt:null guard predicate)", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			designation: "LOCKED",
		} as never);
		await handler({ input: { ...input, designation: "LOCKED" as const } });
		expect(vi.mocked(db.storyAttachment.updateMany)).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ deletedAt: null }),
			}),
		);
	});
});
