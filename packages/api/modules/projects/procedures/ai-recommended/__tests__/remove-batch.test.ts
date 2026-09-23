import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	isFeatureEnabled: vi.fn(),
	findMany: vi.fn(),
	txFindFirst: vi.fn(),
	txQueryRaw: vi.fn(),
	transaction: vi.fn(),
	updateStoryDraftingStage: vi.fn(),
	loadProjectStagePolicy: vi.fn(),
	assertCapabilityAvailable: vi.fn(),
	subscriptionUpdate: vi.fn(),
	loggerInfo: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mocks.projectFindUnique },
		userStory: { findMany: mocks.findMany },
		$transaction: mocks.transaction,
	},
	isFeatureEnabled: mocks.isFeatureEnabled,
	loadProjectStagePolicy: mocks.loadProjectStagePolicy,
	updateStoryDraftingStage: mocks.updateStoryDraftingStage,
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

vi.mock("../../../../capabilities/assert", () => ({
	assertCapabilityAvailable: mocks.assertCapabilityAvailable,
}));

vi.mock("../../../lib/stage-transition-errors", () => ({
	mapStageTransitionError: (error: unknown) => error,
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: { subscriptionUpdate: mocks.subscriptionUpdate },
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: mocks.loggerInfo,
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
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
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => input ?? session.activeOrganizationId ?? undefined,
	};
});

import { removeAiRecommendationBatchProcedure } from "../remove-batch";

type RemoveResult = {
	results: Array<{ storyId: string; outcome: string; error?: string }>;
	counts: Record<string, number>;
	governedReview: boolean;
};
type Handler = (args: {
	input: Record<string, unknown>;
	context: {
		user: { id: string; name: string };
		session: { activeOrganizationId: string };
	};
}) => Promise<RemoveResult>;

const handler = (
	removeAiRecommendationBatchProcedure as unknown as { _handler: Handler }
)._handler;

function story(id: string) {
	return { id, identifier: `F-${id}`, title: `Title ${id}` };
}

/** What each predicate / id lookup returns for this test. */
let lists: {
	eligible: string[];
	protected: string[];
	awaiting: string[];
};

