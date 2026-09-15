import { ORPCError } from "@orpc/client";
import { ACCEPTED_SPIKE_RUN_WHERE, db } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

const ESTIMATE_CONFIDENCE_VALUES = ["LOW", "MEDIUM", "HIGH"] as const;
const STORY_SIZE_VALUES = ["XS", "S", "M", "L", "XL"] as const;

export const setEstimateInputSchema = z.object({
	projectId: z.string(),
	storyId: z.string(),
	organizationId: z.string().nullable().optional(),
	size: z.enum(STORY_SIZE_VALUES).nullable().optional(),
	storyPoints: z.number().int().min(0).max(1000).nullable().optional(),
	estimateConfidence: z
		.enum(ESTIMATE_CONFIDENCE_VALUES)
		.nullable()
		.optional(),
});

/**
 * Set a feature's estimate (size, points, confidence) — plan Slice 7.
 *
 * Rule: a SPIKE with no accepted spike run (`CodingRun { kind: SPIKE,
 * status: COMPLETED, findings not null }`) is always LOW confidence. The
 * caller's `estimateConfidence` is ignored in that case and the response
 * carries `forcedLowConfidence: true` so the UI can explain why.
 *
 * AUTHORIZATION: `requireProjectPermission(STORY_UPDATE)`.
 */
export const setEstimateProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/estimate",
		tags: ["Projects", "Features"],
		summary: "Set feature estimate",
		description:
			"Set size, story points and estimate confidence on a feature. Spikes without an accepted spike run are always LOW confidence.",
	})
	.input(setEstimateInputSchema)
	.handler(async ({ input }) => {
		const existing = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!existing) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const data: {
			size?: (typeof STORY_SIZE_VALUES)[number] | null;
			storyPoints?: number | null;
		} = {};
		if (input.size !== undefined) {
			data.size = input.size;
		}
		if (input.storyPoints !== undefined) {
			data.storyPoints = input.storyPoints;
		}

		// The SPIKE ⇒ LOW invariant is enforced by the write itself, not by
		// a prior read: a non-LOW confidence only lands on a row that, at
		// write time, is either not a SPIKE or has an accepted spike run. A
		// concurrent track change to SPIKE therefore cannot leave SPIKE+HIGH
		// behind (review sprint3 round 2 #4).
		let forcedLowConfidence = false;
		const wantsNonLow =
			input.estimateConfidence !== undefined &&
			input.estimateConfidence !== "LOW";

		if (!wantsNonLow) {
			const updated = await db.userStory.updateMany({
				where: { id: input.storyId, projectId: input.projectId },
				data: {
					...data,
					...(input.estimateConfidence !== undefined
						? { estimateConfidence: input.estimateConfidence }
						: {}),
				},
			});
			if (updated.count === 0) {
				throw new ORPCError("NOT_FOUND", {
					message: "Feature not found",
				});
			}
		} else {
			const updated = await db.userStory.updateMany({
				where: {
					id: input.storyId,
					projectId: input.projectId,
					OR: [
						{ deliveryTrack: { not: "SPIKE" } },
						{ codingRuns: { some: ACCEPTED_SPIKE_RUN_WHERE } },
					],
				},
				data: { ...data, estimateConfidence: input.estimateConfidence },
			});
			if (updated.count === 0) {
				// A SPIKE without an accepted run (or a vanished row).
				const forced = await db.userStory.updateMany({
					where: { id: input.storyId, projectId: input.projectId },
					data: { ...data, estimateConfidence: "LOW" },
				});
				if (forced.count === 0) {
					throw new ORPCError("NOT_FOUND", {
						message: "Feature not found",
					});
				}
				forcedLowConfidence = true;
			}
		}

		const story = await db.userStory.findFirstOrThrow({
			where: { id: input.storyId, projectId: input.projectId },
		});

		return { story, forcedLowConfidence };
	});
