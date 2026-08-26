import { ORPCError } from "@orpc/server";
import { db, hasProjectAccess } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Manually reattach a grouping theme to an existing ticket of the user's choice
 * (spec `2026-07-01-security-finding-tickets`, follow-up).
 *
 * The finding-grouping pipeline dedups by a per-theme `StoryTag` value: a run
 * finds the open story carrying `themeKey` and comments on it instead of making
 * a duplicate. The identity-stabilization fix keeps that key stable across full
 * rescans for the common case — but the AI can still, occasionally, file the
 * "same" issue under a genuinely different rule/criterion (or a project's own
 * overlapping custom rule can straddle two themes), producing a near-duplicate
 * ticket. This is the human override for those residual cases: point a theme at
 * the ticket that should own it, and every future run attaches there.
 *
 * Operation (atomic): move the `themeKey` tag OFF whatever open story currently
 * carries it in this project and ONTO `targetStoryId` — so exactly one ticket
 * owns the theme and `findOpenStoryByThemeTag` resolves to the chosen one. The
 * vacated source ticket is left intact (the caller decides whether to close or
 * keep it) — reattach never deletes a work item.
 */
export const reattachGroupingProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "POST",
		path: "/projects/:projectId/scan/grouping/reattach",
		tags: ["Projects", "Security"],
		summary: "Reattach a grouping theme to a chosen existing ticket",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			/** The theme's `StoryTag` value (e.g. `theme-accessibility-...`). */
			themeKey: z.string().min(1),
			/** The ticket that should own this theme going forward. */
			targetStoryId: z.string().min(1),
		}),
	)
	.handler(async ({ input, context }) => {
		const { projectId, organizationId, themeKey, targetStoryId } = input;
		const user = context.user;

		const hasAccess = await hasProjectAccess(
			projectId,
			user.id,
			organizationId ?? undefined,
		);
		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// IDOR guard: the permission gate authorizes projectId only — confirm the
		// target ticket actually belongs to this project before mutating tags.
		const target = await db.userStory.findFirst({
			where: { id: targetStoryId, projectId },
			select: { id: true, identifier: true },
		});
		if (!target) {
			throw new ORPCError("NOT_FOUND", {
				message: "Target ticket not found in this project",
			});
		}

		const moved = await db.$transaction(async (tx) => {
			// Every open story in THIS project currently carrying the theme tag.
			// (Scoped through the relation so a tag on another tenant's story can
			// never be touched.)
			const holders = await tx.storyTag.findMany({
				where: { value: themeKey, story: { projectId } },
				select: { id: true, storyId: true },
			});

			// Drop the tag from every current holder that isn't the target.
			const staleTagIds = holders
				.filter((t) => t.storyId !== targetStoryId)
				.map((t) => t.id);
			if (staleTagIds.length > 0) {
				await tx.storyTag.deleteMany({
					where: { id: { in: staleTagIds } },
				});
			}

			// Ensure the target owns the theme (idempotent — it may already if the
			// user reattached to a ticket that coincidentally had the tag).
			const already = holders.some((t) => t.storyId === targetStoryId);
			if (!already) {
				await tx.storyTag.create({
					data: {
						storyId: targetStoryId,
						value: themeKey,
						createdById: user.id,
					},
				});
			}

			return {
				vacatedStoryIds: holders
					.filter((t) => t.storyId !== targetStoryId)
					.map((t) => t.storyId),
				alreadyOwned: already,
			};
		});

		return {
			reattached: true,
			targetStoryId: target.id,
			targetIdentifier: target.identifier,
			vacatedStoryIds: moved.vacatedStoryIds,
			alreadyOwned: moved.alreadyOwned,
		};
	});
