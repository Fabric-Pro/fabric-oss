import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		createStoryComment: vi.fn(),
		findRecentDuplicateStoryComment: vi.fn(),
		hasProjectAccess: vi.fn(),
		listStoryComments: vi.fn(),
		markStoryCommentWorkflowQueued: vi.fn(),
		userStoryFindFirst: vi.fn(),
		userStoryCommentFindFirst: vi.fn(),
		dispatchLifecycleEvent: vi.fn(),
		workflowStart: vi.fn(),
		checkRateLimit: vi.fn(),
		resolveMentionedUserIds: vi.fn(),
		expandGroupMentionsByTag: vi.fn(),
		narrowToCurrentProjectRoster: vi.fn(),
		fanOutMention: vi.fn(),
		fanOutReply: vi.fn(),
		fanOutAssigned: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	createStoryComment: mocks.createStoryComment,
	findRecentDuplicateStoryComment: mocks.findRecentDuplicateStoryComment,
	hasProjectAccess: mocks.hasProjectAccess,
	listStoryComments: mocks.listStoryComments,
	markStoryCommentWorkflowQueued: mocks.markStoryCommentWorkflowQueued,
	db: {
		userStory: { findFirst: mocks.userStoryFindFirst },
		userStoryComment: { findFirst: mocks.userStoryCommentFindFirst },
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			if (!handlers.list) {
				handlers.list = fn;
			} else {
				handlers.create = fn;
			}
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

vi.mock("../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

// Stub the notification fan-out so the test mock of `@repo/database` doesn't
// need to expose the NotificationType / NotificationCategory enums that
// `notification-service.ts` references at module load.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		mention: mocks.fanOutMention,
		reply: mocks.fanOutReply,
		assigned: mocks.fanOutAssigned,
	},
}));

// extractUserMentions/extractGroupMentions are pure parsers — keep the real
// implementations so `@alice` / `@@developers` tokens resolve deterministically
// from test content. Only the db-backed `resolveMentionedUserIds` is stubbed.
vi.mock("../../../lib/user-mention", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../lib/user-mention")>();
	return {
		...actual,
		resolveMentionedUserIds: mocks.resolveMentionedUserIds,
	};
});

// Group-mention resolution (roster read + project narrow + flag gate) is
// fully stubbed so tests control membership directly (#1767 Stage 5).
vi.mock("../../../lib/group-mention", () => ({
	expandGroupMentionsByTag: mocks.expandGroupMentionsByTag,
	narrowToCurrentProjectRoster: mocks.narrowToCurrentProjectRoster,
}));

await import("../comments");

