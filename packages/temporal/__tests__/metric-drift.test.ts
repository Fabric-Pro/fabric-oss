/**
 * Slice 8 — success-metric drift collector rules.
 *
 * Run with: pnpm --filter @repo/temporal test __tests__/metric-drift.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		projectSuccessMetric: { findMany: vi.fn() },
		organization: { findUnique: vi.fn() },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import { db } from "@repo/database";
import {
	buildMetricDriftActions,
	collectMetricDrift,
	evaluateMetricDrift,
	METRIC_STALE_DAYS,
	metricsTabLink,
} from "../src/activities/daily-brief/collect-metric-drift";

const NOW = new Date("2026-09-14T12:00:00Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const healthy = {
	id: "m1",
	name: "Activation rate",
	direction: "UP" as const,
	target: 40,
	lastValue: 45,
	previousValue: 41,
	lastObservedAt: daysAgo(1),
};

describe("evaluateMetricDrift", () => {
	it("returns no reasons for a fresh metric moving the right way above target", () => {
		expect(evaluateMetricDrift(healthy, NOW)).toEqual([]);
	});

	it("flags an UP metric that fell", () => {
		expect(
			evaluateMetricDrift(
				{ ...healthy, lastValue: 40, previousValue: 41 },
				NOW,
			),
		).toEqual(["moved_against_direction"]);
	});

	it("flags a DOWN metric that rose", () => {
		expect(
			evaluateMetricDrift(
				{
					...healthy,
					direction: "DOWN",
					target: null,
					lastValue: 12,
					previousValue: 9,
				},
				NOW,
			),
		).toEqual(["moved_against_direction"]);
	});

	it("does not flag direction when only one observation exists", () => {
		expect(
			evaluateMetricDrift(
				{ ...healthy, previousValue: null, lastValue: 45 },
				NOW,
			),
		).toEqual([]);
	});

	it("flags a missed target for UP (below) and DOWN (above)", () => {
		expect(
			evaluateMetricDrift(
				{ ...healthy, lastValue: 45, previousValue: 44, target: 50 },
				NOW,
			),
		).toEqual(["missed_target"]);
		expect(
			evaluateMetricDrift(
				{
					...healthy,
					direction: "DOWN",
					target: 5,
					lastValue: 6,
					previousValue: 7,
				},
				NOW,
			),
		).toEqual(["missed_target"]);
	});

	it("treats an exact target hit as met", () => {
		expect(
			evaluateMetricDrift(
				{ ...healthy, lastValue: 40, previousValue: 39 },
				NOW,
			),
		).toEqual([]);
	});

	it(`flags a metric not observed in more than ${METRIC_STALE_DAYS} days, or never`, () => {
		expect(
			evaluateMetricDrift(
				{ ...healthy, lastObservedAt: daysAgo(METRIC_STALE_DAYS + 1) },
				NOW,
			),
		).toEqual(["stale_observation"]);
		expect(
			evaluateMetricDrift(
				{
					...healthy,
					lastValue: null,
					previousValue: null,
					lastObservedAt: null,
				},
				NOW,
			),
		).toEqual(["stale_observation"]);
		expect(
			evaluateMetricDrift(
				{ ...healthy, lastObservedAt: daysAgo(METRIC_STALE_DAYS - 1) },
				NOW,
			),
		).toEqual([]);
	});

	it("can report several reasons at once", () => {
		expect(
			evaluateMetricDrift(
				{
					...healthy,
					lastValue: 30,
					previousValue: 41,
					lastObservedAt: daysAgo(20),
				},
				NOW,
			),
		).toEqual([
			"moved_against_direction",
			"missed_target",
			"stale_observation",
		]);
	});
});

describe("buildMetricDriftActions", () => {
	it("targets the metric by id with targetType metric and links to the outcomes tab", () => {
		const actions = buildMetricDriftActions(
			[
				{
					metricId: "m1",
					name: "Activation rate",
					direction: "UP",
					target: 50,
					lastValue: 33,
					previousValue: 41,
					lastObservedAt: NOW,
					reasons: ["moved_against_direction", "missed_target"],
				},
			],
			metricsTabLink("p1", "acme"),
		);
		expect(actions).toHaveLength(1);
		expect(actions[0]).toMatchObject({
			kind: "metric_drift",
			targetType: "metric",
			targetCuid: "m1",
			targetIdentifier: "Activation rate",
			fabricLink: "/app/acme/projects/p1?tab=outcomes",
		});
		expect(actions[0]?.title).toContain("41");
		expect(actions[0]?.title).toContain("33");
	});

	it("uses the personal-context link when there is no organization", () => {
		expect(metricsTabLink("p1", null)).toBe(
			"/app/projects/p1?tab=outcomes",
		);
	});
});

describe("collectMetricDrift", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	it("filters by project and XOR organization, returns only drifting metrics", async () => {
		vi.mocked(db.projectSuccessMetric.findMany).mockResolvedValue([
			healthy,
			{
				...healthy,
				id: "m2",
				name: "Churn",
				lastValue: 30,
				previousValue: 41,
			},
		] as never);
		vi.mocked(db.organization.findUnique).mockResolvedValue({
			slug: "acme",
		} as never);

		const out = await collectMetricDrift({
			projectId: "p1",
			organizationId: "org1",
			now: NOW,
		});

		expect(db.projectSuccessMetric.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p1", organizationId: "org1" },
			}),
		);
		expect(out.items.map((i) => i.metricId)).toEqual(["m2"]);
		expect(out.priorityActions).toHaveLength(1);
		expect(out.priorityActions[0]?.fabricLink).toBe(
			"/app/acme/projects/p1?tab=outcomes",
		);
	});

	it("uses organizationId: null for personal projects and skips the org lookup", async () => {
		vi.mocked(db.projectSuccessMetric.findMany).mockResolvedValue(
			[] as never,
		);
		const out = await collectMetricDrift({
			projectId: "p1",
			organizationId: null,
			now: NOW,
		});
		expect(db.projectSuccessMetric.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p1", organizationId: null },
			}),
		);
		expect(db.organization.findUnique).not.toHaveBeenCalled();
		expect(out).toEqual({ items: [], priorityActions: [] });
	});
});
