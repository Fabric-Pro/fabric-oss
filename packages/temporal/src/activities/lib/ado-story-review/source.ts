import {
	AzureDevOpsProjectReadError,
	type AzureDevOpsSprintCapture,
	type AzureDevOpsStorySnapshot,
	captureAzureDevOpsSprintStories,
	getAzureDevOpsStorySnapshots,
	listAzureDevOpsAssignedStories,
} from "@repo/connectors";
import { z } from "zod";
import {
	ADO_REVIEW_MAX_INPUT_CHARS,
	type AdoStoryReviewConfig,
} from "../../../lib/ado-story-review-config";
import { observation, sourceDetails } from "./fingerprints";
import {
	sprintObservation,
	sprintSourceDetails,
	sprintSourceGraphSchema,
} from "./sprint-cache";

type ReviewSourceTarget = Parameters<typeof captureAzureDevOpsSprintStories>[0];

export class ReviewStepFailure extends Error {}

export function requireComplete(
	condition: boolean,
	message: string,
): asserts condition {
	if (!condition) {
		throw new ReviewStepFailure(message);
	}
}

function completeSnapshot(
	story: AzureDevOpsStorySnapshot,
	requirementsAsOf: string,
) {
	return (
		story.complete &&
		story.comments.complete &&
		story.requirementsAsOf === requirementsAsOf &&
		story.comments.consistency === "two_matching_reads"
	);
}

function validateSprintCapture(
	capture: AzureDevOpsSprintCapture,
	config: AdoStoryReviewConfig,
) {
	requireComplete(
		capture.complete &&
			capture.discoveryComplete &&
			capture.requirementsAsOf !== null &&
			capture.unreadItemIds.length === 0,
		`Sprint graph capture is incomplete; narrow the exact iterations, assigned types or context relations and retry. No reviews were generated. Capture reason: ${capture.incompleteReason ?? "unknown"}.`,
	);
	const requirementsAsOf = z
		.string()
		.datetime()
		.parse(capture.requirementsAsOf);
	requireComplete(
		capture.stories.length <= config.maxStories,
		"Sprint stories exceed the configured limit; no reviews were generated.",
	);
	for (const entry of capture.stories) {
		requireComplete(
			completeSnapshot(entry.story, requirementsAsOf) &&
				entry.contextItems.every((item) =>
					completeSnapshot(item, requirementsAsOf),
				),
			"Sprint requirements or comments are incomplete; no reviews were generated.",
		);
	}
	requireComplete(
		JSON.stringify(capture).length <= ADO_REVIEW_MAX_INPUT_CHARS,
		"Sprint input exceeds the review limit; no reviews were generated.",
	);
	return requirementsAsOf;
}

