import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		updateStory: vi.fn(),
		userStoryFindFirst: vi.fn(),
		userStoryUpdate: vi.fn(),
		projectFindUnique: vi.fn(),
		workflowStart: vi.fn(),
		recordAudit: vi.fn(),
		resolvePMConfigForUser: vi.fn(),
		setLastContextUpdateAt: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	updateStory: mocks.updateStory,
	db: {
		userStory: {
			findFirst: mocks.userStoryFindFirst,
			update: mocks.userStoryUpdate,
		},
		project: { findUnique: mocks.projectFindUnique },
	},
	PmSyncStatus: {
		PENDING: "PENDING",
		SUCCESS: "SUCCESS",
		CONFLICT: "CONFLICT",
		FAILED: "FAILED",
	},
	FeatureDraftingStageSchema: z.enum([
		"PLACEHOLDER",
		"PASSIVE_ANALYSIS",
		"ACTIVE_ANALYSIS",
		"SANITY_CHECK",
		"DRAFT",
		"PUBLISHED",
		"DECLINED",
		"CLOSED",
	]),
	MaturationStatusSchema: z.enum(["TO_DO", "DISCOVERY", "DONE"]),
	resolvePMConfigForUser: mocks.resolvePMConfigForUser,
	setLastContextUpdateAt: mocks.setLastContextUpdateAt,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn(async () => ({
		workflow: { start: mocks.workflowStart },
	})),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["updateStory"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { mention: vi.fn(), reply: vi.fn(), assigned: vi.fn() },
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

await import("../update-story");

const ctx = { user: { id: "u-1" }, session: {} };

beforeEach(() => {
	Object.values(mocks).forEach((m) =>
		(m as ReturnType<typeof vi.fn>).mockReset(),
	);
	mocks.resolvePMConfigForUser.mockResolvedValue(null);
	mocks.setLastContextUpdateAt.mockResolvedValue(undefined);
});

describe("update-story procedure — priority rebase + no PM sync", () => {
	it("forwards priority diff to updateStory and does NOT pass roadmapOrder (DB handles rebase)", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			title: "T",
			priority: "P0_CRITICAL",
			pmAutoSyncEnabled: false,
			externalId: null,
		});
		await handlers.updateStory({
			input: {
				projectId: "p-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P0_CRITICAL",
			},
			context: ctx,
		});
		expect(mocks.updateStory).toHaveBeenCalledWith(
			"story-1",
			"p-1",
			expect.objectContaining({ priority: "P0_CRITICAL" }),
			expect.any(Object),
		);
		const [, , dataArg] = mocks.updateStory.mock.calls[0];
		expect(dataArg).not.toHaveProperty("roadmapOrder");
	});

	it("does NOT enqueue PM sync for priority-only change even when story is linked", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			title: "T",
			priority: "P0_CRITICAL",
			pmAutoSyncEnabled: true,
			externalId: "EXT-1",
		});
		await handlers.updateStory({
			input: {
				projectId: "p-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P0_CRITICAL",
			},
			context: ctx,
		});
		await new Promise((r) => setImmediate(r));
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("records audit with priority in changedFields", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			title: "T",
			priority: "P0_CRITICAL",
			pmAutoSyncEnabled: false,
			externalId: null,
		});
		await handlers.updateStory({
			input: {
				projectId: "p-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P0_CRITICAL",
			},
			context: ctx,
		});
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.updated",
				metadata: expect.objectContaining({
					changedFields: expect.arrayContaining(["priority"]),
				}),
			}),
		);
	});
});

describe("update-story procedure — AI context refresh (Fizzy #2211)", () => {
	const story = {
		id: "story-1",
		title: "T",
		priority: "P2_MEDIUM",
		pmAutoSyncEnabled: false,
		externalId: null,
	};

	it("marks a confirmed AI context refresh so it never counts as a person's edit", async () => {
		mocks.updateStory.mockResolvedValue(story);
		await handlers.updateStory({
			input: {
				projectId: "p-1",
				storyId: "story-1",
				organizationId: null,
				description: "Refreshed from new project context",
				isContextUpdate: true,
			},
			context: ctx,
		});

		const [, , , versionContext] = mocks.updateStory.mock.calls[0];
		expect(versionContext).toMatchObject({
			lastEditedSource: "MANUAL",
			aiContextRefresh: true,
		});
	});

	it("leaves an ordinary save counted as the person's edit", async () => {
		mocks.updateStory.mockResolvedValue(story);
		await handlers.updateStory({
			input: {
				projectId: "p-1",
				storyId: "story-1",
				organizationId: null,
				description: "Rewritten by a person",
			},
			context: ctx,
		});

		const [, , , versionContext] = mocks.updateStory.mock.calls[0];
		expect(versionContext.aiContextRefresh).toBe(false);
	});
});
