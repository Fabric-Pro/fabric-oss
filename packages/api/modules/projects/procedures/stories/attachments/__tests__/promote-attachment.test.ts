import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
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
import { promoteAttachmentProcedure } from "../promote-attachment";

const handler = (promoteAttachmentProcedure as unknown as { handler: Function })
	.handler;
const ctx = { user: { id: "u1" }, session: {} };
const input = {
	projectId: "p1",
	userStoryId: "s1",
	attachmentId: "a1",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
		count: 1,
	} as never);
	vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
		id: "a1",
		filename: "brief.pdf",
		promotedAt: new Date(5),
		source: "PM_SYNCED",
		sourceTool: "jira",
	} as never);
});

describe("promoteAttachment (Fizzy #1746)", () => {
	it("is gated on STORY_UPDATE", () => {
		expect(
			(promoteAttachmentProcedure as unknown as { __permission: string })
				.__permission,
		).toBe("story:update");
	});

	it("stamps promotedAt on an inbound row scoped to the story and project", async () => {
		const result = await handler({ input, context: ctx });

		const where = vi.mocked(db.storyAttachment.updateMany).mock.calls[0][0]
			.where;
		expect(where).toMatchObject({
			id: "a1",
			story: { id: "s1", projectId: "p1" },
			deletedAt: null,
			source: "PM_SYNCED",
			promotedAt: null,
		});
		expect(result.attachment.promotedAt).toEqual(new Date(5));
	});

	it("retains sourceTool so the origin tooltip survives promotion", async () => {
		const result = await handler({ input, context: ctx });
		expect(result.attachment.sourceTool).toBe("jira");
	});

	it("throws NOT_FOUND when nothing matched and the row genuinely does not exist", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue(
			null as never,
		);
		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/not found/i,
		);
	});

	it("is idempotent: an already-promoted row succeeds and is returned unchanged", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			filename: "brief.pdf",
			promotedAt: new Date(5),
			source: "PM_SYNCED",
			sourceTool: "jira",
		} as never);
		const result = await handler({ input, context: ctx });
		expect(result).toEqual({
			attachment: {
				id: "a1",
				filename: "brief.pdf",
				promotedAt: new Date(5),
				source: "PM_SYNCED",
				sourceTool: "jira",
			},
		});
	});

	it("throws BAD_REQUEST for a Fabric-origin row — never inbound, nothing to promote", async () => {
		vi.mocked(db.storyAttachment.updateMany).mockResolvedValue({
			count: 0,
		} as never);
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue({
			id: "a1",
			filename: "brief.pdf",
			promotedAt: null,
			source: "FABRIC",
			sourceTool: null,
		} as never);
		await expect(handler({ input, context: ctx })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	it("throws NOT_FOUND when a concurrent delete wins the race with the post-update re-read", async () => {
		vi.mocked(db.storyAttachment.findFirst).mockResolvedValue(
			null as never,
		);
		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/not found/i,
		);
	});

	it("scopes the update to story + project only — no organization predicate, even with a foreign organizationId", async () => {
		const result = await handler({
			input: { ...input, organizationId: "org-attacker" },
			context: ctx,
		});
		expect(result.attachment).toBeDefined();
		const where = vi.mocked(db.storyAttachment.updateMany).mock.calls[0][0]
			.where;
		expect(where).toEqual({
			id: "a1",
			story: { id: "s1", projectId: "p1" },
			deletedAt: null,
			source: "PM_SYNCED",
			promotedAt: null,
		});
		expect(JSON.stringify(where)).not.toContain("organizationId");
	});
});
