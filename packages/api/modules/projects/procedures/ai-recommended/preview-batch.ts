import {
	aiRecommendedAwaitingApprovalWhere,
	aiRecommendedEligibleWhere,
	aiRecommendedProtectedWhere,
	db,
	loadProjectStagePolicy,
	type Prisma,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertAiRecommendedLifecycleEnabled } from "./lifecycle-flag";

/** A removal is at most this many items, so the preview lists no more. */
const PREVIEW_LIMIT = 200;

const itemSchema = z.object({
	id: z.string(),
	identifier: z.string(),
	title: z.string(),
});

function listItems(where: Prisma.UserStoryWhereInput) {
	return db.userStory.findMany({
		where,
		select: {
			id: true,
			identifier: true,
			title: true,
			firstHumanEditAt: true,
		},
		orderBy: { roadmapOrder: "asc" },
		take: PREVIEW_LIMIT,
	});
}

/**
 * What removing one batch would do, before anyone confirms it (Fizzy #2211).
 *
 * `eligible` is exactly what the door will act on — the client sends those ids
 * back as `expectedStoryIds`, so an item that became eligible after the
 * preview is never removed unseen. `governedReview` tells the dialog that each
 * item will become an approval request rather than move right away.
 */
export const previewAiRecommendationBatchProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/ai-recommended-batches/{batchId}",
		tags: ["Projects", "Features"],
		summary: "Preview the removal of an AI-recommended batch",
	})
	.input(z.object({ projectId: z.string(), batchId: z.string() }))
	.output(
		z.object({
			eligible: z.array(itemSchema.extend({ edited: z.boolean() })),
			protected: z.array(itemSchema),
			awaitingApproval: z.array(itemSchema),
			editedEligibleCount: z.number().int(),
			governedReview: z.boolean(),
		}),
	)
	.handler(async ({ input }) => {
		await assertAiRecommendedLifecycleEnabled(input.projectId);

		const [eligible, protectedItems, awaitingApproval, policy] =
			await Promise.all([
				listItems(
					aiRecommendedEligibleWhere(input.projectId, input.batchId),
				),
				listItems(
					aiRecommendedProtectedWhere(input.projectId, input.batchId),
				),
				listItems(
					aiRecommendedAwaitingApprovalWhere(
						input.projectId,
						input.batchId,
					),
				),
				loadProjectStagePolicy(db, input.projectId),
			]);

		const eligibleItems = eligible.map(({ firstHumanEditAt, ...item }) => ({
			...item,
			edited: firstHumanEditAt !== null,
		}));

		return {
			eligible: eligibleItems,
			protected: protectedItems,
			awaitingApproval,
			editedEligibleCount: eligibleItems.filter((item) => item.edited)
				.length,
			governedReview: policy.reviewRequired,
		};
	});
