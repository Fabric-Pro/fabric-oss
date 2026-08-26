/**
 * Integration tests for write-time preference filtering in the in-database
 * notification writers (the bypass paths that don't route through the
 * @repo/api `createNotification` chokepoint). Exercises the REAL
 * preference-query functions against a mocked Prisma client, so the
 * category→toggle wiring is validated end to end.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { create, prefFindUnique, prefFindMany } = vi.hoisted(() => ({
	create: vi.fn(),
	prefFindUnique: vi.fn(),
	prefFindMany: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	NotificationCategory: {
		MENTION: "MENTION",
		REPLY: "REPLY",
		ASSIGNMENT: "ASSIGNMENT",
		STATUS: "STATUS",
		AGENT: "AGENT",
		PROJECT: "PROJECT",
		SYSTEM: "SYSTEM",
		BILLING: "BILLING",
		CONTEXT_INDEXING_STARTED: "CONTEXT_INDEXING_STARTED",
		CONTEXT_INDEXING_COMPLETED: "CONTEXT_INDEXING_COMPLETED",
	},
	NotificationType: {
		AGENT_REPLY_READY: "AGENT_REPLY_READY",
		PM_SYNC_CONFLICT: "PM_SYNC_CONFLICT",
		REPO_INTEGRATION_TOKEN_EXPIRED: "REPO_INTEGRATION_TOKEN_EXPIRED",
	},
	db: {
		notification: { create },
		notificationPreference: {
			findUnique: prefFindUnique,
			findMany: prefFindMany,
		},
	},
}));

import { createAgentReplyReadyNotifications } from "../prisma/queries/agent-reply-notifications";
import { createPmSyncConflictNotifications } from "../prisma/queries/pm-conflict-notifications";

beforeEach(() => {
	vi.clearAllMocks();
	create.mockResolvedValue({});
	prefFindUnique.mockResolvedValue(null); // default-on
	prefFindMany.mockResolvedValue([]); // default-on for all recipients
});

describe("agent-reply notifications respect the AI/Agent toggle", () => {
	const baseArgs = {
		runId: "run1",
		recipientUserId: "user-a",
		organizationId: null,
		agentName: "Loom",
		finalMessage: "Done",
		link: "projects/p1",
		projectId: "p1",
	};

	it("writes the row when the category is enabled (default-on)", async () => {
		await createAgentReplyReadyNotifications(baseArgs);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("suppresses the row when the recipient disabled aiAgent", async () => {
		prefFindUnique.mockResolvedValue({
			mentions: true,
			replies: true,
			assignments: true,
			status: true,
			syncProject: true,
			aiAgent: false,
		});
		await createAgentReplyReadyNotifications(baseArgs);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("pm-sync conflict notifications respect the Sync/Project toggle", () => {
	const baseArgs = {
		storyId: "s1",
		storyTitle: "Story 1",
		projectId: "p1",
		organizationId: null,
		actorUserId: null,
		pendingStateChangeId: "psc1",
		previousState: "Open",
		newState: "Closed",
		recipientUserIds: ["a", "b"],
		link: "projects/p1/stories/s1",
	};

	it("drops only recipients who disabled syncProject", async () => {
		// b disabled syncProject; a has no row (default-on).
		prefFindMany.mockResolvedValue([{ userId: "b", syncProject: false }]);

		await createPmSyncConflictNotifications(baseArgs);

		expect(create).toHaveBeenCalledTimes(1);
		expect(create.mock.calls[0][0].data.userId).toBe("a");
	});

	it("writes to all recipients when none disabled the category", async () => {
		await createPmSyncConflictNotifications(baseArgs);
		expect(create).toHaveBeenCalledTimes(2);
	});
});
