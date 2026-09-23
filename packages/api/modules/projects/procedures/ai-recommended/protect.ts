import { ORPCError } from "@orpc/server";
import { db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertAiRecommendedLifecycleEnabled } from "./lifecycle-flag";

/**
 * Keep one AI-recommended item out of every future batch removal (Fizzy #2211).
 *
 * Writes the two protection columns and nothing else. It never goes through
 * `updateStory`: protecting an item is not an edit of it, so it must not move
 * the edit clock, bump the version, snapshot a FeatureVersion or mark the item
 * "edited" for the removal warning.
 *
 * Idempotent: protecting an already-protected item reports it and keeps the
 * original protector. There is no unprotect in v1; a protected item can still
 * be hidden on its own.
 */
export const protectAiRecommendedItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/ai-batch-protection",
		tags: ["Projects", "Features"],
		summary: "Protect an AI-recommended feature from batch removal",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
		}),
	)
	.output(
		z.object({
			protectedAt: z.date(),
			protectedById: z.string(),
			alreadyProtected: z.boolean(),
		}),
	)
	.handler(async ({ input, context }) => {
		await assertAiRecommendedLifecycleEnabled(input.projectId);

		const written = await db.userStory.updateMany({
			where: {
				id: input.storyId,
				projectId: input.projectId,
				source: "AI_RECOMMENDED",
				aiRecommendationBatchId: { not: null },
				aiBatchProtectedAt: null,
			},
			data: {
				aiBatchProtectedAt: new Date(),
				aiBatchProtectedById: context.user.id,
			},
		});

		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				source: true,
				aiRecommendationBatchId: true,
				aiBatchProtectedAt: true,
				aiBatchProtectedById: true,
			},
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}
		if (
			story.source !== "AI_RECOMMENDED" ||
			story.aiRecommendationBatchId === null
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Only AI-recommended items can be protected",
			});
		}
		if (
			story.aiBatchProtectedAt === null ||
			story.aiBatchProtectedById === null
		) {
			// Written and then cleared in between — nothing clears it today.
			throw new ORPCError("CONFLICT", {
				message: "The item changed while it was being protected",
			});
		}

		return {
			protectedAt: story.aiBatchProtectedAt,
			protectedById: story.aiBatchProtectedById,
			alreadyProtected: written.count === 0,
		};
	});
