import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	isFeatureEnabled: vi.fn(),
	findMany: vi.fn(),
	loadProjectStagePolicy: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { findMany: mocks.findMany },
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
	loadProjectStagePolicy: mocks.loadProjectStagePolicy,
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

import { previewAiRecommendationBatchProcedure } from "../preview-batch";

type Handler = (args: {
	input: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const handler = (
	previewAiRecommendationBatchProcedure as unknown as { _handler: Handler }
)._handler;

function item(id: string, edited = false) {
	return {
		id,
		identifier: `F-${id}`,
		title: `Title ${id}`,
		firstHumanEditAt: edited ? new Date("2026-09-02T00:00:00.000Z") : null,
	};
}

function preview() {
	return handler({ input: { projectId: "project-1", batchId: "batch-1" } });
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.loadProjectStagePolicy.mockResolvedValue({ reviewRequired: true });
	mocks.findMany.mockImplementation(
		async ({ where }: { where: { predicate: string } }) => {
			if (where.predicate === "eligible") {
				return [item("1", true), item("2")];
			}
			if (where.predicate === "protected") {
				// A protected item that was edited never counts as edited.
				return [item("3", true)];
			}
			return [item("4", true)];
		},
	);
});

describe("projects.aiRecommended.previewBatch", () => {
	it("answers NOT_FOUND when the lifecycle flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(preview()).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("reads each list through the shared predicate for the requested batch", async () => {
		await preview();

		const wheres = mocks.findMany.mock.calls.map(([args]) => args.where);
		expect(wheres).toEqual([
			{
				predicate: "eligible",
				projectId: "project-1",
				batchId: "batch-1",
			},
			{
				predicate: "protected",
				projectId: "project-1",
				batchId: "batch-1",
			},
			{
				predicate: "awaiting",
				projectId: "project-1",
				batchId: "batch-1",
			},
		]);
		for (const [args] of mocks.findMany.mock.calls) {
			expect(args.take).toBe(200);
		}
	});

	it("counts only eligible items as edited, and passes governed review through", async () => {
		const result = await preview();

		expect(result).toEqual({
			eligible: [
				{ id: "1", identifier: "F-1", title: "Title 1", edited: true },
				{ id: "2", identifier: "F-2", title: "Title 2", edited: false },
			],
			protected: [expect.objectContaining({ id: "3" })],
			awaitingApproval: [expect.objectContaining({ id: "4" })],
			editedEligibleCount: 1,
			governedReview: true,
		});
	});
});
