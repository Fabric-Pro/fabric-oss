import { ORPCError } from "@orpc/client";
import { getStoryById, restoreFeatureVersion } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { runInBackground } from "../../../../weave/lib/run-in-background";
import { maybeAutoDraftOnStageChange } from "../../../lib/auto-draft-test-cases";
import { stripInternalStoryFields } from "../../../lib/strip-internal-story-fields";

/**
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role.
 * Restoring a version modifies story content, so read-only access is insufficient.
 */
export const restoreFeatureVersionProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/stories/:storyId/versions/:versionNumber/restore",
		tags: ["Projects", "Features", "Versions"],
		summary: "Restore feature version",
		description: "Restore a feature to a previous version",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			versionNumber: z.number().int().positive(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const story = await getStoryById(input.storyId, input.projectId);

		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}

		const restoredStory = await restoreFeatureVersion(
			input.storyId,
			input.projectId,
			input.versionNumber,
			user.id,
			{
				userId: user.id,
				organizationId,
				lastEditedByName: user.name ?? null,
			},
		);

		// Restoring a snapshot taken at Ready for Dev moves the live feature
		// there, so this is a stage transition like any other — narrower than the
		// editor routes, but the same obligation.
		runInBackground(
			maybeAutoDraftOnStageChange({
				projectId: input.projectId,
				storyId: input.storyId,
				userId: user.id,
				previousStage: story.draftingStage,
				targetStage: restoredStory.draftingStage,
			}),
		);

		return { story: stripInternalStoryFields(restoredStory) };
	});