function remove(expectedStoryIds: string[]) {
	return handler({
		input: { projectId: "project-1", batchId: "batch-1", expectedStoryIds },
		context: {
			user: { id: "user-1", name: "Example Editor" },
			session: { activeOrganizationId: "org-session" },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	lists = { eligible: ["a", "b"], protected: [], awaiting: [] };
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.assertCapabilityAvailable.mockResolvedValue(null);
	mocks.loadProjectStagePolicy.mockResolvedValue({ reviewRequired: false });
	mocks.subscriptionUpdate.mockResolvedValue(undefined);
	mocks.findMany.mockImplementation(
		async ({
			where,
		}: {
			where: { predicate?: string; id?: { in: string[] } };
		}) => {
			if (where.id) {
				return where.id.in.map(story);
			}
			const ids =
				where.predicate === "eligible"
					? lists.eligible
					: where.predicate === "protected"
						? lists.protected
						: lists.awaiting;
			return ids.map(story);
		},
	);
	mocks.txFindFirst.mockImplementation(
		async ({ where }: { where: { id: string } }) =>
			lists.eligible.includes(where.id) ? { id: where.id } : null,
	);
	mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
		fn({
			userStory: { findFirst: mocks.txFindFirst },
			$queryRaw: mocks.txQueryRaw,
		}),
	);
	mocks.updateStoryDraftingStage.mockImplementation(async (id: string) => ({
		id,
		draftingStage: "CLOSED",
	}));
});

describe("projects.aiRecommended.removeBatch", () => {
	it("answers NOT_FOUND when the lifecycle flag is off, before the gate or any read", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(remove(["a"])).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
			"AI_RECOMMENDED_LIFECYCLE",
			"org-1",
		);
		expect(mocks.assertCapabilityAvailable).not.toHaveBeenCalled();
		expect(mocks.findMany).not.toHaveBeenCalled();
	});

	it("asserts the removal capability with the project's organization before any write", async () => {
		mocks.assertCapabilityAvailable.mockRejectedValue(
			Object.assign(new Error("refused"), {
				code: "PRECONDITION_FAILED",
			}),
		);

		await expect(remove(["a"])).rejects.toThrow("refused");
		expect(mocks.assertCapabilityAvailable).toHaveBeenCalledWith({
			capabilityKey: "roadmap.remove-ai-recommended",
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(mocks.updateStoryDraftingStage).not.toHaveBeenCalled();
	});

	it("refuses with NO_ELIGIBLE_ITEMS and the counts that explain why when nothing previewed is eligible", async () => {
		lists = { eligible: [], protected: ["p"], awaiting: ["r"] };

		await expect(remove(["p", "r", "gone"])).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			data: {
				reason: "NO_ELIGIBLE_ITEMS",
				protectedCount: 1,
				alreadyRequestedCount: 1,
				ineligibleCount: 1,
			},
		});
		expect(mocks.updateStoryDraftingStage).not.toHaveBeenCalled();
	});

	it("hides only previewed eligible items and reports the rest as not previewed", async () => {
		lists.eligible = ["a", "b", "late"];

		const result = await remove(["a", "b"]);

		const touched = mocks.updateStoryDraftingStage.mock.calls.map(
			([id]) => id,
		);
		expect(touched).toEqual(["a", "b"]);
		expect(result.counts).toMatchObject({ moved: 2, notPreviewed: 1 });
	});

	it("hides each item through the stage choke point in its own transaction, as the person", async () => {
		await remove(["a", "b"]);

		expect(mocks.transaction).toHaveBeenCalledTimes(2);
		expect(mocks.updateStoryDraftingStage).toHaveBeenCalledWith(
			"a",
			"project-1",
			"CLOSED",
			{
				userId: "user-1",
				organizationId: "org-1",
				changedBy: "user-1",
				lastEditedByName: "Example Editor",
				lastEditedSource: "MANUAL",
				transitionReason: "manual",
			},
			expect.objectContaining({ userStory: expect.anything() }),
		);
	});

	it("reports each item as requested on a governed project, and still notifies watchers", async () => {
		mocks.loadProjectStagePolicy.mockResolvedValue({
			reviewRequired: true,
		});
		mocks.updateStoryDraftingStage.mockImplementation(
			async (id: string) => ({
				id,
				pendingStageRequestId: `req-${id}`,
			}),
		);

		const result = await remove(["a", "b"]);

		expect(result.governedReview).toBe(true);
		expect(result.results.map((r) => r.outcome)).toEqual([
			"requested",
			"requested",
		]);
		expect(result.counts).toMatchObject({ moved: 0, requested: 2 });
		expect(mocks.subscriptionUpdate).toHaveBeenCalledTimes(2);
		expect(mocks.subscriptionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				subjectType: "FEATURE",
				subjectId: "a",
				changeKind: "stage",
				organizationId: "org-1",
			}),
		);
	});

	it("records one failing item as failed and carries on with the rest", async () => {
		mocks.updateStoryDraftingStage.mockImplementation(
			async (id: string) => {
				if (id === "a") {
					throw new Error("This feature is not ready");
				}
				return { id };
			},
		);

		const result = await remove(["a", "b"]);

		expect(result.results).toEqual([
			expect.objectContaining({
				storyId: "a",
				outcome: "failed",
				error: "This feature is not ready",
			}),
			expect.objectContaining({ storyId: "b", outcome: "moved" }),
		]);
		expect(result.counts).toMatchObject({ moved: 1, failed: 1 });
		expect(mocks.subscriptionUpdate).toHaveBeenCalledTimes(1);
	});

	it("reports items already awaiting approval on a retry without touching them again", async () => {
		lists = { eligible: ["b"], protected: [], awaiting: ["a"] };

		const result = await remove(["a", "b"]);

		expect(mocks.updateStoryDraftingStage).toHaveBeenCalledTimes(1);
		expect(mocks.updateStoryDraftingStage.mock.calls[0][0]).toBe("b");
		expect(result.results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					storyId: "a",
					outcome: "already-requested",
				}),
			]),
		);
		expect(result.counts).toMatchObject({ alreadyRequested: 1, moved: 1 });
	});

	it("skips an item protected between the preview and the click", async () => {
		mocks.txFindFirst.mockImplementation(
			async ({ where }: { where: { id: string } }) =>
				where.id === "a" ? null : { id: where.id },
		);

		const result = await remove(["a", "b"]);

		expect(mocks.updateStoryDraftingStage).toHaveBeenCalledTimes(1);
		expect(result.counts).toMatchObject({ skippedIneligible: 1, moved: 1 });
		expect(mocks.subscriptionUpdate).toHaveBeenCalledTimes(1);
	});

	it("locks each story row before re-checking it, so a concurrent protect cannot slip between", async () => {
		const order: string[] = [];
		mocks.txQueryRaw.mockImplementation(
			async (strings: TemplateStringsArray, ...values: unknown[]) => {
				order.push(`lock:${values[0]}`);
				expect(strings.join("?")).toMatch(
					/SELECT id FROM user_story WHERE id = \? AND "projectId" = \? FOR UPDATE/,
				);
				expect(values).toEqual([values[0], "project-1"]);
				return [{ id: values[0] }];
			},
		);
		mocks.txFindFirst.mockImplementation(
			async ({ where }: { where: { id: string } }) => {
				order.push(`check:${where.id}`);
				return { id: where.id };
			},
		);

		await remove(["a", "b"]);

		expect(order).toEqual(["lock:a", "check:a", "lock:b", "check:b"]);
	});

	it("logs the batch removal with its counts", async () => {
		lists.protected = ["p"];

		await remove(["a", "b", "p"]);

		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			"[AiRecommended] Batch removal",
			{
				projectId: "project-1",
				batchId: "batch-1",
				userId: "user-1",
				counts: {
					moved: 2,
					requested: 0,
					alreadyRequested: 0,
					skippedProtected: 1,
					skippedIneligible: 0,
					failed: 0,
					notPreviewed: 0,
				},
			},
		);
	});
});
