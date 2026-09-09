import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setQuestionAssignees` — who a topic's open question is waiting on
 * (Fizzy #1851). Handler-level, mirroring `update-topic-assignees.test.ts`:
 * the procedure chain, the DB layer and the notification fan-out are all
 * mocked, so what is under test is the handler's own contract.
 *
 * Three things here are security- or product-critical rather than hygiene:
 *
 * MEMBERSHIP. The ids written here are later resolved to display handles by an
 * unscoped user lookup, so an unchecked id turns this endpoint into a
 * name-disclosure oracle for arbitrary user ids — the property
 * `update-topic-contributors.ts` documents at length. No grandfather rule, for
 * the same reason the topic-level assignee write has none: every id in this
 * table got there by passing this exact check.
 *
 * NOTIFY ON ADD ONLY. A removal tells the recipient nothing they can act on, a
 * re-save of an unchanged list is not an event, and the person doing the
 * asking must never be told about their own click.
 *
 * NEVER ANSWERS. Asking somebody is not settling the question. Nothing here may
 * reach `answerTopicQuestion`, or an "ask" would close the very question being
 * asked.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	getProjectMembers: vi.fn(),
	getPublishingTopic: vi.fn(),
	setTopicQuestionAssignees: vi.fn(),
	answerTopicQuestion: vi.fn(),
}));
const notifyMocks = vi.hoisted(() => ({
	publishingQuestionAssigned: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectMembers: dbMocks.getProjectMembers,
	getPublishingTopic: dbMocks.getPublishingTopic,
	setTopicQuestionAssignees: dbMocks.setTopicQuestionAssignees,
	// Exported so the "never answers" assertion below has something real to be
	// about. The handler must not import it; if it ever does, this spy is what
	// catches it.
	answerTopicQuestion: dbMocks.answerTopicQuestion,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		publishingQuestionAssigned: notifyMocks.publishingQuestionAssigned,
	},
}));
vi.mock("../../../../../orpc/procedures", () => {
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
		Permissions: {
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import {
	answerTopicQuestion,
	getProjectMembers,
	setTopicQuestionAssignees,
} from "@repo/database";
import { fanOut } from "../../../../../lib/notification-service";
import { setPublishingQuestionAssigneesProcedure } from "../set-question-assignees";

const handler = (
	setPublishingQuestionAssigneesProcedure as unknown as { handler: Function }
).handler;
const permission = (
	setPublishingQuestionAssigneesProcedure as unknown as {
		__permission: string;
	}
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	questionRootId: "root-1",
	organizationId: "org-1",
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

function call(assigneeUserIds: string[]) {
	return handler({
		input: { ...BASE_INPUT, assigneeUserIds },
		context: CONTEXT,
	});
}

function memberRow(userId: string) {
	return {
		userId,
		role: "MEMBER",
		user: {
			id: userId,
			name: "A Member",
			email: "member@example.com",
			image: null,
		},
		isOwner: false,
		isCreator: false,
		isGuest: false,
		invitedAt: new Date("2026-01-01T00:00:00Z"),
		acceptedAt: new Date("2026-01-02T00:00:00Z"),
		expiresAt: null,
	};
}

/**
 * The fan-out is fire-and-forget behind an async IIFE, so it lands a few
 * microtasks after the handler resolves. Drain generously before asserting a
 * NEGATIVE — "it was never called" checked one tick too early passes for the
 * wrong reason, and would let a notify-on-removal regression through.
 */
async function drainFanOut() {
	for (let i = 0; i < 20; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: null,
	});
	dbMocks.getProjectMembers.mockResolvedValue([
		memberRow("u1"),
		memberRow("u2"),
		memberRow("actor-1"),
	]);
	dbMocks.getPublishingTopic.mockResolvedValue({
		topic: { id: "topic-1", title: "The retry-budget story" },
	});
	dbMocks.setTopicQuestionAssignees.mockResolvedValue({
		added: [],
		summary: "the named customer",
	});
});

describe("setQuestionAssignees", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		// A write, so UPDATE and not READ. Assignment is not access control —
		// anyone who may edit the topic may change who a question waits on —
		// but it is still a write, and a viewer must not make one.
		expect(permission).toBe("publishing-topic:update");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call(["u1"])).rejects.toThrow(
			/Publishing Suite is not enabled/,
		);
		expect(setTopicQuestionAssignees).not.toHaveBeenCalled();
	});

	it("refuses an id that is not a current project member", async () => {
		await expect(call(["u1", "stranger"])).rejects.toThrow(
			/current project members/,
		);
		// And nothing was written — a partial save here would leave the picker
		// and the table disagreeing about who was asked.
		expect(setTopicQuestionAssignees).not.toHaveBeenCalled();
	});

	it("skips the membership read entirely when clearing", async () => {
		await call([]);

		// Clearing names nobody, so there is nothing to check — and a project
		// with no members left must still be clearable.
		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(setTopicQuestionAssignees).toHaveBeenCalledWith(
			expect.objectContaining({ assigneeUserIds: [] }),
		);
	});

	it("records the CALLER as the assigner, never a client-supplied id", async () => {
		await call(["u1"]);

		expect(setTopicQuestionAssignees).toHaveBeenCalledWith(
			expect.objectContaining({
				topicId: "topic-1",
				projectId: "project-1",
				entryId: "root-1",
				assignedByUserId: "actor-1",
			}),
		);
	});

	it("reports NOT_FOUND for a question that is not on this topic", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue(null);

		await expect(call(["u1"])).rejects.toThrow(/Question not found/);
	});

	it("notifies the people it added, with the question's own wording", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue({
			added: ["u2"],
			summary: "May we name the customer?",
		});

		await call(["u1", "u2"]);
		await vi.waitFor(() =>
			expect(fanOut.publishingQuestionAssigned).toHaveBeenCalled(),
		);

		expect(fanOut.publishingQuestionAssigned).toHaveBeenCalledWith(
			expect.objectContaining({
				recipientUserIds: ["u2"],
				topicId: "topic-1",
				questionRootId: "root-1",
				questionSummary: "May we name the customer?",
				topicTitle: "The retry-budget story",
				actorUserId: "actor-1",
				// Context-relative: the bell prepends the notification's own
				// workspace base, so a leading `/app` or an org slug here would
				// produce a doubled path.
				link: "projects/project-1/publishing/topic-1",
			}),
		);
	});

	it("takes the notification tenant from the PROJECT, not from the input", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue({
			added: ["u2"],
			summary: "s",
		});
		flagMocks.resolveProjectTenant.mockResolvedValue({
			organizationId: "org-from-project",
			userId: null,
		});

		await call(["u2"]);
		await vi.waitFor(() =>
			expect(fanOut.publishingQuestionAssigned).toHaveBeenCalled(),
		);

		// `input.organizationId` is "org-1" and is never membership-checked.
		// Pairing a project somebody may legitimately reach with an
		// organization they may not is the shape every cross-tenant leak in
		// this area has had.
		expect(fanOut.publishingQuestionAssigned).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-from-project" }),
		);
	});

	it("notifies nobody when the save added nobody", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue({
			added: [],
			summary: "s",
		});

		await call(["u1"]);
		await drainFanOut();

		// The picker submits the whole list on every interaction, so a re-save
		// of an unchanged set is the ordinary case — and it must be silent.
		expect(fanOut.publishingQuestionAssigned).not.toHaveBeenCalled();
	});

	it("notifies nobody when the save only REMOVED people", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue({
			added: [],
			summary: "s",
		});

		await call([]);
		await drainFanOut();

		expect(fanOut.publishingQuestionAssigned).not.toHaveBeenCalled();
	});

	it("never answers the question it routes", async () => {
		dbMocks.setTopicQuestionAssignees.mockResolvedValue({
			added: ["u2"],
			summary: "s",
		});

		await call(["u2"]);
		await drainFanOut();

		// Asking somebody is not settling the question. Routing an ask through
		// the answer path would flip the root to RESOLVED and close the very
		// question being asked.
		expect(answerTopicQuestion).not.toHaveBeenCalled();
	});

	it("returns the deduplicated set the caller asked for", async () => {
		const result = await call(["u1", "u1", "u2"]);

		expect(result).toEqual({
			assigneeUserIds: ["u1", "u2"],
			notifiedUserIds: [],
		});
	});
});
