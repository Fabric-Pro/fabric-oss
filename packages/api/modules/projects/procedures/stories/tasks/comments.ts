import { ORPCError } from "@orpc/client";
import {
	createTaskComment,
	db,
	findRecentDuplicateTaskComment,
	hasProjectAccess,
	listTaskComments,
	markTaskCommentWorkflowQueued,
} from "@repo/database";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { z } from "zod";
import { fanOut } from "../../../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../../agent-deployments/lib/lifecycle-dispatcher";
import { assertTaskParentCommentInScope } from "../../../lib/assert-parent-comment-in-scope";
import {
	assertFabricMentionRateLimit,
	extractFabricMention,
	startFabricMentionReplyWorkflow,
} from "../../../lib/fabric-mention";
import {
	expandGroupMentionsByTag,
	narrowToCurrentProjectRoster,
} from "../../../lib/group-mention";
import {
	extractGroupMentions,
	extractUserMentions,
	resolveMentionedUserIds,
} from "../../../lib/user-mention";

async function assertTaskAccess(input: {
	projectId: string;
	storyId: string;
	taskId: string;
	userId: string;
	organizationId?: string | null;
}) {
	const canAccess = await hasProjectAccess(
		input.projectId,
		input.userId,
		input.organizationId ?? undefined,
	);
	if (!canAccess) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}

	const task = await db.storyTask.findFirst({
		where: {
			id: input.taskId,
			storyId: input.storyId,
			story: { projectId: input.projectId },
		},
		select: { id: true },
	});
	if (!task) {
		throw new ORPCError("NOT_FOUND", { message: "Task not found" });
	}
}

export const listTaskCommentsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/comments",
		tags: ["Projects", "Stories", "Tasks", "Comments"],
		summary: "List task comments",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		await assertTaskAccess({
			projectId: input.projectId,
			storyId: input.storyId,
			taskId: input.taskId,
			userId: context.user.id,
			organizationId,
		});

		const comments = await listTaskComments({
			taskId: input.taskId,
			organizationId,
		});
		return { comments };
	});

export const createTaskCommentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/tasks/{taskId}/comments",
		tags: ["Projects", "Stories", "Tasks", "Comments"],
		summary: "Create task comment",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			taskId: z.string(),
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
		await assertTaskAccess({
			projectId: input.projectId,
			storyId: input.storyId,
			taskId: input.taskId,
			userId: context.user.id,
			organizationId,
		});

		await assertTaskParentCommentInScope({
			parentId: input.parentId,
			taskId: input.taskId,
		});

		const mentionQuery = extractFabricMention(input.content);

		// Idempotency: dedupe identical content from the same author within
		// the last few seconds to prevent duplicate @fabric replies on retry.
		const duplicate = await findRecentDuplicateTaskComment({
			taskId: input.taskId,
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

		let comment = await createTaskComment({
			taskId: input.taskId,
			authorId: context.user.id,
			content: input.content,
			parentId: input.parentId,
			organizationId,
		});

		if (mentionQuery !== null) {
			const workflowId = await startFabricMentionReplyWorkflow({
				targetType: "task",
				targetId: input.taskId,
				commentId: comment.id,
				userId: context.user.id,
				organizationId,
			});
			comment = await markTaskCommentWorkflowQueued({
				commentId: comment.id,
				workflowId,
				organizationId,
				metadata: {
					source: "story_task_comment",
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
				taskId: input.taskId,
				hasFabricMention: mentionQuery !== null,
			},
		}).catch((error) => {
			console.warn(
				"[LifecycleDispatcher] Comment created dispatch failed:",
				error,
			);
		});

		const notifOrgId = organizationId ?? null;
		void (async () => {
			try {
				const link = `projects/${input.projectId}/stories/${input.storyId}/tasks/${input.taskId}#comment-${comment.id}`;
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
							target: { taskId: input.taskId },
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
							target: { taskId: input.taskId },
							link,
							snippet,
							groupLabel: FUNCTION_TAG_GROUP_LABELS[tag],
						});
					}
				}

				if (input.parentId) {
					const parent = await db.storyTaskComment.findFirst({
						where: { id: input.parentId, taskId: input.taskId },
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
							target: { taskId: input.taskId },
							link,
							snippet,
						});
					}
				}
			} catch (error) {
				console.warn(
					"[notification-service] Task comment fan-out failed:",
					error,
				);
			}
		})();

		return { comment, fabricMentionQueued: mentionQuery !== null };
	});
