/**
 * Daily Brief schema v3 (Slice 8 — success metrics).
 *
 * Proves the constant moved to 3 and that briefs persisted under v1 and v2
 * still parse unchanged: every v3 addition is optional and the version
 * literal union keeps the older literals.
 */
import { describe, expect, it } from "vitest";
import {
	DAILY_BRIEF_SCHEMA_VERSION,
	dailyBriefContentSchema,
	metricDriftItemSchema,
	partialFailureSchema,
	priorityActionKindSchema,
	priorityActionSchema,
} from "../src/daily-brief-schema";

const V1_BRIEF = {
	schemaVersion: 1,
	executiveSummary: "Two PRs merged, one blocker.",
	priorityActions: [
		{
			kind: "blocker",
			title: "Payments webhook failing",
			whyItMatters: "Blocks checkout.",
			targetCuid: "cstory1",
			targetIdentifier: "F-4",
			targetType: "story",
			fabricLink: "/app/projects/p1/stories/cstory1",
		},
	],
	sections: {
		github: [
			{
				kind: "pr_merged",
				occurredAt: "2026-03-01T10:00:00.000Z",
				title: "Fix webhook retries",
				prNumber: 12,
				repoFullName: "acme/portal",
				url: "https://github.com/acme/portal/pull/12",
			},
		],
	},
	partialFailures: [{ source: "meetings", reason: "no transcripts" }],
};

const V2_BRIEF = {
	schemaVersion: 2,
	executiveSummary: "Quiet week.",
	priorityActions: [
		{
			kind: "pr_review_stale",
			title: "PR #40 waiting 4 days",
			whyItMatters: "Reviewer unassigned.",
			targetCuid: "pr-40",
			targetIdentifier: "#40",
			targetType: "document",
			fabricLink: "https://github.com/acme/portal/pull/40",
		},
	],
	sections: {},
	storylines: [
		{
			storyIdentifier: "F-12",
			headline: "Refund split",
			narrative: "Decision then PR.",
			relatedItems: [
				{
					kind: "github",
					refId: "pr-412",
					occurredAt: "2026-03-02T10:00:00.000Z",
				},
			],
		},
	],
	ahead: [
		{
			kind: "upcoming_meeting",
			title: "Sprint review",
			occursAt: "2026-03-03T10:00:00.000Z",
			fabricLink: "/app/projects/p1/meetings/m1",
		},
	],
	releaseNotesSummary: { prod: "Shipped refunds." },
};

describe("daily-brief schema v3", () => {
	it("exposes schema version 3", () => {
		expect(DAILY_BRIEF_SCHEMA_VERSION).toBe(3);
	});

	it("still parses a stored v1 brief without changes", () => {
		const parsed = dailyBriefContentSchema.safeParse(V1_BRIEF);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.schemaVersion).toBe(1);
			expect(parsed.data.metricDrift).toBeUndefined();
			expect(parsed.data.priorityActions[0]?.targetType).toBe("story");
		}
	});

	it("still parses a stored v2 brief without changes", () => {
		const parsed = dailyBriefContentSchema.safeParse(V2_BRIEF);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.schemaVersion).toBe(2);
			expect(parsed.data.storylines).toHaveLength(1);
			expect(parsed.data.ahead).toHaveLength(1);
			expect(parsed.data.metricDrift).toBeUndefined();
		}
	});

	it("accepts metric_drift priority actions targeting a metric", () => {
		expect(priorityActionKindSchema.safeParse("metric_drift").success).toBe(
			true,
		);
		const action = priorityActionSchema.safeParse({
			kind: "metric_drift",
			title: "Activation rate fell from 41% to 33%",
			whyItMatters: "Moved against its direction.",
			targetCuid: "cmetric1",
			targetIdentifier: "Activation rate",
			targetType: "metric",
			fabricLink: "/app/projects/p1?tab=outcomes",
		});
		expect(action.success).toBe(true);
	});

	it("parses a v3 brief with a metricDrift section and a metrics partial failure", () => {
		const parsed = dailyBriefContentSchema.safeParse({
			...V2_BRIEF,
			schemaVersion: 3,
			partialFailures: [{ source: "metrics", reason: "db timeout" }],
			metricDrift: [
				{
					metricId: "cmetric1",
					name: "Activation rate",
					direction: "UP",
					target: 50,
					lastValue: 33,
					previousValue: 41,
					lastObservedAt: "2026-03-01T00:00:00.000Z",
					reasons: ["moved_against_direction", "missed_target"],
				},
			],
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.metricDrift?.[0]?.lastObservedAt).toBeInstanceOf(
				Date,
			);
		}
		expect(
			partialFailureSchema.safeParse({ source: "metrics", reason: "x" })
				.success,
		).toBe(true);
	});

	it("rejects a drift item with no reason and an unknown schema version", () => {
		expect(
			metricDriftItemSchema.safeParse({
				metricId: "m",
				name: "n",
				direction: "UP",
				target: null,
				lastValue: null,
				previousValue: null,
				lastObservedAt: null,
				reasons: [],
			}).success,
		).toBe(false);
		expect(
			dailyBriefContentSchema.safeParse({ ...V1_BRIEF, schemaVersion: 4 })
				.success,
		).toBe(false);
	});
});