describe("createStoryCommentProcedure", () => {
	const baseInput = {
		projectId: "project-1",
		storyId: "story-1",
		content: "ship the redesign",
		organizationId: null,
	};
	const ctx = { user: { id: "user-1" }, session: {} };

	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.userStoryFindFirst.mockResolvedValue({ id: "story-1" });
		mocks.checkRateLimit.mockResolvedValue({
			allowed: true,
			remaining: 29,
			resetInSeconds: 60,
		});
		mocks.dispatchLifecycleEvent.mockResolvedValue({
			matched: 0,
			started: 0,
		});
		mocks.resolveMentionedUserIds.mockResolvedValue([]);
		mocks.expandGroupMentionsByTag.mockResolvedValue(new Map());
		mocks.narrowToCurrentProjectRoster.mockResolvedValue([]);
	});

	async function flushPromises() {
		// Let the fire-and-forget notification fan-out settle before assertions.
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));
	}

	it("returns the existing comment when an identical recent duplicate is found", async () => {
		const existing = {
			id: "comment-existing",
			content: baseInput.content,
			authorType: "USER",
			workflowId: "fabric-mention-reply-comment-existing",
		};
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(existing);

		const result = await handlers.create({
			input: baseInput,
			context: ctx,
		});

		expect(result).toEqual({
			comment: existing,
			fabricMentionQueued: true,
		});
		expect(mocks.createStoryComment).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("starts the Fabric mention workflow only when content includes @fabric", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.createStoryComment.mockResolvedValue({
			id: "new-comment",
			content: "hey @fabric what next?",
			workflowId: null,
		});
		mocks.markStoryCommentWorkflowQueued.mockResolvedValue({
			id: "new-comment",
			workflowId: "fabric-mention-reply-new-comment",
		});

		const result = await handlers.create({
			input: { ...baseInput, content: "hey @fabric what next?" },
			context: ctx,
		});

		expect(mocks.checkRateLimit).toHaveBeenCalledWith(
			"fabric-mention:project-1:user-1",
			30,
			60_000,
		);
		expect(mocks.workflowStart).toHaveBeenCalledTimes(1);
		expect(mocks.markStoryCommentWorkflowQueued).toHaveBeenCalledTimes(1);
		expect(result.fabricMentionQueued).toBe(true);
	});

	it("does not call rate-limiter or workflow when content has no @fabric mention", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.createStoryComment.mockResolvedValue({
			id: "new-comment",
			content: "ship the redesign",
		});

		const result = await handlers.create({
			input: baseInput,
			context: ctx,
		});

		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(result.fabricMentionQueued).toBe(false);
	});

	it("rejects with TOO_MANY_REQUESTS when rate limit is exceeded", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 42,
		});

		await expect(
			handlers.create({
				input: { ...baseInput, content: "@fabric please" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.createStoryComment).not.toHaveBeenCalled();
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("rejects a parentId that is not a comment on the same story, before creating", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.userStoryCommentFindFirst.mockResolvedValue(null); // foreign / missing

		await expect(
			handlers.create({
				input: { ...baseInput, parentId: "foreign-comment" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);

		expect(mocks.userStoryCommentFindFirst).toHaveBeenCalledWith({
			where: { id: "foreign-comment", storyId: "story-1" },
			select: { id: true, authorType: true },
		});
		expect(mocks.createStoryComment).not.toHaveBeenCalled();
	});

	it("rejects a parentId that points to an AGENT comment, before creating", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.userStoryCommentFindFirst.mockResolvedValue({
			id: "agent-comment",
			authorType: "AGENT",
		});

		await expect(
			handlers.create({
				input: { ...baseInput, parentId: "agent-comment" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.createStoryComment).not.toHaveBeenCalled();
	});

	it("accepts a parentId that belongs to the same story", async () => {
		mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
		mocks.userStoryCommentFindFirst.mockResolvedValue({
			id: "parent-1",
			authorType: "USER",
		});
		mocks.createStoryComment.mockResolvedValue({
			id: "reply-1",
			content: baseInput.content,
		});

		const result = await handlers.create({
			input: { ...baseInput, parentId: "parent-1" },
			context: ctx,
		});

		expect(mocks.createStoryComment).toHaveBeenCalledTimes(1);
		expect(result.fabricMentionQueued).toBe(false);
		expect(mocks.findRecentDuplicateStoryComment).toHaveBeenCalledWith(
			expect.objectContaining({ parentId: "parent-1" }),
		);
	});

	describe("group mentions (#1767 Stage 5)", () => {
		it("dispatches one fanOut.mention for @@developers with the group label", async () => {
			mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
			mocks.createStoryComment.mockResolvedValue({
				id: "comment-1",
				content: "please loop in @@developers",
			});
			mocks.expandGroupMentionsByTag.mockResolvedValue(
				new Map([["DEVELOPER", ["user-x", "user-y"]]]),
			);
			mocks.narrowToCurrentProjectRoster.mockImplementation(
				async (ids: string[]) => ids,
			);

			await handlers.create({
				input: { ...baseInput, content: "please loop in @@developers" },
				context: ctx,
			});
			await flushPromises();

			expect(mocks.fanOutMention).toHaveBeenCalledTimes(1);
			expect(mocks.fanOutMention).toHaveBeenCalledWith(
				expect.objectContaining({
					recipientUserIds: ["user-x", "user-y"],
					groupLabel: "Developers",
					target: { storyId: "story-1" },
				}),
			);
			// Batched resolve: the roster is read once for all mentioned tags.
			expect(mocks.expandGroupMentionsByTag).toHaveBeenCalledTimes(1);
			expect(mocks.narrowToCurrentProjectRoster).toHaveBeenCalledTimes(1);
		});

		it("excludes an individually-mentioned user from the group dispatch (individual wins)", async () => {
			mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
			mocks.createStoryComment.mockResolvedValue({
				id: "comment-2",
				content: "@alice @@developers please review",
			});
			mocks.resolveMentionedUserIds.mockResolvedValue(["alice-id"]);
			// Alice also holds DEVELOPER — she's in the expanded roster too.
			mocks.expandGroupMentionsByTag.mockResolvedValue(
				new Map([["DEVELOPER", ["alice-id", "user-x", "user-y"]]]),
			);
			mocks.narrowToCurrentProjectRoster.mockImplementation(
				async (ids: string[]) => ids,
			);

			await handlers.create({
				input: {
					...baseInput,
					content: "@alice @@developers please review",
				},
				context: ctx,
			});
			await flushPromises();

			expect(mocks.fanOutMention).toHaveBeenCalledTimes(2);

			const individualCall = mocks.fanOutMention.mock.calls[0][0];
			expect(individualCall).toEqual(
				expect.objectContaining({ recipientUserIds: ["alice-id"] }),
			);
			expect(individualCall.groupLabel).toBeUndefined();

			const groupCall = mocks.fanOutMention.mock.calls[1][0];
			expect(groupCall).toEqual(
				expect.objectContaining({
					recipientUserIds: ["user-x", "user-y"],
					groupLabel: "Developers",
				}),
			);
		});

		it("dispatches no group fanOut.mention when the function-tags flag is off", async () => {
			mocks.findRecentDuplicateStoryComment.mockResolvedValue(null);
			mocks.createStoryComment.mockResolvedValue({
				id: "comment-3",
				content: "@@developers",
			});
			// expandGroupMentionsByTag is itself flag-gated and returns an empty
			// map when FABRIC_FEATURE_FUNCTION_TAGS is off — simulate that.
			mocks.expandGroupMentionsByTag.mockResolvedValue(new Map());
			mocks.narrowToCurrentProjectRoster.mockResolvedValue([]);

			await handlers.create({
				input: { ...baseInput, content: "@@developers" },
				context: ctx,
			});
			await flushPromises();

			expect(mocks.fanOutMention).not.toHaveBeenCalled();
		});
	});
});
