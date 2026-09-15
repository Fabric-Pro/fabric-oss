import { ORPCError } from "@orpc/client";
import {
	ACCEPTED_SPIKE_RUN_WHERE,
	ASSIGNABLE_DELIVERY_TRACKS,
	db,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Set a story's delivery track by hand.
 *
 * Marks the track as `HUMAN`-set so the classifier never overwrites it
 * (the classifier's `updateMany` excludes `trackSetBy = HUMAN`).
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_UPDATE)`.
 */
export const setDeliveryTrackProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/delivery-track",
		tags: ["Projects", "Features"],
		summary: "Set feature delivery track",
		description:
			"Assign a delivery track (SPIKE, DISCOVERY, SPECIFY, DEFER) to a feature. Human assignments are never overwritten by the classifier.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			track: z.enum(ASSIGNABLE_DELIVERY_TRACKS),
			rationale: z.string().trim().max(1_000).optional(),
		}),
	)
	.handler(async ({ input }) => {
		const existing = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const base = {
			deliveryTrack: input.track,
			trackRationale: input.rationale?.length ? input.rationale : null,
			trackSetBy: "HUMAN" as const,
			trackUpdatedAt: new Date(),
		};

		// Entering SPIKE without an accepted spike forces LOW estimate
		// confidence (plan Slice 7) in the same statement as the track write,
		// so no interleaving with `setEstimate` can leave SPIKE+HIGH behind
		// (review sprint3 round 2 #4).
		let forcedLowConfidence = false;
		if (input.track === "SPIKE") {
			const unproven = await db.userStory.updateMany({
				where: {
					id: input.storyId,
					projectId: input.projectId,
					codingRuns: { none: ACCEPTED_SPIKE_RUN_WHERE },
				},
				data: { ...base, estimateConfidence: "LOW" },
			});
			if (unproven.count === 1) {
				forcedLowConfidence = true;
			} else {
				// Has an accepted spike: keep whatever confidence it earned.
				const proven = await db.userStory.updateMany({
					where: { id: input.storyId, projectId: input.projectId },
					data: base,
				});
				if (proven.count === 0) {
					throw new ORPCError("NOT_FOUND", {
						message: "Feature not found",
					});
				}
			}
		} else {
			const updated = await db.userStory.updateMany({
				where: { id: input.storyId, projectId: input.projectId },
				data: base,
			});
			if (updated.count === 0) {
				throw new ORPCError("NOT_FOUND", {
					message: "Feature not found",
				});
			}
		}

		const story = await db.userStory.findFirstOrThrow({
			where: { id: input.storyId, projectId: input.projectId },
		});

		return { story, forcedLowConfidence };
	});
