/**
 * The chat's live roadmap reads (Fizzy #2309/#2310). Pinned here: the access
 * gate (a project the user cannot reach — another organization's included —
 * is refused before any story query runs), the project scoping of every query,
 * the status-name filter the model can actually use, and identifier matching
 * for the forms people type ("F-040", "F40", "40").
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getProjectAccessContext: vi.fn(),
	listStorySummaries: vi.fn(),
	getStoryById: vi.fn(),
	statusFindMany: vi.fn(),
	storyFindMany: vi.fn(),
	storyFindFirst: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: h.getProjectAccessContext,
	listStorySummaries: h.listStorySummaries,
	getStoryById: h.getStoryById,
	db: {
		projectStoryStatus: { findMany: h.statusFindMany },
		userStory: { findMany: h.storyFindMany, findFirst: h.storyFindFirst },
	},
}));

const {
	featureIdentifierCandidates,
	getProjectFeature,
	listProjectFeatures,
	PROJECT_FEATURE_TOOL_IDS,
} = await import("../src/activities/shared/project-feature-reads");

const CTX = { projectId: "p-1", userId: "u-1" };

const summary = {
	id: "s-1",
	identifier: "F-040",
	title: "Checkout",
	kind: "FEATURE",
	status: { id: "st-review", name: "In Review", color: "#000" },
	priority: "P1_HIGH",
	draftingStage: "PUBLISHED",
	taskCount: 3,
	completedTaskCount: 1,
};

const story = {
	id: "s-1",
	identifier: "F-040",
	title: "Checkout",
	kind: "FEATURE",
	status: { name: "In Review", isFinal: false },
	priority: "P1_HIGH",
	size: "M",
	storyPoints: 5,
	draftingStage: "PUBLISHED",
	description: "Pay with a saved card.",
	acceptanceCriteria: "- Given a saved card…",
	externalUrl: null,
	updatedAt: new Date("2026-09-20T00:00:00Z"),
	tasks: [
		{
			identifier: "TASK-001",
			title: "API",
			isCompleted: true,
			description: null,
			subtasks: [],
		},
		{
			identifier: "TASK-002",
			title: "UI",
			isCompleted: false,
			description: "Form",
			subtasks: [{ isCompleted: true }, { isCompleted: false }],
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	h.getProjectAccessContext.mockResolvedValue({ organizationId: "org-1" });
	h.listStorySummaries.mockResolvedValue({ stories: [summary], total: 41 });
	h.storyFindMany.mockResolvedValue([
		{ id: "s-1", description: "Pay with a saved card." },
	]);
	h.statusFindMany.mockResolvedValue([
		{ id: "st-backlog", name: "Backlog" },
		{ id: "st-review", name: "In Review" },
	]);
});

describe("access", () => {
	it("refuses a project the user cannot reach and queries nothing", async () => {
		// getProjectAccessContext answers null for a project in an organization
		// the user is not a member (or invited guest) of.
		h.getProjectAccessContext.mockResolvedValue(null);

		const list = await listProjectFeatures({}, CTX);
		const get = await getProjectFeature({ feature: "F-040" }, CTX);

		expect(list).toEqual({ error: "Project not found or access denied." });
		expect(get).toEqual({ error: "Project not found or access denied." });
		expect(h.getProjectAccessContext).toHaveBeenCalledWith("p-1", "u-1");
		expect(h.listStorySummaries).not.toHaveBeenCalled();
		expect(h.getStoryById).not.toHaveBeenCalled();
		expect(h.storyFindFirst).not.toHaveBeenCalled();
	});

	it("asks for a project when none is attached", async () => {
		const res = await listProjectFeatures({}, { userId: "u-1" });
		expect(res).toMatchObject({
			error: expect.stringContaining("project"),
		});
		expect(h.getProjectAccessContext).not.toHaveBeenCalled();
	});

	it("exports exactly the two read tool ids", () => {
		expect([...PROJECT_FEATURE_TOOL_IDS]).toEqual([
			"fabric_list_project_features",
			"fabric_get_project_feature",
		]);
	});
});

describe("listProjectFeatures", () => {
	it("filters by status NAME, case-insensitively, within the project", async () => {
		const res = await listProjectFeatures(
			{ status: "in review", limit: 10 },
			CTX,
		);

		expect(h.statusFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: "p-1" } }),
		);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "p-1",
				statusId: "st-review",
				limit: 10,
				offset: 0,
			}),
		);
		expect(res).toEqual({
			features: [
				{
					id: "s-1",
					identifier: "F-040",
					title: "Checkout",
					kind: "FEATURE",
					status: "In Review",
					priority: "P1_HIGH",
					draftingStage: "PUBLISHED",
					tasks: "1/3 done",
					description: "Pay with a saved card.",
				},
			],
			total: 41,
			hasMore: true,
		});
	});

	it("scopes the description lookup to the project", async () => {
		await listProjectFeatures({}, CTX);
		expect(h.storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p-1", id: { in: ["s-1"] } },
			}),
		);
	});

	it("names the valid statuses when the requested one does not exist", async () => {
		const res = await listProjectFeatures({ status: "Shipped" }, CTX);
		expect(res).toMatchObject({
			error: expect.stringContaining("Backlog, In Review"),
		});
		expect(h.listStorySummaries).not.toHaveBeenCalled();
	});

	it("clamps the limit and rejects an unknown priority", async () => {
		await listProjectFeatures({ limit: 5000 }, CTX);
		expect(h.listStorySummaries).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 100 }),
		);
		expect(
			await listProjectFeatures({ priority: "URGENT" }, CTX),
		).toMatchObject({ error: expect.stringContaining("priority") });
	});
});

describe("getProjectFeature", () => {
	it("resolves a typed identifier within the project and returns full detail", async () => {
		h.getStoryById.mockImplementation(async (id: string) =>
			id === "s-1" ? story : null,
		);
		h.storyFindFirst.mockResolvedValue({ id: "s-1" });

		const res = await getProjectFeature({ feature: "f40" }, CTX);

		expect(h.getStoryById).toHaveBeenNthCalledWith(1, "f40", "p-1");
		const where = h.storyFindFirst.mock.calls[0][0].where;
		expect(where.projectId).toBe("p-1");
		expect(h.getStoryById).toHaveBeenLastCalledWith("s-1", "p-1");
		expect(res).toMatchObject({
			identifier: "F-040",
			status: "In Review",
			acceptanceCriteria: "- Given a saved card…",
			tasksSummary: "1/2 tasks done",
			tasks: [
				expect.objectContaining({ identifier: "TASK-001" }),
				expect.objectContaining({ subtasks: "1/2 done" }),
			],
		});
	});

	it("says the feature is missing rather than guessing", async () => {
		h.getStoryById.mockResolvedValue(null);
		h.storyFindFirst.mockResolvedValue(null);
		const res = await getProjectFeature({ feature: "F-999" }, CTX);
		expect(res).toMatchObject({ error: expect.stringContaining("F-999") });
	});

	it("requires a feature reference", async () => {
		expect(await getProjectFeature({}, CTX)).toMatchObject({
			error: expect.stringContaining("feature is required"),
		});
	});
});

describe("featureIdentifierCandidates", () => {
	it.each(["F-040", "f40", "40", "040", "F-40"])(
		"%s reaches both legacy and plain-decimal forms",
		(ref) => {
			const candidates = featureIdentifierCandidates(ref);
			expect(candidates).toEqual(
				expect.arrayContaining(["F-040", "40", "040"]),
			);
		},
	);

	it("leaves a non-identifier reference alone", () => {
		expect(featureIdentifierCandidates("cm1abcdef")).toEqual(["cm1abcdef"]);
	});
});
