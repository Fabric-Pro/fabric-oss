import { describe, expect, it } from "vitest";
import { clusterActivityByStory } from "../src/activities/daily-brief/reduce-storylines";

describe("clusterActivityByStory", () => {
	it("groups items that share storyCuid", () => {
		const now = new Date();
		const clusters = clusterActivityByStory({
			storyChanges: [
				{
					kind: "status_changed",
					occurredAt: now,
					title: "F-12 moved to In Review",
					storyCuid: "s1",
					storyIdentifier: "F-12",
					fabricLink: "/x",
				},
			],
			taskChanges: [
				{
					kind: "completed",
					occurredAt: now,
					title: "T-34 done",
					taskCuid: "t1",
					taskIdentifier: "T-34",
					storyCuid: "s1",
					storyIdentifier: "F-12",
					fabricLink: "/x",
				},
			],
			github: [],
			documents: [],
			meetings: [],
			teamsProposals: [],
		});
		expect(clusters).toHaveLength(1);
		expect(clusters[0].storyCuid).toBe("s1");
		expect(clusters[0].relatedItems).toHaveLength(2);
	});

	it("drops clusters with only one item (not a thread)", () => {
		const now = new Date();
		const clusters = clusterActivityByStory({
			storyChanges: [
				{
					kind: "created",
					occurredAt: now,
					title: "lonely",
					storyCuid: "s1",
					storyIdentifier: "F-1",
					fabricLink: "/x",
				},
			],
			taskChanges: [],
			github: [],
			documents: [],
			meetings: [],
			teamsProposals: [],
		});
		expect(clusters).toHaveLength(0);
	});

	it("returns at most MAX_CLUSTERS clusters, sorted by item count desc", () => {
		const now = new Date();
		const storyChanges = Array.from({ length: 10 }, (_, i) => ({
			kind: "status_changed" as const,
			occurredAt: now,
			title: `F-${i}`,
			storyCuid: `s${i}`,
			storyIdentifier: `F-${i}`,
			fabricLink: "/x",
		}));
		const taskChanges = Array.from({ length: 10 }, (_, i) =>
			Array.from({ length: i }, (_, j) => ({
				kind: "status_changed" as const,
				occurredAt: now,
				title: `t-${i}-${j}`,
				taskCuid: `t${i}-${j}`,
				taskIdentifier: `T-${i}-${j}`,
				storyCuid: `s${i}`,
				storyIdentifier: `F-${i}`,
				fabricLink: "/x",
			})),
		).flat();
		const clusters = clusterActivityByStory({
			storyChanges,
			taskChanges,
			github: [],
			documents: [],
			meetings: [],
			teamsProposals: [],
		});
		expect(clusters.length).toBeLessThanOrEqual(5);
		expect(clusters[0].relatedItems.length).toBeGreaterThan(
			clusters[clusters.length - 1].relatedItems.length,
		);
	});

	it("excludes pr_merged from clusters (those belong to Release Notes)", () => {
		const now = new Date();
		const clusters = clusterActivityByStory({
			storyChanges: [
				{
					kind: "status_changed",
					occurredAt: now,
					title: "F-12 moved to Done",
					storyCuid: "cstory1",
					storyIdentifier: "F-12",
					fabricLink: "/x",
				},
			],
			taskChanges: [],
			github: [
				{
					kind: "pr_merged",
					occurredAt: now,
					title: "F-12 implement refund split",
					prNumber: 412,
					repoFullName: "acme/api",
					url: "https://github.com/acme/api/pull/412",
					state: "merged",
				},
			],
			documents: [],
			meetings: [],
			teamsProposals: [],
		});
		// Only the story_change remains → 1 item → below MIN_ITEMS_PER_CLUSTER
		// → no cluster surfaces.
		expect(clusters).toHaveLength(0);
	});

	it("merges a PR mentioning a story identifier into the story's cluster", () => {
		const now = new Date();
		const clusters = clusterActivityByStory({
			storyChanges: [
				{
					kind: "status_changed",
					occurredAt: now,
					title: "F-12 moved to In Review",
					storyCuid: "cstory1",
					storyIdentifier: "F-12",
					fabricLink: "/x",
				},
			],
			taskChanges: [],
			github: [
				{
					kind: "pr_opened",
					occurredAt: now,
					title: "F-12 implement refund split",
					prNumber: 412,
					repoFullName: "acme/api",
					url: "https://github.com/acme/api/pull/412",
					state: "open",
				},
			],
			documents: [],
			meetings: [],
			teamsProposals: [],
		});
		expect(clusters).toHaveLength(1);
		expect(clusters[0].storyCuid).toBe("cstory1");
		expect(clusters[0].relatedItems).toHaveLength(2);
		expect(clusters[0].relatedItems.map((r) => r.kind).sort()).toEqual([
			"github",
			"story_change",
		]);
	});
});
