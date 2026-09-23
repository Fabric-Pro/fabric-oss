/**
 * Which AI-recommended work items a batch removal would take (Fizzy #2211).
 *
 * One predicate, three readers: the capability gate's count of eligible
 * batches, the batch list and preview, and the removal door itself. If any of
 * them built its own WHERE, the gate could offer a removal the door then finds
 * nothing to do for, or the preview could promise items the door leaves
 * behind.
 *
 * An item is eligible while it is still provisional and still on the Roadmap:
 * it came from a recommendation batch, nobody protected it, it is not closed or
 * declined, it is not in a final (Done) status column — finished work is kept
 * whatever its origin — and no request to close it is already awaiting
 * approval. That last
 * clause is what makes a retry idempotent on a governed project — a removal
 * there files close requests instead of closing, and those items must not be
 * counted a second time.
 */

import { TERMINAL_DRAFTING_STAGES } from "../../../utils";
import { db, type Prisma } from "../../client";

const PENDING_CLOSE_REQUEST = {
	status: "PENDING",
	toStage: "CLOSED",
} as const satisfies Prisma.StageTransitionRequestWhereInput;

/** Items from recommendation batches that are still on the Roadmap. */
function liveBatchItemsWhere(
	projectId: string,
	batchId: string | undefined,
): Prisma.UserStoryWhereInput {
	return {
		projectId,
		source: "AI_RECOMMENDED",
		aiRecommendationBatchId: batchId ?? { not: null },
		draftingStage: { notIn: TERMINAL_DRAFTING_STAGES },
	};
}

/** Items a batch removal would take now — across every batch, or one. */
export function aiRecommendedEligibleWhere(
	projectId: string,
	batchId?: string,
): Prisma.UserStoryWhereInput {
	return {
		...liveBatchItemsWhere(projectId, batchId),
		aiBatchProtectedAt: null,
		// `statusId` is required, so every item has a status to test.
		status: { isFinal: false },
		stageTransitionRequests: { none: PENDING_CLOSE_REQUEST },
	};
}

/** Unprotected items whose close is already awaiting approval — across every batch, or one. */
export function aiRecommendedAwaitingApprovalWhere(
	projectId: string,
	batchId?: string,
): Prisma.UserStoryWhereInput {
	return {
		...liveBatchItemsWhere(projectId, batchId),
		aiBatchProtectedAt: null,
		stageTransitionRequests: { some: PENDING_CLOSE_REQUEST },
	};
}

/** Items a person protected, which a batch removal always leaves alone. */
export function aiRecommendedProtectedWhere(
	projectId: string,
	batchId?: string,
): Prisma.UserStoryWhereInput {
	return {
		...liveBatchItemsWhere(projectId, batchId),
		aiBatchProtectedAt: { not: null },
	};
}

/**
 * How many batches still hold an item a removal would take. Grouped by batch
 * id, so a batch counts once however many of its items are eligible.
 */
export async function countEligibleAiRecommendationBatches(
	projectId: string,
): Promise<number> {
	const groups = await db.userStory.groupBy({
		by: ["aiRecommendationBatchId"],
		where: aiRecommendedEligibleWhere(projectId),
	});
	return groups.length;
}
