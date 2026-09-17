/**
 * moveStoryProcedure — column automations fire only for a real transition.
 *
 * `fireColumnAutomations` starts a real orchestrator run (a mutating skill,
 * billed AI calls). The handler used to call it after every successful move,
 * including a reorder within the current column, before it compared the old
 * and new status. Now it runs inside the same status-changed gate as the
 * lifecycle event and the audit row, and hands the automation the transition
 * (from, to, when) that keys the run's idempotent workflow id.
 *
 * Run with: pnpm --filter @repo/api test -- move-story-column-automations
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		storyFindFirst: vi.fn(),
		storyFindUnique: vi.fn(),
		projectFindUnique: vi.fn(),
		statusFindUnique: vi.fn(),
		moveStory: vi.fn(),
		fireColumnAutomations: vi.fn().mockResolvedValue(undefined),
		dispatchLifecycleEvent: vi.fn().mockResolvedValue(undefined),
		recordAuditFromRequest: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: {
			findFirst: mocks.storyFindFirst,
			findUnique: mocks.storyFindUnique,
		},
		projectStoryStatus: { findUnique: mocks.statusFindUnique },
	},
	moveStory: mocks.moveStory,
	PmSyncStatus: { PENDING: "PENDING", SUCCESS: "SUCCESS" },
}));

// The real barrels drag in the Temporal SDK and the payments recorder; nothing
// here reaches either.
vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({ workflow: { start: vi.fn() } })),
}));
vi.mock("@repo/payments", () => ({}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue({ enqueued: false }),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		storyStatusChanged: vi.fn().mockResolvedValue(undefined),
		subscriptionUpdate: vi.fn().mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: mocks.dispatchLifecycleEvent,
}));

vi.mock("../../../lib/story-automations", () => ({
	fireColumnAutomations: mocks.fireColumnAutomations,
}));

vi.mock("../../../lib/strip-internal-story-fields", () => ({
	stripInternalStoryFields: (story: unknown) => story,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => ({}),
		resolveOrganizationId: () => "org-a",
	};
});

const { moveStoryProcedure } = await import("../move-story");
const handler = (
	moveStoryProcedure as unknown as {
		_handler: (args: {
			input: Record<string, unknown>;
			context: Record<string, unknown>;
		}) => Promise<unknown>;
	}
)._handler;

const EDIT_CLOCK = new Date("2026-09-16T12:00:00.000Z");

function movedStory(statusId: string, name: string) {
	return {
		id: "story-1",
		title: "Add login",
		identifier: "F-001",
		statusId,
		status: { id: statusId, name },
		lastEditedAt: EDIT_CLOCK,
		updatedAt: new Date("2026-09-16T12:00:00.500Z"),
		tasks: [],
	};
}

async function move(statusId: string) {
	return handler({
		input: {
			projectId: "project-1",
			storyId: "story-1",
			statusId,
			organizationId: "org-a",
		},
		context: {
			user: { id: "user-1", name: "Ada" },
			session: { activeOrganizationId: "org-a" },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		name: "Portal",
		userId: "owner-1",
		autoPushPmSync: false,
	});
	mocks.statusFindUnique.mockResolvedValue({
		name: "Triage",
		isFinal: false,
		requiresApproval: false,
	});
	mocks.storyFindUnique.mockResolvedValue({
		title: "Add login",
		assigneeId: null,
		externalId: null,
	});
});

describe("moveStoryProcedure — column automations", () => {
	it("does not fire for a reorder within the current column", async () => {
		mocks.storyFindFirst.mockResolvedValue({ statusId: "status-triage" });
		mocks.moveStory.mockResolvedValue(
			movedStory("status-triage", "Triage"),
		);

		await move("status-triage");

		expect(mocks.moveStory).toHaveBeenCalledTimes(1);
		expect(mocks.fireColumnAutomations).not.toHaveBeenCalled();
		// Same gate as the rest of the status-changed side effects.
		expect(mocks.dispatchLifecycleEvent).not.toHaveBeenCalled();
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
	});

	it("fires once for a lane change, carrying the transition that keys the run", async () => {
		mocks.storyFindFirst.mockResolvedValue({ statusId: "status-backlog" });
		mocks.moveStory.mockResolvedValue(
			movedStory("status-triage", "Triage"),
		);

		await move("status-triage");

		expect(mocks.fireColumnAutomations).toHaveBeenCalledTimes(1);
		expect(mocks.fireColumnAutomations).toHaveBeenCalledWith({
			storyId: "story-1",
			storyTitle: "Add login",
			storyIdentifier: "F-001",
			projectId: "project-1",
			projectName: "Portal",
			targetColumnName: "Triage",
			fromStatusId: "status-backlog",
			toStatusId: "status-triage",
			// The edit clock the lane change set, not the row's write clock.
			transitionAt: EDIT_CLOCK.toISOString(),
			userId: "user-1",
			organizationId: "org-a",
		});
	});

	it("does not fire when the move itself is rejected", async () => {
		mocks.storyFindFirst.mockResolvedValue({ statusId: "status-backlog" });
		// The concurrent-move loser: moveStory's edit-clock guard throws.
		mocks.moveStory.mockRejectedValue(new Error("version conflict"));

		await expect(move("status-triage")).rejects.toThrow("version conflict");
		expect(mocks.fireColumnAutomations).not.toHaveBeenCalled();
	});
});
