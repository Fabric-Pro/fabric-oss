import type { AzureDevOpsSprintStoryCapture } from "@repo/connectors";
import { z } from "zod";
import { adoAssignmentField } from "../../../lib/ado-story-review-config";
import {
	observation,
	observationSchema,
	reviewFingerprint,
	sourceDetails,
	sourceDetailsSchema,
	storyReviewSchema,
} from "./fingerprints";

const id = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z
	.object({
		uniqueName: z.string().max(512),
		displayName: z.string().max(512),
	})
	.strict();
const assignmentField = adoAssignmentField;
const edgeSchema = z
	.object({ sourceId: id, targetId: id, kind: z.enum(["child", "related"]) })
	.strict();
const discoverySchema = z
	.object({ assignedItemId: id, kind: z.enum(["direct", "parent"]) })
	.strict();
const navigationSchema = z
	.object({
		id,
		sourceUrl: z.string().max(2_048),
		...observationSchema.shape,
	})
	.strict();
const graphCommentsSchema = z
	.array(sourceDetailsSchema.shape.comments.element.extend({ itemId: id }))
	.max(1_000);

export const sprintSourceDetailsSchema = z
	.object({
		...sourceDetailsSchema.shape,
		comments: graphCommentsSchema,
		contextItems: z
			.array(
				z
					.object({
						id,
						workItemType: z.string().max(128),
						...sourceDetailsSchema.shape,
						comments: graphCommentsSchema,
					})
					.strict(),
			)
			.max(100),
		edges: z.array(edgeSchema).max(500),
	})
	.strict()
	.refine(
		(source) =>
			new Set(source.contextItems.map((item) => item.id)).size ===
				source.contextItems.length &&
			new Set(source.comments.map((comment) => comment.id)).size ===
				source.comments.length &&
			source.contextItems.every(
				(item) =>
					new Set(item.comments.map((comment) => comment.id)).size ===
						item.comments.length &&
					item.comments.every(
						(comment) => comment.itemId === item.id,
					),
			) &&
			new Set(
				source.edges.map(
					(edge) => `${edge.sourceId}:${edge.kind}:${edge.targetId}`,
				),
			).size === source.edges.length,
	);

export const sprintObservationSchema = z
	.object({
		...observationSchema.shape,
		sourceUrl: z.string().max(2_048),
		discoverySources: z.array(discoverySchema).max(100),
		contextItems: z.array(navigationSchema).max(100),
	})
	.strict();

export const sprintAssignedItemSchema = z
	.object({
		id,
		workItemType: z.string().max(128),
		state: z.string().max(256),
		assignedTo: identity.nullable(),
		engineer: z.union([identity, z.string().max(512), z.null()]),
		iterationPath: z.string().max(512),
		sourceUrl: z.string().max(2_048),
		discovery: z
			.object({
				reason: z.literal("assignment_query"),
				assignmentFields: z.array(assignmentField).min(1).max(2),
				matchedAssignmentFields: z
					.array(assignmentField)
					.max(2)
					.nullable(),
			})
			.strict(),
		parentResolution: z.enum([
			"direct_story",
			"parent_followed",
			"parent_type_excluded",
			"parent_source_excluded",
			"no_parent",
		]),
		parentCandidates: z
			.array(
				z
					.object({
						id,
						workItemType: z.string().max(128),
						included: z.boolean(),
					})
					.strict(),
			)
			.max(100),
		storyIds: z.array(id).max(50),
	})
	.strict();

const sprintSourceStorySchema = z
	.object({
		id,
		sourceDetails: sprintSourceDetailsSchema,
		observation: sprintObservationSchema,
	})
	.strict();

