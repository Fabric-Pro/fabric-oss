import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { reviewFingerprint } from "../fingerprints";
import {
	sprintReviewCacheSchema,
	sprintSourceGraphSchema,
} from "../sprint-cache";

type SourceGraph = z.infer<typeof sprintSourceGraphSchema>;
type SourceStory = SourceGraph["stories"][number];
type SourceEdge = SourceStory["sourceDetails"]["edges"][number];

function graph(): SourceGraph {
	const observed = {
		title: "Example item",
		state: "Active",
		assignedTo: null,
		workItemType: "User Story",
		sourceUrl:
			"https://dev.azure.com/example-org/example/_workitems/edit/1",
	};
	return {
		assignedItems: [
			{
				id: 10,
				workItemType: "Task",
				state: "Active",
				assignedTo: null,
				engineer: null,
				iterationPath: "Example\\Sprint 1",
				sourceUrl: observed.sourceUrl,
				discovery: {
					reason: "assignment_query",
					assignmentFields: ["System.AssignedTo"],
					matchedAssignmentFields: ["System.AssignedTo"],
				},
				parentResolution: "parent_followed",
				parentCandidates: [
					{ id: 1, workItemType: "User Story", included: true },
				],
				storyIds: [1],
			},
		],
		stories: [
			{
				id: 1,
				sourceDetails: {
					requirements: {},
					comments: [],
					contextItems: [
						{
							id: 2,
							workItemType: "Task",
							requirements: {},
							comments: [],
						},
					],
					edges: [{ sourceId: 1, targetId: 2, kind: "child" }],
				},
				observation: {
					...observed,
					discoverySources: [{ assignedItemId: 10, kind: "parent" }],
					contextItems: [
						{ ...observed, id: 2, workItemType: "Task" },
					],
				},
			},
		],
	};
}

function cache(source: SourceGraph) {
	return {
		...source,
		version: 2,
		userId: "user-1",
		organizationId: "org-1",
		projectId: "project-1",
		workflowId: "workflow-1",
		nodeId: "review-1",
		selectionFingerprint: "a".repeat(64),
		evaluatorFingerprint: "b".repeat(64),
		requirementsAsOf: "2026-01-02T12:00:00.000Z",
		stories: source.stories.map((story) => ({
			...story,
			sourceFingerprint: reviewFingerprint(story.sourceDetails),
			review: {
				id: story.id,
				verdict: "ready",
				summary: "Clear",
				issues: [],
			},
		})),
	};
}

const invalidGraphs: Array<[string, (source: SourceGraph) => void]> = [
	[
		"duplicate assigned item",
		(source) => {
			source.assignedItems.push(source.assignedItems[0]!);
		},
	],
	[
		"duplicate story",
		(source) => {
			source.stories.push(source.stories[0]!);
		},
	],
	[
		"duplicate context",
		(source) => {
			source.stories[0]!.sourceDetails.contextItems.push(
				source.stories[0]!.sourceDetails.contextItems[0]!,
			);
		},
	],
	[
		"missing observed context",
		(source) => {
			source.stories[0]!.observation.contextItems = [];
		},
	],
	[
		"unknown assigned story",
		(source) => {
			source.assignedItems[0]!.storyIds = [99];
		},
	],
	[
		"foreign edge source",
		(source) => {
			source.stories[0]!.sourceDetails.edges[0]!.sourceId = 99;
		},
	],
	[
		"missing edge target",
		(source) => {
			source.stories[0]!.sourceDetails.edges[0]!.targetId = 99;
		},
	],
	[
		"missing discovery",
		(source) => {
			source.stories[0]!.observation.discoverySources = [];
		},
	],
	[
		"foreign discovery",
		(source) => {
			source.stories[0]!.observation.discoverySources[0]!.assignedItemId =
				99;
		},
	],
	[
		"distinct item budget",
		(source) => {
			source.assignedItems[0]!.parentCandidates = Array.from(
				{ length: 98 },
				(_, index) => ({
					id: 100 + index,
					workItemType: "Task",
					included: false,
				}),
			);
		},
	],
];

describe("shared sprint source graph contract", () => {
	it("accepts the same complete membership before inference and in a persisted cache", () => {
		const source = graph();
		expect(sprintSourceGraphSchema.safeParse(source).success).toBe(true);
		expect(sprintReviewCacheSchema.safeParse(cache(source)).success).toBe(
			true,
		);
	});

	it.each(invalidGraphs)(
		"rejects %s at both boundaries",
		(_name, corrupt) => {
			const source = graph();
			corrupt(source);
			expect(sprintSourceGraphSchema.safeParse(source).success).toBe(
				false,
			);
			expect(
				sprintReviewCacheSchema.safeParse(cache(source)).success,
			).toBe(false);
		},
	);

	it("retains cache-specific review identity and fingerprint checks", () => {
		const source = graph();
		const persisted = cache(source);
		persisted.stories[0]!.review.id = 99;
		expect(sprintSourceGraphSchema.safeParse(source).success).toBe(true);
		expect(sprintReviewCacheSchema.safeParse(persisted).success).toBe(
			false,
		);
		persisted.stories[0]!.review.id = 1;
		persisted.stories[0]!.sourceFingerprint = "a".repeat(64);
		expect(sprintReviewCacheSchema.safeParse(persisted).success).toBe(
			false,
		);
	});

	it("shares the global 500-edge bound across otherwise complete stories", () => {
		const source = graph();
		const template = source.stories[0]!;
		source.stories = [1, 3, 4].map<SourceStory>((storyId) => ({
			...template,
			id: storyId,
			sourceDetails: {
				...template.sourceDetails,
				contextItems: Array.from({ length: 84 }, (_, index) => ({
					id: 100 + index,
					workItemType: "Task",
					requirements: {},
					comments: [],
				})),
				edges: Array.from(
					{ length: 84 },
					(_, index) => 100 + index,
				).flatMap<SourceEdge>((targetId) => [
					{ sourceId: storyId, targetId, kind: "child" },
					{ sourceId: storyId, targetId, kind: "related" },
				]),
			},
			observation: {
				...template.observation,
				contextItems: Array.from({ length: 84 }, (_, index) => ({
					...template.observation.contextItems[0]!,
					id: 100 + index,
				})),
			},
		}));
		source.assignedItems[0]!.storyIds = [1, 3, 4];
		expect(sprintSourceGraphSchema.safeParse(source).success).toBe(false);
		expect(sprintReviewCacheSchema.safeParse(cache(source)).success).toBe(
			false,
		);
		source.stories[2]!.sourceDetails.edges =
			source.stories[2]!.sourceDetails.edges.filter(
				(_edge, index) => index > 6 || index % 2 !== 0,
			);
		expect(sprintSourceGraphSchema.safeParse(source).success).toBe(true);
		expect(sprintReviewCacheSchema.safeParse(cache(source)).success).toBe(
			true,
		);
	});
});
