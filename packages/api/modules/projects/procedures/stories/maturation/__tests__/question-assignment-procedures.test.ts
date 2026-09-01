import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Question routing procedures (Fizzy #1751).
 *
 * Mirrors the mocking style of `maturation-procedures.test.ts`: `@repo/database`
 * and the oRPC builder are mocked, and each handler is captured and invoked
 * directly.
 *
 * The behaviours worth pinning here are the ones a reasonable implementation
 * gets wrong:
 *
 *  - `setQuestionAssignees` must NEVER resolve the question. It is the "Ask"
 *    half of the mention split, so routing it through the answer path would
 *    close the very question being asked.
 *  - Only NEWLY-ADDED assignees are notified, so re-saving an unchanged set is
 *    silent rather than a re-ping.
 *  - Assignment is not access control (AC-7): no caller is refused for not
 *    being the author or an existing assignee.
 *  - PM-sync isolation (§7.7): neither procedure may enqueue a sync.
 */

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Array<(...args: unknown[]) => unknown> = [];
	const mocks = {
		hasProjectAccess: vi.fn(),
		getDecisionLogEntryById: vi.fn(),
		setQuestionAssignees: vi.fn(),
		appendDecisionLogReply: vi.fn(),
		userStoryFindUnique: vi.fn(),
		listProjectMentionableMembers: vi.fn(),
		questionAssigned: vi.fn(),
		enqueuePmSync: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDecisionLogEntryById: mocks.getDecisionLogEntryById,
	setQuestionAssignees: mocks.setQuestionAssignees,
	appendDecisionLogReply: mocks.appendDecisionLogReply,
	db: { userStory: { findUnique: mocks.userStoryFindUnique } },
}));

vi.mock("../../../../lib/project-mentionable-members", () => ({
	listProjectMentionableMembers: mocks.listProjectMentionableMembers,
}));

