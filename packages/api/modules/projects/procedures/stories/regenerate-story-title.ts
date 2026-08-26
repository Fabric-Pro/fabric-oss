import { ORPCError } from "@orpc/client";
import {
	generateStoryTitleFromDescription,
	mapCreationSource,
	mapStoryTitleSourceToEnum,
} from "@repo/ai/lib/story-title-generator";
import { db, hasProjectAccess, updateStory } from "@repo/database";
import { logger } from "@repo/logs";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";

export const regenerateStoryTitleProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/regenerate-title",
		tags: ["Projects", "Stories"],
		summary: "Regenerate story title",
		description:
			"Regenerate the AI-derived title for an existing story from its description.",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Use the same tenant-access helper that getStoryProcedure uses so the
		// owner of an org-scoped project can regenerate without being explicitly
		// in `ProjectMember`. The previous inline XOR `members: { some: ... }`
		// filter excluded org-project owners and triggered "Story not found"
		// even though the user could open the workspace via getStoryProcedure.
		const canAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// 2026-05-14 spec §5.2.2: `reporterSource` is required so the helper
		// can derive a human-readable `creation_source` via `mapCreationSource`
		// for the prompt template. No separate origin blob is persisted on
		// the story today; `originContext` is reserved for future enhancement.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: {
				id: true,
				description: true,
				kind: true,
				reporterSource: true,
				pmAutoSyncEnabled: true,
			},
		});

		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Story not found" });
		}

		const kindForTitle = story.kind === "BUG" ? "BUG" : "FEATURE";
		// Tenant XOR isolation preserved: `requireProjectPermission` +
		// `hasProjectAccess` (above) + `findFirst` scoped to `projectId`.
		const result = await generateStoryTitleFromDescription(
			story.description?.trim() ?? "",
			kindForTitle,
			{
				userId: user.id,
				organizationId: organizationId ?? undefined,
				projectId: input.projectId,
				creationSource: mapCreationSource(story.reporterSource, "UI"),
				originContext: undefined,
				projectName: undefined,
			},
		);

		await updateStory(
			input.storyId,
			input.projectId,
			{ title: result.title },
			{
				lastEditedByName: user.name ?? null,
				lastEditedSource: "AI_MATURATION",
			},
		);
		await db.userStory.update({
			where: { id: input.storyId },
			data: {
				aiGeneratedTitle: result.source === "ai",
				titleSource: mapStoryTitleSourceToEnum(result.source),
			},
		});

		// AI-regenerated title is a PM-relevant content change. Mirror the
		// gate from `update-story.ts` (and `enhance-feature.ts`): only push
		// when the user has opted into auto-sync. `enqueuePmSync` handles
		// the no-externalId / no-pm-config short-circuits internally, and
		// the call is fire-and-forget so the user's regenerate latency is
		// unaffected by Temporal scheduling.
		if (story.pmAutoSyncEnabled) {
			enqueuePmSync({
				itemId: input.storyId,
				itemType: "story",
				projectId: input.projectId,
				userId: user.id,
				triggerSource: "manual-edit",
			}).catch((err) => {
				logger.warn("enqueuePmSync failed", {
					storyId: input.storyId,
					err: err instanceof Error ? err.message : String(err),
				});
			});
		}

		return { title: result.title, titleSource: result.source };
	});
