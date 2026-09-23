import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	isFeatureEnabled: vi.fn(),
	storyUpdateMany: vi.fn(),
	storyFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: {
			updateMany: mocks.storyUpdateMany,
			findFirst: mocks.storyFindFirst,
		},
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	Object.assign(chain, {
		use: () => chain,
		route: () => chain,
		input: () => chain,
		output: () => chain,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	});
	return {
		tenantProtectedProcedure: chain,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => ({}),
	};
});

import { protectAiRecommendedItemProcedure } from "../protect";

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string } };
}) => Promise<{
	protectedAt: Date;
	protectedById: string;
	alreadyProtected: boolean;
}>;

const handler = (
	protectAiRecommendedItemProcedure as unknown as { _handler: Handler }
)._handler;

const PROTECTED_AT = new Date("2026-09-20T10:00:00.000Z");

function protect() {
	return handler({
		input: { projectId: "project-1", storyId: "story-1" },
		context: { user: { id: "user-1" } },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.storyUpdateMany.mockResolvedValue({ count: 1 });
	mocks.storyFindFirst.mockResolvedValue({
		source: "AI_RECOMMENDED",
		aiRecommendationBatchId: "batch-1",
		aiBatchProtectedAt: PROTECTED_AT,
		aiBatchProtectedById: "user-1",
	});
});

describe("projects.aiRecommended.protect", () => {
	it("answers NOT_FOUND and writes nothing when the lifecycle flag is off for the project's organization", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(protect()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"AI_RECOMMENDED_LIFECYCLE",
			"org-1",
		);
		expect(mocks.storyUpdateMany).not.toHaveBeenCalled();
	});

	it("writes only the two protection columns, scoped to the project and to unprotected batch items", async () => {
		const result = await protect();

		const call = mocks.storyUpdateMany.mock.calls[0][0];
		expect(call.where).toEqual({
			id: "story-1",
			projectId: "project-1",
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: { not: null },
			aiBatchProtectedAt: null,
		});
		expect(Object.keys(call.data).sort()).toEqual([
			"aiBatchProtectedAt",
			"aiBatchProtectedById",
		]);
		expect(call.data.aiBatchProtectedById).toBe("user-1");
		expect(result).toEqual({
			protectedAt: PROTECTED_AT,
			protectedById: "user-1",
			alreadyProtected: false,
		});
	});

	it("refuses an item that did not come from a recommendation batch", async () => {
		mocks.storyUpdateMany.mockResolvedValue({ count: 0 });
		mocks.storyFindFirst.mockResolvedValue({
			source: "MANUAL",
			aiRecommendationBatchId: null,
			aiBatchProtectedAt: null,
			aiBatchProtectedById: null,
		});

		await expect(protect()).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	it("is idempotent for an item already protected, keeping the original protector", async () => {
		mocks.storyUpdateMany.mockResolvedValue({ count: 0 });
		mocks.storyFindFirst.mockResolvedValue({
			source: "AI_RECOMMENDED",
			aiRecommendationBatchId: "batch-1",
			aiBatchProtectedAt: PROTECTED_AT,
			aiBatchProtectedById: "user-9",
		});

		await expect(protect()).resolves.toEqual({
			protectedAt: PROTECTED_AT,
			protectedById: "user-9",
			alreadyProtected: true,
		});
	});

	it("answers NOT_FOUND for a story outside the project", async () => {
		mocks.storyUpdateMany.mockResolvedValue({ count: 0 });
		mocks.storyFindFirst.mockResolvedValue(null);

		await expect(protect()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.storyFindFirst.mock.calls[0][0].where).toEqual({
			id: "story-1",
			projectId: "project-1",
		});
	});
});
