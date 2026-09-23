import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	isFeatureEnabled: vi.fn(),
	groupBy: vi.fn(),
}));

// The predicate builders are tagged stand-ins, so each read can be traced to
// the shared builder (and the batch) it used.
vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { groupBy: mocks.groupBy },
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
	aiRecommendedEligibleWhere: (projectId: string, batchId?: string) => ({
		predicate: "eligible",
		projectId,
		batchId,
	}),
	aiRecommendedProtectedWhere: (projectId: string, batchId?: string) => ({
		predicate: "protected",
		projectId,
		batchId,
	}),
	aiRecommendedAwaitingApprovalWhere: (
		projectId: string,
		batchId?: string,
	) => ({ predicate: "awaiting", projectId, batchId }),
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

import { listAiRecommendationBatchesProcedure } from "../list-batches";

type Handler = (args: { input: Record<string, unknown> }) => Promise<{
	batches: Array<Record<string, unknown>>;
}>;

const handler = (
	listAiRecommendationBatchesProcedure as unknown as { _handler: Handler }
)._handler;

const OLDER = new Date("2026-09-01T00:00:00.000Z");
const NEWER = new Date("2026-09-10T00:00:00.000Z");

type Where = { predicate?: string; firstHumanEditAt?: unknown };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.groupBy.mockImplementation(async ({ where }: { where: Where }) => {
		if (where.predicate === "eligible" && where.firstHumanEditAt) {
			return [
				{ aiRecommendationBatchId: "batch-old", _count: { _all: 1 } },
			];
		}
		if (where.predicate === "eligible") {
			return [
				{
					aiRecommendationBatchId: "batch-old",
					_count: { _all: 3 },
					_min: { createdAt: OLDER },
				},
				{
					aiRecommendationBatchId: "batch-new",
					_count: { _all: 2 },
					_min: { createdAt: NEWER },
				},
			];
		}
		if (where.predicate === "protected") {
			return [
				{ aiRecommendationBatchId: "batch-new", _count: { _all: 4 } },
				// A batch whose every item is protected is not listed.
				{ aiRecommendationBatchId: "batch-done", _count: { _all: 5 } },
			];
		}
		return [{ aiRecommendationBatchId: "batch-old", _count: { _all: 2 } }];
	});
});

describe("projects.aiRecommended.listBatches", () => {
	it("answers NOT_FOUND when the lifecycle flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			handler({ input: { projectId: "project-1" } }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.groupBy).not.toHaveBeenCalled();
	});

	it("lists only batches with an eligible item, newest first, with their counts", async () => {
		const { batches } = await handler({
			input: { projectId: "project-1" },
		});

		expect(batches).toEqual([
			{
				batchId: "batch-new",
				createdAt: NEWER,
				eligibleCount: 2,
				editedEligibleCount: 0,
				protectedCount: 4,
				awaitingApprovalCount: 0,
			},
			{
				batchId: "batch-old",
				createdAt: OLDER,
				eligibleCount: 3,
				editedEligibleCount: 1,
				protectedCount: 0,
				awaitingApprovalCount: 2,
			},
		]);
	});

	it("reads every count through the shared predicates, across all batches", async () => {
		await handler({ input: { projectId: "project-1" } });

		const wheres = mocks.groupBy.mock.calls.map(([args]) => args.where);
		expect(wheres).toEqual(
			expect.arrayContaining([
				{
					predicate: "eligible",
					projectId: "project-1",
					batchId: undefined,
				},
				{
					predicate: "eligible",
					projectId: "project-1",
					batchId: undefined,
					firstHumanEditAt: { not: null },
				},
				{
					predicate: "protected",
					projectId: "project-1",
					batchId: undefined,
				},
				{
					predicate: "awaiting",
					projectId: "project-1",
					batchId: undefined,
				},
			]),
		);
		expect(wheres).toHaveLength(4);
	});
});
