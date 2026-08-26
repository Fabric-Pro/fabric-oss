import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the `maybeEnqueueAutoPush` helper exported from move-story.
 *
 * Guards under test:
 *  1. Enqueues when: toggle on AND externalId set AND status != CONFLICT
 *  2. Skips when lastPmSyncStatus === CONFLICT
 *  3. Skips when project.autoPushPmSync === false
 *  4. Skips when story has no externalId
 *  5. Enqueue failure is swallowed (does not throw)
 *
 * Uses the same mocking conventions as pm-sync-procedures.test.ts:
 * modules are mocked via vi.hoisted + vi.mock before any import, and
 * the subject module (move-story) is imported after all mocks are set up.
 */

const { mocks } = vi.hoisted(() => {
	const mocks = {
		projectFindUnique: vi.fn(),
		storyFindUnique: vi.fn(),
		storyFindFirst: vi.fn(),
		enqueuePmSync: vi
			.fn()
			.mockResolvedValue({ enqueued: true, workflowId: "wf_1" }),
		moveStory: vi.fn().mockResolvedValue({
			id: "story_1",
			status: { name: "In Progress" },
		}),
	};
	return { mocks };
});

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findFirst: vi.fn(),
			findUnique: mocks.projectFindUnique,
		},
		userStory: {
			findFirst: mocks.storyFindFirst,
			findUnique: mocks.storyFindUnique,
		},
		projectStoryStatus: {
			findUnique: vi.fn(),
		},
	},
	moveStory: mocks.moveStory,
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: vi.fn() },
	})),
}));

// Stub notification-service so @repo/database mock doesn't need full enum surface
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		storyStatusChanged: vi.fn().mockResolvedValue(undefined),
		mention: vi.fn(),
		reply: vi.fn(),
		assigned: vi.fn(),
	},
}));

vi.mock("../../../agent-deployments/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/story-automations", () => ({
	fireColumnAutomations: vi.fn().mockResolvedValue(undefined),
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
		resolveOrganizationId: () => null,
	};
});

// Import subject after mocks are registered
const { maybeEnqueueAutoPush } = await import("../move-story");

describe("maybeEnqueueAutoPush", () => {
	beforeEach(() => {
		mocks.enqueuePmSync.mockClear();
		mocks.enqueuePmSync.mockResolvedValue({
			enqueued: true,
			workflowId: "wf_1",
		});
		mocks.projectFindUnique.mockReset();
		mocks.storyFindUnique.mockReset();
	});

	it("enqueues push when toggle on AND story has externalId AND status != CONFLICT", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			autoPushPmSync: true,
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story_1",
			externalId: "gitlab:1",
			lastPmSyncStatus: "SUCCESS",
		});

		await maybeEnqueueAutoPush({
			projectId: "proj_1",
			storyId: "story_1",
			userId: "user_1",
		});
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith(
			expect.objectContaining({
				itemId: "story_1",
				triggerSource: "auto-push",
			}),
		);
	});

	it("does not enqueue when status is CONFLICT", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			autoPushPmSync: true,
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story_1",
			externalId: "gitlab:1",
			lastPmSyncStatus: "CONFLICT",
		});
		await maybeEnqueueAutoPush({
			projectId: "proj_1",
			storyId: "story_1",
			userId: "user_1",
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("does not enqueue when toggle off", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			autoPushPmSync: false,
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story_1",
			externalId: "gitlab:1",
			lastPmSyncStatus: "SUCCESS",
		});
		await maybeEnqueueAutoPush({
			projectId: "proj_1",
			storyId: "story_1",
			userId: "user_1",
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("does not enqueue when story has no externalId", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			autoPushPmSync: true,
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story_1",
			externalId: null,
			lastPmSyncStatus: "SUCCESS",
		});
		await maybeEnqueueAutoPush({
			projectId: "proj_1",
			storyId: "story_1",
			userId: "user_1",
		});
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("enqueue failure does not throw", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			autoPushPmSync: true,
		});
		mocks.storyFindUnique.mockResolvedValue({
			id: "story_1",
			externalId: "gitlab:1",
			lastPmSyncStatus: "SUCCESS",
		});
		mocks.enqueuePmSync.mockRejectedValueOnce(new Error("temporal down"));
		await expect(
			maybeEnqueueAutoPush({
				projectId: "proj_1",
				storyId: "story_1",
				userId: "user_1",
			}),
		).resolves.toBeUndefined();
	});
});
