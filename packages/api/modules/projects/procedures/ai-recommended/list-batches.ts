import {
	aiRecommendedAwaitingApprovalWhere,
	aiRecommendedEligibleWhere,
	aiRecommendedProtectedWhere,
	db,
	type Prisma,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertAiRecommendedLifecycleEnabled } from "./lifecycle-flag";

const batchSchema = z.object({
	batchId: z.string(),
	/** When the batch's first item was accepted onto the Roadmap. */
	createdAt: z.date(),
	eligibleCount: z.number().int(),
	editedEligibleCount: z.number().int(),
	protectedCount: z.number().int(),
	awaitingApprovalCount: z.number().int(),
});

async function countByBatch(
	where: Prisma.UserStoryWhereInput,
): Promise<Map<string, number>> {
	const groups = await db.userStory.groupBy({
		by: ["aiRecommendationBatchId"],
		where,
		_count: { _all: true },
	});
	const counts = new Map<string, number>();
	for (const group of groups) {
		if (group.aiRecommendationBatchId !== null) {
			counts.set(group.aiRecommendationBatchId, group._count._all);
		}
	}
	return counts;
}

/**
 * The recommendation batches a removal can still act on (Fizzy #2211), newest
 * first. Only batches with an eligible item are listed, so the picker agrees
 * with the capability gate that hides the Remove action at zero — both read
 * the same predicate.
 */
export const listAiRecommendationBatchesProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "GET",
		path: "/projects/{projectId}/ai-recommended-batches",
		tags: ["Projects", "Features"],
		summary: "List AI-recommended batches that can be removed",
	})
	.input(z.object({ projectId: z.string() }))
	.output(z.object({ batches: z.array(batchSchema) }))
	.handler(async ({ input }) => {
		await assertAiRecommendedLifecycleEnabled(input.projectId);

		const eligibleWhere = aiRecommendedEligibleWhere(input.projectId);
		const [eligible, edited, protectedCounts, awaitingApproval] =
			await Promise.all([
				db.userStory.groupBy({
					by: ["aiRecommendationBatchId"],
					where: eligibleWhere,
					_count: { _all: true },
					_min: { createdAt: true },
				}),
				countByBatch({
					...eligibleWhere,
					firstHumanEditAt: { not: null },
				}),
				countByBatch(aiRecommendedProtectedWhere(input.projectId)),
				countByBatch(
					aiRecommendedAwaitingApprovalWhere(input.projectId),
				),
			]);

		const batches = eligible.flatMap((group) => {
			const batchId = group.aiRecommendationBatchId;
			const createdAt = group._min.createdAt;
			if (batchId === null || createdAt === null) {
				return [];
			}
			return [
				{
					batchId,
					createdAt,
					eligibleCount: group._count._all,
					editedEligibleCount: edited.get(batchId) ?? 0,
					protectedCount: protectedCounts.get(batchId) ?? 0,
					awaitingApprovalCount: awaitingApproval.get(batchId) ?? 0,
				},
			];
		});
		batches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

		return { batches };
	});
