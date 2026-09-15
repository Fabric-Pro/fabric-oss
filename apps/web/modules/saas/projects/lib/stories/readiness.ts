/**
 * Readiness gates on the client (plan §1.1 / Slice 5).
 *
 * Mirrors `packages/api/modules/projects/lib/run-readiness.ts`. Gap codes are
 * stable identifiers; labels come from i18n (`projects.stories.readiness.gaps`).
 */

import { ORPCError } from "@orpc/client";
import type { DeliveryTrack, FeatureDraftingStage } from "./types";

const READINESS_GAP_CODES = [
	"UNCLASSIFIED",
	"DEFERRED",
	"SPIKE_NOT_ACCEPTED",
	"INTEGRATION_CONTRACT_MISSING",
	"DESCRIPTION_MISSING",
	"ACCEPTANCE_CRITERIA_MISSING",
	"EVIDENCE_UNAVAILABLE",
] as const;

export type ReadinessGap = (typeof READINESS_GAP_CODES)[number];

export interface StoryReadiness {
	ready: boolean;
	missing: ReadinessGap[];
	advisory: ReadinessGap[];
	effectiveTrack: DeliveryTrack;
	deliveryTrack: DeliveryTrack;
	draftingStage: FeatureDraftingStage;
	reviewRequired: boolean;
}

/** A feature may start implementation work only when PUBLISHED and ready. */
export function isStoryRunnable(
	readiness: StoryReadiness | null | undefined,
): boolean {
	return (
		!!readiness &&
		readiness.draftingStage === "PUBLISHED" &&
		readiness.ready
	);
}

function isGap(value: unknown): value is ReadinessGap {
	return (
		typeof value === "string" &&
		(READINESS_GAP_CODES as readonly string[]).includes(value)
	);
}

/**
 * Extract the gap list from a `PRECONDITION_FAILED` error thrown by a stage
 * writer or a run-start procedure. Returns `null` for any other error so
 * callers fall back to their generic toast.
 */
export function getReadinessErrorGaps(error: unknown): {
	missing: ReadinessGap[];
	toStage?: FeatureDraftingStage;
} | null {
	if (!(error instanceof ORPCError)) {
		return null;
	}
	if (error.code !== "PRECONDITION_FAILED") {
		return null;
	}
	const data = error.data as
		| { missing?: unknown; toStage?: FeatureDraftingStage }
		| undefined;
	const missing = Array.isArray(data?.missing)
		? data.missing.filter(isGap)
		: [];
	return { missing, toStage: data?.toStage };
}

/** Response fragment returned by stage writers under GOVERNED review. */
export function getPendingStageRequest(result: unknown): { id: string } | null {
	const pending = (result as { pendingStageRequest?: { id: string } | null })
		?.pendingStageRequest;
	return pending?.id ? { id: pending.id } : null;
}
