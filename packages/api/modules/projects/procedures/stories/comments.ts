import { ORPCError } from "@orpc/client";
import {
	createStoryComment,
	db,
	findRecentDuplicateStoryComment,
	hasProjectAccess,
	listStoryComments,
	markStoryCommentWorkflowQueued,
} from "@repo/database";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { z } from "zod";
import { fanOut } from "../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../agent-deployments/lib/lifecycle-dispatcher";
import { assertStoryParentCommentInScope } from "../../lib/assert-parent-comment-in-scope";
import {
	assertFabricMentionRateLimit,
	extractFabricMention,
	startFabricMentionReplyWorkflow,
} from "../../lib/fabric-mention";
import {
	expandGroupMentionsByTag,
	narrowToCurrentProjectRoster,
} from "../../lib/group-mention";
import {
	extractGroupMentions,
	extractUserMentions,
	resolveMentionedUserIds,
} from "../../lib/user-mention";

export const listStoryCommentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/comments",
		tags: ["Projects", "Stories", "Comments"],
		summary: "List feature comments",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		const comments = await listStoryComments({
			storyId: input.storyId,
			organizationId,
		});
		return { comments };
	});

export const createStoryCommentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/comments",
		tags: ["Projects", "Stories", "Comments"],
		summary: "Create feature comment",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			content: z.string().min(1).max(10_000),
			parentId: z.string().nullable().optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const canAccess = await hasProjectAccess(
			input.projectId,
			context.user.id,
			organizationId,
		);
		if (!canAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		const story = await db.userStory.findFirst({
			where: { id: input.storyId, projectId: input.projectId },
			select: { id: true },
		});
		if (!story) {
			throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
		}

		await assertStoryParentCommentInScope({
			parentId: input.parentId,
			storyId: input.storyId,
		});

		const mentionQuery = extractFabricMention(input.content);

		// Idempotency: if the same author posted identical content in the last
		// few seconds, return the existing comment instead of creating a new
		// one. Prevents duplicate @fabric replies on retry/double-click.
		const duplicate = await findRecentDuplicateStoryComment({
			storyId: input.storyId,
			authorId: context.user.id,
			content: input.content,
			organizationId,
			parentId: input.parentId,
		});
		if (duplicate) {
			return {
				comment: duplicate,
				fabricMentionQueued: Boolean(duplicate.workflowId),
			};
		}

		if (mentionQuery !== null) {
			await assertFabricMentionRateLimit(
				input.projectId,
				context.user.id,
			);
		}

		let comment = await createStoryComment({
			storyId: input.storyId,
			authorId: context.user.id,
			content: input.content,
			parentId: input.parentId,
			organizationId,
		});

		if (mentionQuery !== null) {
			const workflowId = await startFabricMentionReplyWorkflow({
				targetType: "story",
				targetId: input.storyId,
				commentId: comment.id,
				userId: context.user.id,
				organizationId,
			});
			comment = await markStoryCommentWorkflowQueued({
				commentId: comment.id,
				workflowId,
				organizationId,
				metadata: {
					source: "user_story_comment",
					agentId: "fabric-workspace-assistant",
					agentDisplayName: "Fabric",
					fabricMentionQuery: mentionQuery,
				},
			});
		}

		dispatchLifecycleEvent({
			resource: "comment",
			event: "created",
			projectId: input.projectId,
			entityId: comment.id,
			userId: context.user.id,
			organizationId,
			data: {
				storyId: input.storyId,
				hasFabricMention: mentionQuery !== null,
			},
		}).catch((error) => {
			console.warn(
				"[LifecycleDispatcher] Comment created dispatch failed:",
				error,
			);
		});

		// Notification fan-out (mentions + reply). Fire-and-forget; failures
		// must never break the comment-create response.
		const notifOrgId = organizationId ?? null;
		void (async () => {
			try {
				const link = `projects/${input.projectId}/stories/${input.storyId}#comment-${comment.id}`;
				const snippet = input.content.slice(0, 280);

				const usernames = extractUserMentions(input.content);
				const groupTags = extractGroupMentions(input.content);
				const dispatched = new Set<string>();

				if (usernames.length > 0) {
					const mentionedUserIds = await resolveMentionedUserIds(
						usernames,
						input.projectId,
						notifOrgId,
					);
					if (mentionedUserIds.length > 0) {
						for (const id of mentionedUserIds) {
							dispatched.add(id);
						}
						await fanOut.mention({
							recipientUserIds: mentionedUserIds,
							commentId: comment.id,
							projectId: input.projectId,
							organizationId: notifOrgId,
							actorUserId: context.user.id,
							actorName: context.user.name ?? "Someone",
							target: { storyId: input.storyId },
							link,
							snippet,
						});
					}
				}

				// Group mentions: deterministic order, project-scoped narrow,
				// group-only recipients (individual takes precedence). Resolve
				// the roster ONCE for every mentioned tag, then narrow the union
				// of holders a single time — per-tag holders intersected with
				// the narrowed union equal the per-tag narrow (narrow is a
				// membership filter), so recipients, precedence, and labels are
				// unchanged from the old per-tag resolve.
				const orderedGroups = FUNCTION_TAG_ORDER.filter((t) =>
					groupTags.includes(t),
				);
				if (orderedGroups.length > 0) {
					const holdersByTag = await expandGroupMentionsByTag({
						projectId: input.projectId,
						groupTags: orderedGroups,
					});
					const narrowedGroupRoster = new Set(
						await narrowToCurrentProjectRoster(
							[...new Set([...holdersByTag.values()].flat())],
							input.projectId,
						),
					);
					for (const tag of orderedGroups) {
						const fresh = (holdersByTag.get(tag) ?? []).filter(
							(id) =>
								narrowedGroupRoster.has(id) &&
								!dispatched.has(id),
						);
						if (fresh.length === 0) {
							continue;
						}
						for (const id of fresh) {
							dispatched.add(id);
						}
						await fanOut.mention({
							recipientUserIds: fresh,
							commentId: comment.id,
							projectId: input.projectId,
							organizationId: notifOrgId,
							actorUserId: context.user.id,
							actorName: context.user.name ?? "Someone",
							target: { storyId: input.storyId },
							link,
							snippet,
							groupLabel: FUNCTION_TAG_GROUP_LABELS[tag],
						});
					}
				}

				if (input.parentId) {
					const parent = await db.userStoryComment.findFirst({
						where: { id: input.parentId, storyId: input.storyId },
						select: { authorId: true },
					});
					if (parent) {
						await fanOut.reply({
							recipientUserIds: [parent.authorId],
							commentId: comment.id,
							parentCommentId: input.parentId,
							projectId: input.projectId,
							organizationId: notifOrgId,
							actorUserId: context.user.id,
							actorName: context.user.name ?? "Someone",
							target: { storyId: input.storyId },
							link,
							snippet,
						});
					}
				}
			} catch (error) {
				console.warn(
					"[notification-service] Comment fan-out failed:",
					error,
				);
			}
		})();

		return { comment, fabricMentionQueued: mentionQuery !== null };
	});