async function sprintCapture(
	target: ReviewSourceTarget,
	pat: string,
	config: AdoStoryReviewConfig,
) {
	if (!config.sprintContext) {
		throw new ReviewStepFailure("Select sprint context filters.");
	}
	let capture: AzureDevOpsSprintCapture;
	try {
		capture = await captureAzureDevOpsSprintStories(target, pat, {
			assignee: config.assignee,
			targetStoryTypes: config.workItemTypes,
			requirementFields: config.requirementFields,
			maxStories: config.maxStories,
			selection: config.sprintContext,
		});
	} catch (error) {
		if (
			error instanceof AzureDevOpsProjectReadError &&
			error.code === "unsupported_current_predicate"
		) {
			throw new ReviewStepFailure(
				"Current-account filtering needs every assignment field other than System.AssignedTo to be an identity field. Select an exact ADO member unique name or remove that field from assignment fields.",
			);
		}
		throw error;
	}
	const requirementsAsOf = validateSprintCapture(capture, config);
	const graph = sprintSourceGraphSchema.safeParse({
		assignedItems: [...capture.assignedItems].sort((a, b) => a.id - b.id),
		stories: capture.stories
			.map((entry) => ({
				id: entry.story.id,
				sourceDetails: sprintSourceDetails(entry),
				observation: sprintObservation(entry),
			}))
			.sort((a, b) => a.id - b.id),
	});
	requireComplete(
		graph.success,
		"Sprint graph membership or limits are invalid; no reviews were generated.",
	);
	const capturedStories = new Map(
		capture.stories.map((entry) => [entry.story.id, entry]),
	);
	return {
		version: 2 as const,
		requirementsAsOf,
		assignedItems: graph.data.assignedItems,
		stories: graph.data.stories.map((story) => {
			const entry = capturedStories.get(story.id);
			requireComplete(
				entry !== undefined,
				"Sprint story source is unavailable.",
			);
			return {
				snapshot: entry.story,
				sourceDetails: story.sourceDetails,
				observation: story.observation,
				quoted: {
					id: entry.story.id,
					requirements: entry.story.requirements,
					comments: entry.story.comments.comments,
					contextItems: entry.contextItems.map((item) => ({
						id: item.id,
						workItemType: item.workItemType,
						relationRoles: entry.edges
							.filter((edge) => edge.targetId === item.id)
							.map((edge) => edge.kind),
						requirements: item.requirements,
						comments: item.comments.comments,
					})),
					edges: entry.edges,
				},
				commentCaptures: [entry.story, ...entry.contextItems],
			};
		}),
	};
}

/** Direct mode retains its original requests, batching and input accounting. */
export async function acquireReviewSource(
	target: ReviewSourceTarget,
	pat: string,
	config: AdoStoryReviewConfig,
) {
	if (config.sprintContext) {
		return sprintCapture(target, pat, config);
	}
	const assigned = await listAzureDevOpsAssignedStories(target, pat, {
		assignee: config.assignee,
		workItemTypes: config.workItemTypes,
	});
	requireComplete(
		assigned.complete && assigned.requirementsAsOf !== null,
		"Assigned story enumeration is incomplete; no reviews were generated.",
	);
	requireComplete(
		assigned.ids.length <= config.maxStories,
		"Assigned stories exceed the configured limit; no reviews were generated.",
	);
	requireComplete(
		new Set(assigned.ids).size === assigned.ids.length,
		"Assigned story enumeration contains duplicate IDs.",
	);
	const requirementsAsOf = z
		.string()
		.datetime()
		.parse(assigned.requirementsAsOf);
	const stories: AzureDevOpsStorySnapshot[] = [];
	let inputChars = 0;
	for (let offset = 0; offset < assigned.ids.length; offset += 5) {
		const ids = assigned.ids.slice(offset, offset + 5);
		const batch = await getAzureDevOpsStorySnapshots(target, pat, {
			ids,
			requirementsAsOf,
			requirementFields: config.requirementFields,
		});
		const remaining = new Set(ids);
		requireComplete(
			batch.complete &&
				batch.unreadIds.length === 0 &&
				batch.snapshots.length === ids.length &&
				batch.snapshots.every(
					(story) =>
						remaining.delete(story.id) &&
						completeSnapshot(story, requirementsAsOf),
				),
			"Story requirements or comments are incomplete; no reviews were generated.",
		);
		inputChars += JSON.stringify(batch.snapshots).length;
		requireComplete(
			inputChars <= ADO_REVIEW_MAX_INPUT_CHARS,
			"Story input exceeds the review limit; no reviews were generated.",
		);
		stories.push(...batch.snapshots);
	}
	return {
		version: 1 as const,
		requirementsAsOf,
		stories: stories
			.sort((a, b) => a.id - b.id)
			.map((story) => ({
				snapshot: story,
				sourceDetails: sourceDetails(story),
				observation: observation(story),
				quoted: {
					id: story.id,
					requirements: story.requirements,
					comments: story.comments.comments,
				},
				commentCaptures: [story],
			})),
	};
}
