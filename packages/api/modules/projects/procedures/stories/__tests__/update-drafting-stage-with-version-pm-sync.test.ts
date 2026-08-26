/**
 * Unit tests for the PM auto-sync gate in
 * `updateDraftingStageWithVersionProcedure`.
 *
 * The CopilotKit confirm-changes endpoint accepts AI-rewritten description
 * and acceptance-criteria. When `pmAutoSyncEnabled` is on for the story,
 * the rewrite must propagate to the linked PM ticket — same as a
 * keyboard-typed description edit going through `update-story.ts`.
 *
 * Mocks `@repo/database`, `enqueuePmSync`, the version-history helpers,
 * and the oRPC procedure base so the handler can be invoked directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		getStoryById: vi.fn(),
		userStoryUpdate: vi.fn(),
		createFeatureVersion: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	getStoryById: mocks.getStoryById,
	createFeatureVersion: mocks.createFeatureVersion,
	db: {
		userStory: {
			update: mocks.userStoryUpdate,
			// Auto-draft eligibility, read only on arrival at Ready for Dev.
			// `null` means "no such feature", so the trigger short-circuits and
			// this suite stays about the PM-sync gate.
			findUnique: vi.fn(async () => null),
		},
	},
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
	GATEWAY_PROVIDERS: [],
	DB_GATEWAY_PROVIDERS: [],
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Reaching Ready for Dev can start a test-case drafting run. Mocked at the
// claim/dispatch boundary so the Temporal client — and the `@repo/ai` graph
// behind it — never loads here; its module-level `setAiUsageRecorder` call
// would otherwise need adding to this file's exhaustive `@repo/database` mock,
// which has no interest in it.
vi.mock("../../../lib/start-test-case-draft", () => ({
	startTestCaseDraft: vi.fn(async () => ({
		started: true,
		jobId: "job-1",
		status: "PENDING",
	})),
}));

vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

// Mock the notification service so importing the SUT does not pull the real
// notification-service graph (@repo/mail / @repo/payments) into the test.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { subscriptionUpdate: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateStage = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		tenantProtectedProcedure: chainable,
		Permissions,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

await import("../update-drafting-stage-with-version");

const ctx = {
	user: { id: "user-1" },
	session: { id: "s-1", activeOrganizationId: null },
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.createFeatureVersion.mockResolvedValue({});
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf_test",
	});
});

describe("updateDraftingStageWithVersionProcedure pmAutoHidden marker (Task 6)", () => {
	it("writes pmAutoHidden: false when updating story stage (marker-clear on any manual stage write)", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-marker",
			version: 2,
			description: "desc",
			acceptanceCriteria: null,
			draftingStage: "DRAFTING",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-marker",
			pmAutoSyncEnabled: false,
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-marker",
				organizationId: null,
				targetStage: "CLOSED",
			},
			context: ctx,
		});

		expect(mocks.userStoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					pmAutoHidden: false,
				}),
			}),
		);
	});
});

describe("updateDraftingStageWithVersionProcedure PM sync gate", () => {
	it("pmAutoSyncEnabled=true + description provided → enqueuePmSync called", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-sync",
			version: 1,
			description: "old",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-sync",
			pmAutoSyncEnabled: true,
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-sync",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: "AI-enhanced description",
				acceptanceCriteria: null,
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith({
			itemId: "story-sync",
			itemType: "story",
			projectId: "project-1",
			userId: "user-1",
			triggerSource: "manual-edit",
		});
	});

	it("pmAutoSyncEnabled=true + acceptanceCriteria provided → enqueuePmSync called", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-ac",
			version: 1,
			description: "x",
			acceptanceCriteria: "old",
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-ac",
			pmAutoSyncEnabled: true,
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-ac",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: undefined,
				acceptanceCriteria: "new AC",
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
	});

	it("pmAutoSyncEnabled=false → enqueuePmSync NOT called", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-no-sync",
			version: 1,
			description: "old",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-no-sync",
			pmAutoSyncEnabled: false,
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-no-sync",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: "new",
				acceptanceCriteria: null,
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true but neither description nor AC provided → enqueuePmSync NOT called (stage-only change)", async () => {
		// Drafting-stage transitions without content edits (e.g. mark
		// PUBLISHED) are kanban-only metadata; PM tools don't store our
		// drafting-stage so a no-op revision would be noise.
		mocks.getStoryById.mockResolvedValue({
			id: "story-stage-only",
			version: 1,
			description: "x",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});
		mocks.userStoryUpdate.mockResolvedValue({
			id: "story-stage-only",
			pmAutoSyncEnabled: true,
		});

		await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-stage-only",
				organizationId: null,
				targetStage: "PUBLISHED",
			},
			context: ctx,
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true + enqueuePmSync rejects → handler still resolves with the updated story", async () => {
		mocks.getStoryById.mockResolvedValue({
			id: "story-flaky",
			version: 1,
			description: "x",
			acceptanceCriteria: null,
			draftingStage: "DRAFT",
			kind: "FEATURE",
		});
		const updatedRow = {
			id: "story-flaky",
			pmAutoSyncEnabled: true,
		};
		mocks.userStoryUpdate.mockResolvedValue(updatedRow);
		mocks.enqueuePmSync.mockRejectedValueOnce(new Error("temporal down"));

		const result = await handlers.updateStage({
			input: {
				projectId: "project-1",
				storyId: "story-flaky",
				organizationId: null,
				targetStage: "PUBLISHED",
				description: "new",
			},
			context: ctx,
		});

		expect(result).toEqual({ story: updatedRow });
		await new Promise((r) => setImmediate(r));
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"enqueuePmSync failed",
			expect.objectContaining({ storyId: "story-flaky" }),
		);
	});
});
