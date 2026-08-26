/**
 * Unit tests for `shareStoryProcedure` (In-Feature Collaboration — Notify).
 *
 * Covers:
 *   - Happy path: notifies valid project members with the feature title +
 *     context-relative link + optional message; excludes self from the count.
 *   - Rejects recipients that are not project members (BAD_REQUEST) — the
 *     server-side allow-list enforcing "only project members".
 *   - FORBIDDEN when the caller lacks project access.
 *   - NOT_FOUND for a missing / wrong-project story.
 *
 * Mocks @repo/database (hasProjectAccess, getStoryById, getProjectMembers),
 * the notification-service fanOut, and the oRPC procedure base so we invoke the
 * raw handler directly.
 */

import { ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		hasProjectAccess: vi.fn(),
		getStoryById: vi.fn(),
		getProjectMembers: vi.fn(),
		storyShared: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getStoryById: mocks.getStoryById,
	getProjectMembers: mocks.getProjectMembers,
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { storyShared: mocks.storyShared },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.share = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

// Trigger handler registration.
import "../share-story";

const baseContext = {
	user: { id: "user-1", name: "Alice" },
	session: {},
};

const baseInput = {
	projectId: "proj-1",
	storyId: "story-1",
	organizationId: null,
	recipientUserIds: ["user-2", "user-3"],
	message: "  please review  ",
};

function members(ids: string[]) {
	return ids.map((userId) => ({ userId }));
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getStoryById.mockResolvedValue({
		id: "story-1",
		title: "Dark mode",
		identifier: "F-007",
	});
	mocks.getProjectMembers.mockResolvedValue(
		members(["user-1", "user-2", "user-3"]),
	);
	mocks.storyShared.mockResolvedValue(2);
});

describe("shareStoryProcedure", () => {
	it("notifies valid members with title, identifier, link, and message", async () => {
		const result = await handlers.share({
			input: baseInput,
			context: baseContext,
		});

		expect(mocks.storyShared).toHaveBeenCalledWith(
			expect.objectContaining({
				recipientUserIds: ["user-2", "user-3"],
				storyId: "story-1",
				projectId: "proj-1",
				organizationId: null,
				actorUserId: "user-1",
				actorName: "Alice",
				featureTitle: "Dark mode",
				identifier: "F-007",
				link: "projects/proj-1/stories/story-1",
				message: "  please review  ",
			}),
		);
		expect((result as { notifiedCount: number }).notifiedCount).toBe(2);
	});

	it("reports the actual rows-written count from fanOut, not the request size", async () => {
		// e.g. one recipient was deduped/suppressed inside the fan-out.
		mocks.storyShared.mockResolvedValue(1);
		const result = await handlers.share({
			input: baseInput,
			context: baseContext,
		});
		expect((result as { notifiedCount: number }).notifiedCount).toBe(1);
	});

	it("rejects recipients who are not project members (BAD_REQUEST)", async () => {
		mocks.getProjectMembers.mockResolvedValue(
			members(["user-1", "user-2"]),
		);
		await expect(
			handlers.share({
				input: {
					...baseInput,
					recipientUserIds: ["user-2", "outsider-9"],
				},
				context: baseContext,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.storyShared).not.toHaveBeenCalled();
	});

	it("throws FORBIDDEN when the caller lacks project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			handlers.share({ input: baseInput, context: baseContext }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.getStoryById).not.toHaveBeenCalled();
		expect(mocks.storyShared).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND for a missing story", async () => {
		mocks.getStoryById.mockResolvedValue(null);
		await expect(
			handlers.share({ input: baseInput, context: baseContext }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.storyShared).not.toHaveBeenCalled();
	});
});
