/**
 * Delivery Track Classification Workflow
 *
 * Thin durable wrapper around `classifyDeliveryTracks`. Started by:
 * - `backlogApplyChangesWorkflow` as a child, after its last transaction
 *   commits, with the created story ids;
 * - `projects.stories.classifyTracks` (manual re-run from the roadmap);
 * - `projects.stories.create` fire-and-forget for a single new story.
 *
 * Plan: docs/features/inverted-loop-delivery-tracks.md, Slice 2.
 */
import {
	defineQuery,
	log,
	proxyActivities,
	setHandler,
} from "@temporalio/workflow";
import type {
	classifyDeliveryTracks as ClassifyDeliveryTracksFn,
	TrackClassificationResult,
} from "../activities/delivery-track/classify";

// =============================================================================
// Types
// =============================================================================

export interface DeliveryTrackClassificationInput {
	projectId: string;
	/**
	 * Story ids to classify. `undefined` classifies every UNCLASSIFIED story
	 * in the project; an empty array is a no-op.
	 */
	storyIds?: string[];
	userId: string;
	organizationId?: string;
}

export type ClassificationStatus =
	| "initializing"
	| "classifying"
	| "complete"
	| "failed";

export interface DeliveryTrackClassificationProgress {
	status: ClassificationStatus;
	message: string;
	classified: number;
	skipped: number;
	error?: string;
}

export interface DeliveryTrackClassificationOutput {
	success: boolean;
	classified: number;
	skipped: number;
	results: TrackClassificationResult[];
	errors: string[];
}

// =============================================================================
// Queries
// =============================================================================

export const classificationProgressQuery =
	defineQuery<DeliveryTrackClassificationProgress>("classificationProgress");

// =============================================================================
// Activity proxies
// =============================================================================

const { classifyDeliveryTracks } = proxyActivities<{
	classifyDeliveryTracks: typeof ClassifyDeliveryTracksFn;
}>({
	startToCloseTimeout: "5 minutes",
	heartbeatTimeout: "60 seconds",
	retry: {
		initialInterval: "2s",
		backoffCoefficient: 2,
		maximumAttempts: 2,
	},
});

// =============================================================================
// Workflow
// =============================================================================

export async function deliveryTrackClassificationWorkflow(
	input: DeliveryTrackClassificationInput,
): Promise<DeliveryTrackClassificationOutput> {
	const progress: DeliveryTrackClassificationProgress = {
		status: "initializing",
		message: "Preparing classification",
		classified: 0,
		skipped: 0,
	};

	setHandler(classificationProgressQuery, () => progress);

	log.info("Delivery track classification started", {
		projectId: input.projectId,
		storyCount: input.storyIds?.length ?? "all-unclassified",
	});

	if (input.storyIds && input.storyIds.length === 0) {
		progress.status = "complete";
		progress.message = "Nothing to classify";
		return {
			success: true,
			classified: 0,
			skipped: 0,
			results: [],
			errors: [],
		};
	}

	progress.status = "classifying";
	progress.message = "Classifying stories into delivery tracks";

	try {
		const result = await classifyDeliveryTracks({
			projectId: input.projectId,
			storyIds: input.storyIds,
			userId: input.userId,
			organizationId: input.organizationId,
		});

		progress.status = "complete";
		progress.classified = result.classified;
		progress.skipped = result.skipped;
		progress.message =
			result.errors.length > 0
				? `Classified ${result.classified} stor${result.classified === 1 ? "y" : "ies"} with ${result.errors.length} batch error(s)`
				: `Classified ${result.classified} stor${result.classified === 1 ? "y" : "ies"}`;

		return {
			success: true,
			classified: result.classified,
			skipped: result.skipped,
			results: result.results,
			errors: result.errors,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		progress.status = "failed";
		progress.message = "Classification failed";
		progress.error = message;
		log.error("Delivery track classification failed", {
			projectId: input.projectId,
			error: message,
		});
		throw error;
	}
}
