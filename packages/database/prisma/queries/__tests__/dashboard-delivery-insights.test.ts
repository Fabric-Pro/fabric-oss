import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryInsightStory } from "../dashboard-delivery-insights";

const { findMany, groupBy } = vi.hoisted(() => ({
	findMany: vi.fn(),
	groupBy: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		userStory: { findMany },
		codingRun: { groupBy },
	},
}));

import {
	buildDeliveryInsights,
	getDeliveryInsights,
} from "../dashboard-delivery-insights";

const NOW = new Date("2026-11-05T12:00:00.000Z");

function story(
	id: string,
	createdAt: string,
	readyAt?: string,
): DeliveryInsightStory {
	return {
		createdAt: new Date(createdAt),
		draftingStage: readyAt ? "PUBLISHED" : "DRAFT",
		draftingStageUpdatedAt: readyAt ? new Date(readyAt) : null,
		blocked: false,
		versions: readyAt ? [{ createdAt: new Date(readyAt) }] : [],
		codingRuns: [],
	};
}

describe("buildDeliveryInsights", () => {
	it("builds cumulative scope and timestamped ready transitions with a baseline", () => {
		const result = buildDeliveryInsights({
			stories: [
				story(
					"before",
					"2026-11-01T00:00:00.000Z",
					"2026-11-02T00:00:00.000Z",
				),
				story(
					"new-ready",
					"2026-11-03T00:00:00.000Z",
					"2026-11-04T00:00:00.000Z",
				),
				story("new-draft", "2026-11-04T00:00:00.000Z"),
				story(
					"fallback",
					"2026-11-02T00:00:00.000Z",
					"2026-11-05T00:00:00.000Z",
				),
				{
					...story("not-ready", "2026-11-02T00:00:00.000Z"),
					draftingStageUpdatedAt: new Date(
						"2026-11-04T00:00:00.000Z",
					),
				},
			],
			outcomeGroups: [],
			attentionGroups: [],
			days: 3,
			now: NOW,
		});

		expect(result.timeline).toEqual([
			{ date: "2026-11-03", scope: 4, ready: 1 },
			{ date: "2026-11-04", scope: 5, ready: 2 },
			{ date: "2026-11-05", scope: 5, ready: 3 },
		]);
		expect(result.summary).toMatchObject({
			createdInRange: 2,
			readyInRange: 2,
			previousReady: 1,
			medianReadyDays: 2,
			readyDurationSamples: 2,
		});
	});

	it("uses blocked, review, and active runs before the drafting stage", () => {
		const base = story("base", "2026-11-01T00:00:00.000Z");
		const result = buildDeliveryInsights({
			stories: [
				{
					...base,
					blocked: true,
					codingRuns: [{ status: "PR_OPENED" }],
				},
				{
					...base,
					draftingStage: "SANITY_CHECK",
					codingRuns: [{ status: "AWAITING_REVIEW" }],
				},
				{
					...base,
					draftingStage: "PUBLISHED",
					codingRuns: [{ status: "RUNNING" }],
				},
				{ ...base, draftingStage: "PUBLISHED" },
				{ ...base, draftingStage: "SANITY_CHECK" },
				{ ...base, codingRuns: [{ status: "COMPLETED" }] },
				{ ...base, draftingStage: "CLOSED" },
			],
			outcomeGroups: [
				{ status: "COMPLETED", count: 2 },
				{ status: "PR_OPENED", count: 1 },
				{ status: "FAILED", count: 1 },
				{ status: "CANCELLED", count: 1 },
				{ status: "RUNNING", count: 1 },
			],
			attentionGroups: [
				{ status: "PR_OPENED", count: 1 },
				{ status: "TERMINATED_STALE", count: 1 },
			],
			days: 7,
			now: NOW,
		});

		expect(result.flow).toEqual([
			{ stage: "drafting", count: 1 },
			{ stage: "sanityCheck", count: 1 },
			{ stage: "readyForDev", count: 1 },
			{ stage: "implementing", count: 1 },
			{ stage: "review", count: 1 },
			{ stage: "blocked", count: 1 },
		]);
		expect(result.agentOutcomes).toEqual([
			{ status: "active", count: 1 },
			{ status: "completed", count: 2 },
			{ status: "review", count: 1 },
			{ status: "failed", count: 1 },
			{ status: "cancelled", count: 1 },
		]);
		expect(result.summary).toMatchObject({
			runsNeedingAttention: 2,
			reviewRuns: 1,
			failedRuns: 1,
		});
	});

	it("returns an honest empty result without inventing history", () => {
		const result = buildDeliveryInsights({
			stories: [],
			outcomeGroups: [],
			attentionGroups: [],
			days: 7,
			now: NOW,
		});

		expect(result.hasData).toBe(false);
		expect(result.summary.medianReadyDays).toBeNull();
		expect(result.timeline).toHaveLength(7);
		expect(
			result.timeline.every(
				(point) => point.scope === 0 && point.ready === 0,
			),
		).toBe(true);
	});
});

describe("getDeliveryInsights", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		findMany.mockResolvedValue([]);
		groupBy.mockResolvedValue([]);
	});

	it("scopes stories to the assignee and reachable projects and runs to the caller", async () => {
		await getDeliveryInsights({
			userId: "user-1",
			organizationId: "org-1",
			days: 30,
			now: NOW,
		});

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
		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { assigneeId: "user-1", project: expectedProjectScope },
			}),
		);
		expect(groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					project: expectedProjectScope,
					updatedAt: { gte: new Date("2026-10-07T00:00:00.000Z") },
				}),
			}),
		);
		expect(groupBy).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-1",
					project: expectedProjectScope,
					status: {
						in: [
							"AWAITING_REVIEW",
							"PR_OPENED",
							"DEMO_READY",
							"FAILED",
							"TERMINATED_STALE",
						],
					},
				}),
			}),
		);
	});
});
