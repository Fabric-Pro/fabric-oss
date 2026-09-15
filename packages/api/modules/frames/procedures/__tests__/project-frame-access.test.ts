/**
 * Project-scoped frames (plan Slice 3): a spike demo frame is readable by
 * any member of its project, not only its creator, and by nobody else.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/project-frame-access.test.ts
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockGetFrameById,
	mockGetProjectFrameById,
	mockHasProjectAccess,
	mockListFramesForStory,
} = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	return {
		handlers,
		mockGetFrameById: vi.fn(),
		mockGetProjectFrameById: vi.fn(),
		mockHasProjectAccess: vi.fn(),
		mockListFramesForStory: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	getFrameById: mockGetFrameById,
	getProjectFrameById: mockGetProjectFrameById,
	hasProjectAccess: mockHasProjectAccess,
	listFramesForStory: mockListFramesForStory,
}));

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import "../get";
import "../list-for-story";

const now = new Date("2026-09-14T00:00:00Z");
const projectFrame = {
	id: "frame-1",
	userId: "creator-1",
	organizationId: "org-1",
	projectId: "proj-1",
	storyId: "story-1",
	title: "Spike: F-001 — demo",
	createdAt: now,
	updatedAt: now,
};

const get = (userId: string) =>
	handlers["/frames/{id}"]({
		input: { id: "frame-1", organizationId: "org-1" },
		context: { user: { id: userId }, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
	// The caller is not the creator: the personal lookup finds nothing.
	mockGetFrameById.mockResolvedValue(null);
	mockGetProjectFrameById.mockResolvedValue(projectFrame);
});

describe("frames.get — project frames", () => {
	it("returns a project frame to a project member who is not the creator", async () => {
		mockHasProjectAccess.mockResolvedValue(true);
		const result = (await get("member-2")) as { id: string };
		expect(result.id).toBe("frame-1");
		expect(mockHasProjectAccess).toHaveBeenCalledWith("proj-1", "member-2");
	});

	it("does not return a project frame to a non-member (fail closed)", async () => {
		mockHasProjectAccess.mockResolvedValue(false);
		const error = await get("outsider").then(
			() => null,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(ORPCError);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
	});

	it("never widens access for frames without a projectId", async () => {
		mockGetProjectFrameById.mockResolvedValue(null);
		mockHasProjectAccess.mockResolvedValue(true);
		const error = await get("member-2").then(
			() => null,
			(e: unknown) => e,
		);
		expect((error as ORPCError<string, unknown>).code).toBe("NOT_FOUND");
		expect(mockHasProjectAccess).not.toHaveBeenCalled();
	});

	it("still serves the creator through the personal lookup first", async () => {
		mockGetFrameById.mockResolvedValue(projectFrame);
		const result = (await get("creator-1")) as { id: string };
		expect(result.id).toBe("frame-1");
		expect(mockGetProjectFrameById).not.toHaveBeenCalled();
	});
});

describe("frames.listForStory", () => {
	it("lists frames for the project + story pair", async () => {
		mockListFramesForStory.mockResolvedValue([projectFrame]);
		const result = (await handlers["/frames/for-story"]({
			input: { projectId: "proj-1", storyId: "story-1" },
			context: { user: { id: "member-2" }, session: {} },
		})) as Array<{ id: string; createdAt: string }>;
		expect(mockListFramesForStory).toHaveBeenCalledWith({
			projectId: "proj-1",
			storyId: "story-1",
			limit: undefined,
		});
		expect(result).toHaveLength(1);
		expect(result[0].createdAt).toBe(now.toISOString());
	});
});
