import {
	createStoryComment,
	createTaskComment,
	ensureFabricSystemUser,
	FABRIC_SYSTEM_USER_ID,
	getStoryCommentForAgentReply,
	getTaskCommentForAgentReply,
} from "@repo/database";
import { logWorkflowEvent } from "@repo/logs";

export interface LoadFabricMentionContextInput {
	targetType: "story" | "task";
	commentId: string;
	organizationId?: string;
}

export interface FabricMentionContext {
	projectId: string;
	projectName: string;
	storyId: string;
	storyIdentifier: string;
	storyTitle: string;
	taskId?: string;
	taskIdentifier?: string;
	taskTitle?: string;
	commentContent: string;
}

export async function loadFabricMentionContextActivity(
	input: LoadFabricMentionContextInput,
): Promise<FabricMentionContext> {
	if (input.targetType === "story") {
		const comment = await getStoryCommentForAgentReply({
			commentId: input.commentId,
			organizationId: input.organizationId,
		});
		if (!comment) {
			throw new Error("Story comment not found");
		}
		return {
			projectId: comment.story.projectId,
			projectName: comment.story.project.name,
			storyId: comment.story.id,
			storyIdentifier: comment.story.identifier,
			storyTitle: comment.story.title,
			commentContent: comment.content,
		};
	}

	const comment = await getTaskCommentForAgentReply({
		commentId: input.commentId,
		organizationId: input.organizationId,
	});
	if (!comment) {
		throw new Error("Task comment not found");
	}
	return {
		projectId: comment.task.story.projectId,
		projectName: comment.task.story.project.name,
		storyId: comment.task.story.id,
		storyIdentifier: comment.task.story.identifier,
		storyTitle: comment.task.story.title,
		taskId: comment.task.id,
		taskIdentifier: comment.task.identifier,
		taskTitle: comment.task.title,
		commentContent: comment.content,
	};
}

export interface PersistFabricMentionReplyInput {
	targetType: "story" | "task";
	targetId: string;
	sourceCommentId: string;
	authorId: string;
	organizationId?: string;
	workflowId: string;
	content: string;
	metadata?: Record<string, unknown>;
}

export async function persistFabricMentionReplyActivity(
	input: PersistFabricMentionReplyInput,
) {
	// Route the FK through the canonical Fabric system user so agent replies
	// don't cascade-delete with the user who summoned them. `summonedBy` keeps
	// the original user id traceable in metadata for analytics/audits.
	await ensureFabricSystemUser();

	const metadata = {
		source: "fabric_mention_reply",
		summonedBy: input.authorId,
		...input.metadata,
	};

	const reply =
		input.targetType === "story"
			? await createStoryComment({
					storyId: input.targetId,
					authorId: FABRIC_SYSTEM_USER_ID,
					authorType: "AGENT",
					content: input.content,
					sourceCommentId: input.sourceCommentId,
					workflowId: input.workflowId,
					organizationId: input.organizationId,
					metadata,
				})
			: await createTaskComment({
					taskId: input.targetId,
					authorId: FABRIC_SYSTEM_USER_ID,
					authorType: "AGENT",
					content: input.content,
					sourceCommentId: input.sourceCommentId,
					workflowId: input.workflowId,
					organizationId: input.organizationId,
					metadata,
				});

	// AUDIT-LOG-V1 SCOPE: This event stays on the stdout/webhook path
	// (@repo/logs/audit-logger.ts) for v1. Per D5 of
	// docs/audit-log/README.md, AI/MCP/
	// workflow events are deferred to Phase 2. Do NOT migrate to recordAudit
	// without coordination — dual-writing is acceptable but a unilateral migration
	// loses the stdout/webhook delivery the operator currently relies on.
	await logWorkflowEvent(
		"AGENT_COMPLETED",
		input.workflowId,
		input.authorId,
		true,
		{
			organizationId: input.organizationId,
			resourceType:
				input.targetType === "story"
					? "user_story_comment"
					: "story_task_comment",
			resourceId: reply.id,
			sourceCommentId: input.sourceCommentId,
			source: "fabric_mention_reply",
		},
	).catch((error) => {
		console.warn("[AuditLog] Failed to log Fabric mention reply:", error);
	});

	return reply;
}
