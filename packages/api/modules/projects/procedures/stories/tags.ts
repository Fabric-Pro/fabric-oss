import { ORPCError } from "@orpc/client";
import { db, Prisma } from "@repo/database";
import { hasPermission } from "@repo/permissions";
import {
	MAX_TAGS_PER_STORY,
	normalizeTagValue,
	tagValueSchema,
} from "@repo/utils/tag-value";
import { z } from "zod";
import { resolveEffectiveProjectPermissions } from "../../../../lib/effective-project-permissions";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const addStoryTagProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tags",
		tags: ["Projects", "Stories", "Tags"],
		summary: "Add a custom tag to a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			value: tagValueSchema,
		}),
	)
	.handler(async ({ input, context }) => {
		// IDOR guard: the gate authorizes projectId only — confirm the story
		// belongs to it before writing.
		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		try {
			const tag = await db.$transaction(async (tx) => {
				// Lock the parent story row so concurrent adds serialize — makes
				// the 20-tag cap atomic (a count-then-insert race could otherwise
				// reach 21). `${input.storyId}` is parameterized/safe;
				// `user_story` is the @@map table name for UserStory.
				await tx.$queryRaw`SELECT id FROM user_story WHERE id = ${input.storyId} FOR UPDATE`;
				const count = await tx.storyTag.count({
					where: { storyId: input.storyId },
				});
				if (count >= MAX_TAGS_PER_STORY) {
					throw new ORPCError("BAD_REQUEST", {
						message: `A work item can have at most ${MAX_TAGS_PER_STORY} tags`,
					});
				}
				const tag = await tx.storyTag.create({
					data: {
						storyId: input.storyId,
						// Defensively re-normalize: on the real oRPC path `.input`
						// already transformed via tagValueSchema, but unit tests
						// (and any future caller) shouldn't depend on that —
						// normalize here so the stored value is always canonical.
						value: normalizeTagValue(input.value),
						createdById: context.user.id,
					},
					select: {
						id: true,
						value: true,
						createdById: true,
						createdAt: true,
					},
				});
				await tx.userStory.update({
					where: { id: input.storyId, projectId: input.projectId },
					data: {
						lastEditedAt: new Date(),
						lastEditedByName: context.user.name ?? null,
						lastEditedSource: "MANUAL",
					},
				});
				return tag;
			});
			return { tag };
		} catch (err) {
			if (
				err instanceof Prisma.PrismaClientKnownRequestError &&
				err.code === "P2002"
			) {
				throw new ORPCError("CONFLICT", {
					message: "This tag is already on the work item",
				});
			}
			throw err;
		}
	});

export const removeStoryTagProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/stories/{storyId}/tags/{tagId}",
		tags: ["Projects", "Stories", "Tags"],
		summary: "Remove a custom tag from a work item",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			tagId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		// IDOR guard: load the tag scoped to its story-in-project in one query
		// BEFORE any authorization decision.
		const tag = await db.storyTag.findFirst({
			where: {
				id: input.tagId,
				story: { id: input.storyId, projectId: input.projectId },
			},
			select: { id: true, createdById: true },
		});
		if (!tag) {
			throw new ORPCError("NOT_FOUND", { message: "Tag not found" });
		}

		// Project-authoritative creator-or-admin check: the tag's
		// creator may remove it; otherwise the caller needs effective
		// STORY_DELETE resolved with ProjectMember-first precedence. Do NOT use
		// the org-first userHasProjectPermission here.
		const isCreator =
			tag.createdById !== null && tag.createdById === context.user.id;
		if (!isCreator) {
			const access = await resolveEffectiveProjectPermissions(
				input.projectId,
				context.user.id,
			);
			const canDeleteAny =
				access !== null &&
				hasPermission(access.permissions, Permissions.STORY_DELETE);
			if (!canDeleteAny) {
				throw new ORPCError("FORBIDDEN", {
					message: "You can only remove tags you created",
				});
			}
		}

		await db.$transaction(async (tx) => {
			await tx.storyTag.delete({ where: { id: tag.id } });
			await tx.userStory.update({
				where: { id: input.storyId, projectId: input.projectId },
				data: {
					lastEditedAt: new Date(),
					lastEditedByName: context.user.name ?? null,
					lastEditedSource: "MANUAL",
				},
			});
		});
		return { removed: true };
	});

export const listStoryTagsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/tags",
		tags: ["Projects", "Stories", "Tags"],
		summary: "List the project's distinct custom tag values",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		// Project-scoped DISTINCT values (the binding isolation guarantee is the
		// `story: { projectId }` filter). Exclude CLOSED ("hidden")
		// stories so a tag used only on hidden items drops from suggestions.
		const rows = await db.storyTag.findMany({
			where: {
				story: {
					projectId: input.projectId,
					draftingStage: { not: "CLOSED" },
				},
			},
			distinct: ["value"],
			orderBy: { value: "asc" },
			select: { value: true },
		});
		return { tags: rows.map((r) => r.value) };
	});
