import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findFirst: vi.fn() },
		storyAttachment: { updateMany: vi.fn(), findFirst: vi.fn() },
	},
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
import { removeAttachmentProcedure } from "../remove-attachment";

const handler = (removeAttachmentProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = { projectId: "p1", userStoryId: "s1", attachmentId: "a1" };

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.userStory.findFirst).mockResolvedValue({ id: "s1" } as never);
	vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
		count: 1,
	} as never);
});

describe("removeAttachment", () => {
	it("is gated on STORY_UPDATE", () => {
		expect(
			(removeAttachmentProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("story:update");
	});

	it("NOT_FOUND when the attachment does not exist", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue(null);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(vi.mocked(db.storyAttachment.updateMany)).not.toHaveBeenCalled();
	});

	it("soft-deletes (sets deletedAt) and returns removed:true", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			designation: "UNLOCKED",
		} as never);
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);

		const res = await handler({ input, context: ctx });

		expect(res).toEqual({ removed: true });
		expect(vi.mocked(db.storyAttachment.updateMany)).toHaveBeenCalledWith({
			where: {
				id: "a1",
				story: { id: "s1", projectId: "p1" },
				designation: "UNLOCKED",
				deletedAt: null,
			},
			data: { deletedAt: expect.any(Date) },
		});
	});

	it("FORBIDDEN when the row is an un-promoted PM_SYNCED inbound file (AI-isolation invariant)", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			source: "PM_SYNCED",
			promotedAt: null,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		expect(vi.mocked(db.storyAttachment.updateMany)).not.toHaveBeenCalled();
	});

	it("succeeds for a promoted PM_SYNCED row", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			source: "PM_SYNCED",
			promotedAt: new Date(5),
			designation: "UNLOCKED",
		} as never);
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res).toEqual({ removed: true });
	});

	it("succeeds for a FABRIC-origin row", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			source: "FABRIC",
			promotedAt: null,
			designation: "UNLOCKED",
		} as never);
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 1,
		} as never);
		const res = await handler({ input, context: ctx });
		expect(res).toEqual({ removed: true });
	});

	it("BAD_REQUEST (locked) when the attachment is LOCKED — no soft-delete object touch", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			designation: "LOCKED",
		} as never);
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("NOT_FOUND (concurrent delete) when UNLOCKED at read but the row is gone on re-read", async () => {
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({
				id: "a1",
				designation: "UNLOCKED",
			} as never) // IDOR read
			.mockResolvedValueOnce(null as never); // count===0 live re-read: concurrently soft-deleted
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("BAD_REQUEST when the row is LOCKED on re-read (concurrent lock after an UNLOCKED read)", async () => {
		// The IDOR snapshot reads UNLOCKED, then a concurrent lock lands before the
		// update → updateMany count 0; the live re-read must classify this as LOCKED,
		// not NOT_FOUND (the file still exists).
		vi.mocked(db.storyAttachment.findFirst)
			.mockResolvedValueOnce({
				id: "a1",
				designation: "UNLOCKED",
			} as never) // IDOR read
			.mockResolvedValueOnce({
				id: "a1",
				designation: "LOCKED",
			} as never); // re-read: now locked
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("already soft-deleted reads as NOT_FOUND (idempotent double-remove)", async () => {
		// IDOR read filters deletedAt:null → already-removed row invisible → null.
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue(
			null as never,
		);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(vi.mocked(db.storyAttachment.updateMany)).not.toHaveBeenCalled();
	});
});