vi.mock("../../../../../../lib/notification-service", () => ({
	fanOut: { questionAssigned: mocks.questionAssigned },
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.push(fn);
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

// Fixed import order; handlers[] fills in that order.
await import("../search-assignable-members");
const searchAssignableMembers = handlers[0];
await import("../set-question-assignees");
const setQuestionAssigneesHandler = handlers[1];

const ORG = "org_acme";
const CALLER = { id: "user_caller", name: "Dana P." };
const ASSIGNEE = "user_assignee";
const ROOT = "root_1";

const context = { user: CALLER, session: {} };

function assignInput(overrides: Record<string, unknown> = {}) {
	// No `organizationId`: neither procedure accepts one. See the ratchet test
	// below for why.
	return {
		projectId: "proj_1",
		storyId: "story_1",
		questionRootId: ROOT,
		assigneeUserIds: [ASSIGNEE],
		link: "/app/example-org/projects/proj_1/stories/story_1",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.getDecisionLogEntryById.mockResolvedValue({
		id: ROOT,
		userStoryId: "story_1",
		summary: "Should exports include archived records?",
		content: null,
	});
	mocks.setQuestionAssignees.mockResolvedValue([ASSIGNEE]);
	mocks.userStoryFindUnique.mockResolvedValue({ title: "Export controls" });
	mocks.listProjectMentionableMembers.mockResolvedValue([]);
});

describe("setQuestionAssignees", () => {
	it("assigns and notifies only the newly-added people", async () => {
		const result = (await setQuestionAssigneesHandler({
			input: assignInput({ assigneeUserIds: [ASSIGNEE, "user_third"] }),
			context,
		})) as { assigneeUserIds: string[]; notifiedUserIds: string[] };

		expect(result.assigneeUserIds).toEqual([ASSIGNEE, "user_third"]);
		// setQuestionAssignees reported only ASSIGNEE as added, so only they are told.
		expect(result.notifiedUserIds).toEqual([ASSIGNEE]);
		expect(mocks.questionAssigned).toHaveBeenCalledTimes(1);
		expect(
			mocks.questionAssigned.mock.calls[0][0].recipientUserIds,
		).toEqual([ASSIGNEE]);
	});

	it("stays silent when nothing was added", async () => {
		mocks.setQuestionAssignees.mockResolvedValue([]);

		const result = (await setQuestionAssigneesHandler({
			input: assignInput(),
			context,
		})) as { notifiedUserIds: string[] };

		expect(result.notifiedUserIds).toEqual([]);
		expect(mocks.questionAssigned).not.toHaveBeenCalled();
	});

	it("never resolves the question — it is an ask, not an answer", async () => {
		await setQuestionAssigneesHandler({
			input: assignInput({ note: "It should be ninety days, right?" }),
			context,
		});

		// The note is appended as a plain reply turn…
		expect(mocks.appendDecisionLogReply).toHaveBeenCalledTimes(1);
		const reply = mocks.appendDecisionLogReply.mock.calls[0][0];
		expect(reply.parentId).toBe(ROOT);
		expect(reply.authorType).toBe("USER");
		// …and nothing in this path may carry a resolution.
		expect(reply).not.toHaveProperty("status");
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("skips the reply turn when no note was typed", async () => {
		await setQuestionAssigneesHandler({ input: assignInput(), context });
		expect(mocks.appendDecisionLogReply).not.toHaveBeenCalled();

		await setQuestionAssigneesHandler({
			input: assignInput({ note: "   " }),
			context,
		});
		expect(mocks.appendDecisionLogReply).not.toHaveBeenCalled();
	});

	it("clears every assignee when given an empty set", async () => {
		mocks.setQuestionAssignees.mockResolvedValue([]);

		const result = (await setQuestionAssigneesHandler({
			input: assignInput({ assigneeUserIds: [] }),
			context,
		})) as { assigneeUserIds: string[] };

		expect(result.assigneeUserIds).toEqual([]);
		expect(
			mocks.setQuestionAssignees.mock.calls[0][0].assigneeUserIds,
		).toEqual([]);
	});

	it("deep-links to the question rather than the feature root", async () => {
		await setQuestionAssigneesHandler({ input: assignInput(), context });

		const args = mocks.questionAssigned.mock.calls[0][0];
		// The root id IS the anchor — no second field to drift out of sync with
		// what the panel renders.
		expect(args.questionRootId).toBe(ROOT);
		expect(args.storyTitle).toBe("Export controls");
	});

	it("refuses a caller without project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			setQuestionAssigneesHandler({ input: assignInput(), context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.setQuestionAssignees).not.toHaveBeenCalled();
	});

	it("404s when the question is not visible in this tenant", async () => {
		mocks.getDecisionLogEntryById.mockResolvedValue(null);

		await expect(
			setQuestionAssigneesHandler({ input: assignInput(), context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.setQuestionAssignees).not.toHaveBeenCalled();
	});

	it("ignores an organization smuggled in via input", async () => {
		// `hasProjectAccess` and `requireProjectPermission` both authorize on
		// (projectId, userId) and never look at the org, so an input org would
		// let a caller pair a project they can reach with one they cannot. The
		// procedure resolves the org from the request's tenant context instead,
		// which the permission middleware set from the PROJECT's organization.
		await setQuestionAssigneesHandler({
			input: assignInput({ organizationId: "org_attacker" }),
			context,
		});

		expect(
			mocks.setQuestionAssignees.mock.calls[0][0].tenantFilter
				.organizationId,
		).not.toBe("org_attacker");
	});

	it("does not gate on the caller being author or assignee (AC-7)", async () => {
		// A caller who is neither the author nor among the current assignees.
		const stranger = {
			user: { id: "user_stranger", name: "Sam R." },
			session: {},
		};

		await expect(
			setQuestionAssigneesHandler({
				input: assignInput({ assigneeUserIds: ["user_fourth"] }),
				context: stranger,
			}),
		).resolves.toBeDefined();
	});
});

describe("searchAssignableMembers", () => {
	it("returns project members and never function-tag groups", async () => {
		mocks.listProjectMentionableMembers.mockResolvedValue([
			{
				id: ASSIGNEE,
				name: "Sam R.",
				email: "sam@example.com",
				avatarUrl: null,
			},
		]);

		const result = (await searchAssignableMembers({
			input: { projectId: "proj_1", storyId: "story_1", query: "sam" },
			context,
		})) as Record<string, unknown>;

		expect(result.members).toHaveLength(1);
		// A group cannot be made accountable for answering, so the shape has no
		// room for one.
		expect(result).not.toHaveProperty("groups");
	});

	it("refuses a caller without project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(
			searchAssignableMembers({
				input: { projectId: "proj_1", storyId: "story_1", query: "" },
				context,
			}),
		).rejects.toBeInstanceOf(ORPCError);
	});
});
