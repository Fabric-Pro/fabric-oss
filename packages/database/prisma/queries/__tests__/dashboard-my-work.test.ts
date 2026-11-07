import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany, count } = vi.hoisted(() => ({
	findMany: vi.fn(),
	count: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		userStory: { findMany, count },
		projectDocument: { findMany, count },
		codingRun: { findMany, count },
		agentTask: { findMany, count },
		project: { findMany, count },
		projectUserPreference: { findMany },
	},
	Prisma: {},
}));

import { getMyWork } from "../dashboard-my-work";

const NOW = new Date("2026-11-05T12:00:00.000Z");

async function callOrgWork(
	featureStage?: "readyForDev" | "implementing" | "review" | "blocked",
) {
	return getMyWork({
		userId: "user-1",
		organizationId: "org-1",
		organizationSlug: "example-org",
		limit: 1,
		featureStage,
		now: NOW,
	});
}

describe("getMyWork", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findMany.mockResolvedValue([]);
		count.mockResolvedValue(2);
	});

	it("scopes every project-backed source to current project reach", async () => {
		await callOrgWork();

		const expectedProjectScope = {
			organizationId: "org-1",
			deletedAt: null,
			OR: [
				{ userId: "user-1" },
				{
					members: {
						some: {
							userId: "user-1",
							acceptedAt: { not: null },
							OR: [
								{ expiresAt: null },
								{ expiresAt: { gt: NOW } },
							],
						},
					},
				},
			],
		};
		const projectScopedCalls = findMany.mock.calls.filter(
			([input]) => input.where?.project,
		);
		expect(projectScopedCalls.length).toBeGreaterThan(0);
		for (const [input] of projectScopedCalls) {
			expect(input.where.project).toEqual(expectedProjectScope);
		}
	});

	it("limits documents to the caller's own work", async () => {
		await callOrgWork();
		const documentCall = findMany.mock.calls.find(
			([input]) => input.where?.status === "REVIEW",
		);
		expect(documentCall?.[0].where?.OR).toEqual([
			{ userId: "user-1" },
			{ lastEditedBy: "user-1" },
		]);
	});

	it("includes watchdog-stale failures and scopes runs to the caller", async () => {
		await callOrgWork();
		expect(count).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					status: { in: ["FAILED", "TERMINATED_STALE"] },
				}),
			}),
		);
	});

	it("filters assigned features on the server by delivery stage", async () => {
		await callOrgWork("readyForDev");
		expect(count).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ draftingStage: "PUBLISHED" }),
			}),
		);
	});

	it.each([
		["implementing", ["QUEUED", "STARTING", "RUNNING"]],
		["review", ["AWAITING_REVIEW", "PR_OPENED", "DEMO_READY"]],
	] as const)(
		"filters %s features by their coding-run status",
		async (stage, statuses) => {
			await callOrgWork(stage);
			expect(count).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						codingRuns: { some: { status: { in: statuses } } },
					}),
				}),
			);
		},
	);

	it("filters blocked features without relying on a run failure", async () => {
		await callOrgWork("blocked");
		expect(count).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ blocked: true }),
			}),
		);
	});

	it("returns true totals independently of the visible item limit", async () => {
		const result = await callOrgWork();
		expect(result).toMatchObject({
			inProgress: { items: [], total: 2 },
			needsReview: { items: [], total: 6 },
			blocked: { items: [], total: 6 },
			drafts: { items: [], total: 4 },
			assignedFeatures: { items: [], total: 2 },
			projectCount: 2,
			projectVisits: [],
		});
	});

	it("keeps the legacy personal arm exclusive", async () => {
		await getMyWork({ userId: "user-1", organizationId: null, now: NOW });
		const storyCall = findMany.mock.calls.find(
			([input]) => input.where?.project,
		);
		expect(storyCall?.[0].where?.project).toEqual({
			organizationId: null,
			deletedAt: null,
			userId: "user-1",
		});
	});
});
