/**
 * Run-start readiness check (plan §F1 "Run-start checks", Slice 5).
 *
 * Every procedure that starts implementation work for a feature — coding
 * runs, kanban queueing, kanban sync, Weave execution — re-evaluates
 * readiness at start time because evidence can change after the feature
 * reached PUBLISHED. The check is fail-closed: a feature must be PUBLISHED
 * and have no enforced gaps, otherwise the procedure throws
 * `PRECONDITION_FAILED` carrying the gap list so the UI can show it.
 */

import { ORPCError } from "@orpc/client";
import {
	computeStoryReadiness,
	type StoryReadinessSnapshot,
} from "@repo/database";
import { z } from "zod";
import { mapStageTransitionError } from "./stage-transition-errors";

const READINESS_GAP_VALUES = [
	"UNCLASSIFIED",
	"DEFERRED",
	"SPIKE_NOT_ACCEPTED",
	"INTEGRATION_CONTRACT_MISSING",
	"DESCRIPTION_MISSING",
	"ACCEPTANCE_CRITERIA_MISSING",
	"EVIDENCE_UNAVAILABLE",
] as const;

export const readinessGapSchema = z.enum(READINESS_GAP_VALUES);

const deliveryTrackOutputSchema = z.enum([
	"UNCLASSIFIED",
	"SPIKE",
	"DISCOVERY",
	"SPECIFY",
	"DEFER",
]);

const draftingStageOutputSchema = z.enum([
	"PLACEHOLDER",
	"PASSIVE_ANALYSIS",
	"ACTIVE_ANALYSIS",
	"SANITY_CHECK",
	"DRAFT",
	"PUBLISHED",
	"DECLINED",
	"CLOSED",
]);

/** Wire shape of `computeStoryReadiness` for procedure outputs. */
export const storyReadinessOutputSchema = z.object({
	ready: z.boolean(),
	missing: z.array(readinessGapSchema),
	advisory: z.array(readinessGapSchema),
	effectiveTrack: deliveryTrackOutputSchema,
	deliveryTrack: deliveryTrackOutputSchema,
	draftingStage: draftingStageOutputSchema,
	reviewRequired: z.boolean(),
});

export type StoryReadinessOutput = z.infer<typeof storyReadinessOutputSchema>;

export function toReadinessOutput(
	snapshot: StoryReadinessSnapshot,
): StoryReadinessOutput {
	return {
		ready: snapshot.ready,
		missing: snapshot.missing,
		advisory: snapshot.advisory,
		effectiveTrack: snapshot.effectiveTrack,
		deliveryTrack: snapshot.deliveryTrack,
		draftingStage: snapshot.draftingStage,
		reviewRequired: snapshot.reviewRequired,
	};
}

/**
 * Compute readiness for a story, mapping domain errors ("Story not found")
 * to oRPC errors. Never throws for a not-ready story.
 */
export async function loadStoryReadiness(params: {
	storyId: string;
	projectId: string;
}): Promise<StoryReadinessSnapshot> {
	try {
		return await computeStoryReadiness(params);
	} catch (error) {
		throw mapStageTransitionError(error);
	}
}

export function isStoryRunnable(snapshot: StoryReadinessSnapshot): boolean {
	return snapshot.draftingStage === "PUBLISHED" && snapshot.ready;
}

/**
 * Throw `PRECONDITION_FAILED` unless the story is PUBLISHED and ready.
 * Returns the snapshot so callers can log or echo it.
 */
export async function assertStoryReadyForRun(params: {
	storyId: string;
	projectId: string;
}): Promise<StoryReadinessSnapshot> {
	const snapshot = await loadStoryReadiness(params);
	if (isStoryRunnable(snapshot)) {
		return snapshot;
	}
	const notPublished = snapshot.draftingStage !== "PUBLISHED";
	const message = notPublished
		? "This feature must reach Ready for Dev (published) before work can start."
		: `This feature is not ready for implementation: ${snapshot.missing.join(", ")}`;
	throw new ORPCError("PRECONDITION_FAILED", {
		message,
		data: {
			code: "STORY_NOT_READY",
			...toReadinessOutput(snapshot),
		},
	});
}
