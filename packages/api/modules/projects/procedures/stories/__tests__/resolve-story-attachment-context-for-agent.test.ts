/**
 * This procedure returns document text to a chat surface, so its authorization
 * is the whole point of the file. Each of the three layers gets its own test
 * because each closes a different hole, and the third one — the org-context
 * check — exists to close a gap `hasProjectAccess` does not: it ignores its
 * organizationId argument, so a user who belongs to two orgs could otherwise
 * chat under one and read attachment text from the other.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: { project: { findUnique: vi.fn() } },
	getStoryById: vi.fn(),
	hasProjectAccess: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../../../lib/story-attachment-ai-context", () => ({
	resolveStoryAttachmentAiContexts: vi.fn(),
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => () => chain,
		requireInputOrgPermission: () => () => chain,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
		Permissions: { STORY_UPDATE: "story:update" },
	};
});

import { db, getStoryById, hasProjectAccess } from "@repo/database";
import { resolveStoryAttachmentAiContexts } from "../../../lib/story-attachment-ai-context";
import { resolveStoryAttachmentContextForAgentProcedure } from "../resolve-story-attachment-context-for-agent";

const handler = (
	resolveStoryAttachmentContextForAgentProcedure as unknown as {
		handler: (args: unknown) => Promise<{ contexts: string[] }>;
	}
).handler;

const access = hasProjectAccess as unknown as ReturnType<typeof vi.fn>;
const storyById = getStoryById as unknown as ReturnType<typeof vi.fn>;
const projectFindUnique = db.project.findUnique as unknown as ReturnType<
	typeof vi.fn
>;
const resolve = resolveStoryAttachmentAiContexts as unknown as ReturnType<
	typeof vi.fn
>;

const ctx = {
	user: { id: "u1" },
	session: { id: "s1", activeOrganizationId: null },
};
const input = {
	projectId: "p1",
	userStoryId: "story-1",
	organizationId: null,
};

beforeEach(() => {
	vi.clearAllMocks();
	access.mockResolvedValue(true);
	storyById.mockResolvedValue({ id: "story-1", title: "A story" });
	projectFindUnique.mockResolvedValue({ organizationId: null });
	resolve.mockResolvedValue(["<attachment>spec body</attachment>"]);
});

describe("resolveStoryAttachmentContextForAgentProcedure", () => {
	it("returns the resolver's entries for an authorized member", async () => {
		const result = await handler({ input, context: ctx });

		expect(result.contexts).toEqual(["<attachment>spec body</attachment>"]);
		expect(resolve).toHaveBeenCalledWith(
			"story-1",
			expect.objectContaining({ userId: "u1", organizationId: null }),
		);
	});

	it("rejects a caller without project access", async () => {
		access.mockResolvedValue(false);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/access to this project/i,
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects a story that does not belong to the project", async () => {
		storyById.mockResolvedValue(null);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/not found/i,
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects a project from a different organization", async () => {
		// hasProjectAccess passes here on purpose — this is exactly the gap the
		// third layer closes.
		projectFindUnique.mockResolvedValue({ organizationId: "org-A" });

		await expect(
			handler({
				input: { ...input, organizationId: "org-B" },
				context: ctx,
			}),
		).rejects.toThrow(/access to this project/i);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("rejects when the project row is missing entirely", async () => {
		projectFindUnique.mockResolvedValue(null);

		await expect(handler({ input, context: ctx })).rejects.toThrow(
			/access to this project/i,
		);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("returns an empty list rather than erroring when nothing is eligible", async () => {
		// Protected-only, image-only, and no-attachment stories all land here.
		// The client merges this into ragContexts, so an error would break a
		// chat turn over a story that simply has nothing to contribute.
		resolve.mockResolvedValue([]);

		await expect(handler({ input, context: ctx })).resolves.toEqual({
			contexts: [],
		});
	});

	it("passes the resolved org through to the resolver", async () => {
		projectFindUnique.mockResolvedValue({ organizationId: "org-A" });

		await handler({
			input: { ...input, organizationId: "org-A" },
			context: ctx,
		});

		expect(resolve).toHaveBeenCalledWith(
			"story-1",
			expect.objectContaining({ organizationId: "org-A" }),
		);
	});
});