export const sprintSourceGraphSchema = z
	.object({
		assignedItems: z.array(sprintAssignedItemSchema).max(100),
		stories: z.array(sprintSourceStorySchema).max(50),
	})
	.strict()
	.refine((graph) => {
		const assigned = new Map(
			graph.assignedItems.map((item) => [item.id, item]),
		);
		const storyIds = new Set(graph.stories.map((story) => story.id));
		const distinctIds = new Set([
			...assigned.keys(),
			...storyIds,
			...graph.assignedItems.flatMap((item) =>
				item.parentCandidates.map((parent) => parent.id),
			),
			...graph.stories.flatMap((story) =>
				story.sourceDetails.contextItems.map((item) => item.id),
			),
		]);
		return (
			assigned.size === graph.assignedItems.length &&
			storyIds.size === graph.stories.length &&
			distinctIds.size <= 100 &&
			graph.stories.reduce(
				(count, story) => count + story.sourceDetails.edges.length,
				0,
			) <= 500 &&
			graph.assignedItems.every((item) =>
				item.storyIds.every((id) => storyIds.has(id)),
			) &&
			graph.stories.every((story) => {
				const contextIds = new Set(
					story.sourceDetails.contextItems.map((item) => item.id),
				);
				const observedIds = new Set(
					story.observation.contextItems.map((item) => item.id),
				);
				return (
					story.sourceDetails.comments.every(
						(comment) => comment.itemId === story.id,
					) &&
					observedIds.size ===
						story.observation.contextItems.length &&
					contextIds.size === observedIds.size &&
					[...contextIds].every(
						(id) =>
							observedIds.has(id) &&
							story.sourceDetails.edges.some(
								(edge) => edge.targetId === id,
							),
					) &&
					story.sourceDetails.edges.every(
						(edge) =>
							edge.sourceId === story.id &&
							contextIds.has(edge.targetId),
					) &&
					story.observation.discoverySources.length > 0 &&
					story.observation.discoverySources.every((source) =>
						assigned
							.get(source.assignedItemId)
							?.storyIds.includes(story.id),
					)
				);
			})
		);
	});

export const sprintReviewCacheSchema = sprintSourceGraphSchema
	.safeExtend({
		version: z.literal(2),
		userId: z.string().min(1).max(128),
		organizationId: z.string().min(1).max(128),
		projectId: z.string().min(1).max(128),
		workflowId: z.string().min(1).max(128),
		nodeId: z.string().min(1).max(128),
		selectionFingerprint: hash,
		evaluatorFingerprint: hash,
		requirementsAsOf: z.string().datetime(),
		stories: z
			.array(
				sprintSourceStorySchema.extend({
					sourceFingerprint: hash,
					review: storyReviewSchema,
				}),
			)
			.max(50),
	})
	.refine(
		(cache) =>
			cache.stories.every(
				(story) =>
					story.id === story.review.id &&
					story.sourceFingerprint ===
						reviewFingerprint(story.sourceDetails),
			) && JSON.stringify(cache).length <= 600_000,
	);
export type SprintReviewCache = z.infer<typeof sprintReviewCacheSchema>;

export function sprintSourceDetails(capture: AzureDevOpsSprintStoryCapture) {
	const own = sourceDetails(capture.story);
	return {
		...own,
		comments: own.comments.map((comment) => ({
			...comment,
			itemId: capture.story.id,
		})),
		contextItems: [...capture.contextItems]
			.sort((a, b) => a.id - b.id)
			.map((item) => {
				const details = sourceDetails(item);
				return {
					id: item.id,
					workItemType: item.workItemType,
					...details,
					comments: details.comments.map((comment) => ({
						...comment,
						itemId: item.id,
					})),
				};
			}),
		edges: [...capture.edges].sort(
			(a, b) =>
				a.sourceId - b.sourceId ||
				a.targetId - b.targetId ||
				a.kind.localeCompare(b.kind),
		),
	};
}

export function sprintObservation(capture: AzureDevOpsSprintStoryCapture) {
	return {
		...observation(capture.story),
		sourceUrl: capture.story.sourceUrl,
		discoverySources: [...capture.discoverySources].sort(
			(a, b) =>
				a.assignedItemId - b.assignedItemId ||
				a.kind.localeCompare(b.kind),
		),
		contextItems: [...capture.contextItems]
			.sort((a, b) => a.id - b.id)
			.map((item) => ({
				id: item.id,
				sourceUrl: item.sourceUrl,
				...observation(item),
			})),
	};
}
