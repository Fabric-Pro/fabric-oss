import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTopicAssignees` — who should pick a publishing topic up (Fizzy #1851,
 * A8). Handler-level, mirroring `update-topic-contributors.test.ts`: the
 * procedure chain, the DB layer and the notification fan-out are all mocked, so
 * what is under test is the handler's own contract.
 *
 * Two things here are security- or product-critical rather than hygiene:
 *
 * MEMBERSHIP. The ids written here are later fed to an unscoped
 * `db.user.findMany` that resolves display handles, so an unchecked id would
 * turn this endpoint into a name-disclosure oracle for arbitrary user ids —
 * the same property `update-topic-contributors.ts` documents at length. This
 * check is STRICTER than that one: no grandfather rule, because every id in
 * the assignee column got there by passing this exact check, so a non-member
 * id can only mean the person left the project.
 *
 * NOTIFY ON ADD ONLY. Assignment is an FYI. A removal tells the recipient
 * nothing actionable, a re-save of an unchanged list is not an event, and the
 * person doing the assigning must never be told about their own click. All
 * three are asserted below, because all three are the difference between a
 * useful signal and something people mute.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	getProjectMembers: vi.fn(),
	updatePublishingTopicAssignees: vi.fn(),
}));
const notifyMocks = vi.hoisted(() => ({
	publishingTopicAssigned: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectMembers: dbMocks.getProjectMembers,
	updatePublishingTopicAssignees: dbMocks.updatePublishingTopicAssignees,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason. The handler reads it a SECOND time for
	// the notification's tenant, so it is called more than once by design.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { publishingTopicAssigned: notifyMocks.publishingTopicAssigned },
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
	getProjectMembers,
	updatePublishingTopicAssignees,
} from "@repo/database";
import { fanOut } from "../../../../../lib/notification-service";
import { updatePublishingTopicAssigneesProcedure } from "../update-topic-assignees";

const handler = (
	updatePublishingTopicAssigneesProcedure as unknown as {
		handler: Function;
	}
).handler;
const permission = (
	updatePublishingTopicAssigneesProcedure as unknown as {
		__permission: string;
	}
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
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
 * wrong reason, and would let a notify-on-removal regression through. Positive
 * assertions use `vi.waitFor` on the fan-out itself instead of this.
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
	// ADR-018 ("An organization is the only tenant context"): the default
	// tenant here is org-scoped, not personal.
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	dbMocks.getProjectMembers.mockResolvedValue([
		memberRow("member-1"),
		memberRow("member-2"),
		memberRow("actor-1"),
	]);
	dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
		topic: { id: "topic-1", title: "A topic" },
		addedUserIds: [],
	});
	notifyMocks.publishingTopicAssigned.mockResolvedValue(undefined);
});

describe("updateTopicAssignees procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(permission).toBe("publishing-topic:update");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call(["member-1"])).rejects.toThrow(
			/Publishing Suite is not enabled/,
		);
		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(updatePublishingTopicAssignees).not.toHaveBeenCalled();
	});

	it("accepts current project members and reaches the DB helper", async () => {
		await call(["member-1", "member-2"]);

		expect(updatePublishingTopicAssignees).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["member-1", "member-2"],
		});
	});

	it("rejects a non-member id with BAD_REQUEST and never calls the DB helper", async () => {
		await expect(call(["a-stranger"])).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		expect(updatePublishingTopicAssignees).not.toHaveBeenCalled();
		expect(fanOut.publishingTopicAssigned).not.toHaveBeenCalled();
	});

	it("rejects a mixed array (member + non-member) with BAD_REQUEST", async () => {
		await expect(call(["member-1", "a-stranger"])).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});

		expect(updatePublishingTopicAssignees).not.toHaveBeenCalled();
	});

	it("does NOT grandfather an id that is already assigned but no longer a member — the difference from the contributor endpoint", async () => {
		// The topic already carries `former-member`; the contributor endpoint
		// would allow it back through on a resubmit, and this one must not.
		// Every assignee id passed THIS check when it was written, so a
		// non-member id means the person left — dropping them is correct.
		dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);

		await expect(call(["member-1", "former-member"])).rejects.toMatchObject(
			{ code: "BAD_REQUEST" },
		);

		expect(updatePublishingTopicAssignees).not.toHaveBeenCalled();
	});

	it("allows the caller to assign THEMSELVES — the ask was to be able to exclude yourself, not to be unable to include yourself", async () => {
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
			topic: { id: "topic-1", title: "A topic" },
			addedUserIds: ["actor-1"],
		});

		await call(["actor-1"]);

		expect(updatePublishingTopicAssignees).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: ["actor-1"],
		});
	});

	it("accepts [] as 'nobody' and still reaches the DB helper — there is no null reset to confuse it with", async () => {
		await call([]);

		// No ids to check, so the roster read is skipped entirely.
		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(updatePublishingTopicAssignees).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			assigneeUserIds: [],
		});
	});

	it("notifies exactly the NEWLY added ids, with a context-relative topic link", async () => {
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
			topic: { id: "topic-1", title: "A topic" },
			addedUserIds: ["member-2"],
		});

		await call(["member-1", "member-2"]);

		await vi.waitFor(() => {
			expect(fanOut.publishingTopicAssigned).toHaveBeenCalled();
		});
		expect(fanOut.publishingTopicAssigned).toHaveBeenCalledWith({
			recipientUserIds: ["member-2"],
			topicId: "topic-1",
			topicTitle: "A topic",
			projectId: "project-1",
			organizationId: "org-1",
			actorUserId: "actor-1",
			actorName: "Ada",
			// No leading slash and no org slug: the bell prepends the
			// notification's OWN workspace base.
			link: "projects/project-1/publishing/topic-1",
		});
	});

	it("notifies NOBODY when the save only removes someone", async () => {
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
			topic: { id: "topic-1", title: "A topic" },
			addedUserIds: [],
		});

		await call(["member-1"]);
		await drainFanOut();

		expect(fanOut.publishingTopicAssigned).not.toHaveBeenCalled();
	});

	it("takes the notification's tenant from the PROJECT, never from caller-supplied organizationId", async () => {
		flagMocks.resolveProjectTenant.mockResolvedValue({
			organizationId: "org-from-project",
			userId: "u1",
		});
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
			topic: { id: "topic-1", title: "A topic" },
			addedUserIds: ["member-2"],
		});

		await handler({
			input: {
				...BASE_INPUT,
				organizationId: "org-the-caller-typed",
				assigneeUserIds: ["member-2"],
			},
			context: CONTEXT,
		});

		await vi.waitFor(() => {
			expect(fanOut.publishingTopicAssigned).toHaveBeenCalled();
		});
		expect(fanOut.publishingTopicAssigned).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: "org-from-project" }),
		);
	});

	it("still returns the topic when the notification fan-out throws — an FYI must never fail the write", async () => {
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue({
			topic: { id: "topic-1", title: "A topic" },
			addedUserIds: ["member-2"],
		});
		notifyMocks.publishingTopicAssigned.mockRejectedValue(
			new Error("bell is down"),
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(call(["member-2"])).resolves.toEqual({
			topic: { id: "topic-1", title: "A topic" },
		});
		await drainFanOut();

		// The rejection was caught and logged, not left unhandled.
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("surfaces a missing topic as NOT_FOUND and notifies nobody", async () => {
		dbMocks.updatePublishingTopicAssignees.mockResolvedValue(null);

		await expect(call(["member-1"])).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await drainFanOut();
		expect(fanOut.publishingTopicAssigned).not.toHaveBeenCalled();
	});
});
