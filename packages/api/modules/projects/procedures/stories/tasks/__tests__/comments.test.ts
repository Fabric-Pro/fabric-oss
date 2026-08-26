import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		createTaskComment: vi.fn(),
		findRecentDuplicateTaskComment: vi.fn(),
		hasProjectAccess: vi.fn(),
		listTaskComments: vi.fn(),
		markTaskCommentWorkflowQueued: vi.fn(),
		storyTaskFindFirst: vi.fn(),
		storyTaskCommentFindFirst: vi.fn(),
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
	createTaskComment: mocks.createTaskComment,
	findRecentDuplicateTaskComment: mocks.findRecentDuplicateTaskComment,
	hasProjectAccess: mocks.hasProjectAccess,
	listTaskComments: mocks.listTaskComments,
	markTaskCommentWorkflowQueued: mocks.markTaskCommentWorkflowQueued,
	db: {
		storyTask: { findFirst: mocks.storyTaskFindFirst },
		storyTaskComment: { findFirst: mocks.storyTaskCommentFindFirst },
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../../lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

vi.mock("../../../../../../orpc/procedures", () => {
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

vi.mock("../../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("../../../../../../lib/notification-service", () => ({
	fanOut: {
		mention: mocks.fanOutMention,
		reply: mocks.fanOutReply,
		assigned: mocks.fanOutAssigned,
	},
}));

// extractUserMentions/extractGroupMentions are pure parsers — keep the real
// implementations so `@alice` / `@@developers` tokens resolve deterministically
// from test content. Only the db-backed `resolveMentionedUserIds` is stubbed.
vi.mock("../../../../lib/user-mention", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../../../lib/user-mention")>();
	return {
		...actual,
		resolveMentionedUserIds: mocks.resolveMentionedUserIds,
	};
});

// Group-mention resolution (roster read + project narrow + flag gate) is
// fully stubbed so tests control membership directly (#1767 Stage 5).
vi.mock("../../../../lib/group-mention", () => ({
	expandGroupMentionsByTag: mocks.expandGroupMentionsByTag,
	narrowToCurrentProjectRoster: mocks.narrowToCurrentProjectRoster,
}));

await import("../comments");

describe("createTaskCommentProcedure", () => {
	const baseInput = {
		projectId: "project-1",
		storyId: "story-1",
		taskId: "task-1",
		content: "ship the redesign",
		organizationId: null,
	};
	const ctx = { user: { id: "user-1" }, session: {} };

	beforeEach(() => {
		for (const m of Object.values(mocks)) {
			(m as ReturnType<typeof vi.fn>).mockReset();
		}
		mocks.hasProjectAccess.mockResolvedValue(true);
		mocks.storyTaskFindFirst.mockResolvedValue({ id: "task-1" });
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

	it("rejects a parentId that is not a comment on the same task, before creating", async () => {
		mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
		mocks.storyTaskCommentFindFirst.mockResolvedValue(null);

		await expect(
			handlers.create({
				input: { ...baseInput, parentId: "foreign-comment" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);

		expect(mocks.storyTaskCommentFindFirst).toHaveBeenCalledWith({
			where: { id: "foreign-comment", taskId: "task-1" },
			select: { id: true, authorType: true },
		});
		expect(mocks.createTaskComment).not.toHaveBeenCalled();
	});

	it("rejects a parentId that points to an AGENT comment, before creating", async () => {
		mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
		mocks.storyTaskCommentFindFirst.mockResolvedValue({
			id: "agent-comment",
			authorType: "AGENT",
		});

		await expect(
			handlers.create({
				input: { ...baseInput, parentId: "agent-comment" },
				context: ctx,
			}),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.createTaskComment).not.toHaveBeenCalled();
	});

	it("accepts a parentId that belongs to the same task", async () => {
		mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
		mocks.storyTaskCommentFindFirst.mockResolvedValue({
			id: "parent-1",
			authorType: "USER",
		});
		mocks.createTaskComment.mockResolvedValue({
			id: "reply-1",
			content: baseInput.content,
		});

		const result = await handlers.create({
			input: { ...baseInput, parentId: "parent-1" },
			context: ctx,
		});

		expect(mocks.createTaskComment).toHaveBeenCalledTimes(1);
		expect(result.fabricMentionQueued).toBe(false);
		expect(mocks.findRecentDuplicateTaskComment).toHaveBeenCalledWith(
			expect.objectContaining({ parentId: "parent-1" }),
		);
	});

	describe("group mentions (#1767 Stage 5)", () => {
		it("dispatches one fanOut.mention for @@developers with the group label", async () => {
			mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
			mocks.createTaskComment.mockResolvedValue({
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
					target: { taskId: "task-1" },
				}),
			);
			// Batched resolve: the roster is read once for all mentioned tags.
			expect(mocks.expandGroupMentionsByTag).toHaveBeenCalledTimes(1);
			expect(mocks.narrowToCurrentProjectRoster).toHaveBeenCalledTimes(1);
		});

		it("excludes an individually-mentioned user from the group dispatch (individual wins)", async () => {
			mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
			mocks.createTaskComment.mockResolvedValue({
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
			mocks.findRecentDuplicateTaskComment.mockResolvedValue(null);
			mocks.createTaskComment.mockResolvedValue({
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
