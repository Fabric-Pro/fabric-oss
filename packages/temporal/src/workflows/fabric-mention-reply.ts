import { executeChild, proxyActivities } from "@temporalio/workflow";
import type * as fabricMentionActivities from "../activities/fabric-mention-comments";
import type { DirectChatWorkflowInput } from "../types";
import { directChatWorkflow } from "./direct-chat";

export interface FabricMentionReplyWorkflowInput {
	workflowId: string;
	targetType: "story" | "task";
	targetId: string;
	commentId: string;
	userId: string;
	organizationId?: string;
}

export interface FabricMentionReplyWorkflowOutput {
	success: boolean;
	replyCommentId?: string;
	responseText?: string;
	error?: string;
}

const { loadFabricMentionContextActivity, persistFabricMentionReplyActivity } =
	proxyActivities<typeof fabricMentionActivities>({
		startToCloseTimeout: "1 minute",
		retry: { maximumAttempts: 3 },
	});

export async function fabricMentionReplyWorkflow(
	input: FabricMentionReplyWorkflowInput,
): Promise<FabricMentionReplyWorkflowOutput> {
	try {
		const context = await loadFabricMentionContextActivity({
			targetType: input.targetType,
			commentId: input.commentId,
			organizationId: input.organizationId,
		});

		const userPrompt = context.commentContent
			.replace(/(^|\s)@fabric(?=$|\s|[:,.!?])[:,]?\s*/i, "$1")
			.trim();
		const message =
			userPrompt.length > 0 ? userPrompt : context.commentContent;

		const targetBlock =
			input.targetType === "task"
				? `Task: ${context.taskIdentifier} ${context.taskTitle}\nFeature: ${context.storyIdentifier} ${context.storyTitle}`
				: `Feature: ${context.storyIdentifier} ${context.storyTitle}`;

		const systemPrompt = `You are Fabric Agent replying inside a project comment thread.\n\nProject: ${context.projectName}\n${targetBlock}\n\nReply directly to the user's comment. Keep the response concise, grounded in the project context, and do not claim to have changed data unless a tool/action actually did so.`;

		const directChatInput: DirectChatWorkflowInput = {
			executionId: `${input.workflowId}-direct-chat`,
			message,
			history: [],
			userId: input.userId,
			organizationId: input.organizationId,
			reasoningMode: "balanced",
			projectId: context.projectId,
			systemPrompt,
		};

		const result = await executeChild(directChatWorkflow, {
			workflowId: `${input.workflowId}-direct-chat`,
			args: [directChatInput],
		});

		if (!result.success || !result.responseText) {
			const errorMessage =
				result.error ?? "Fabric Agent did not return a response.";
			const failureReply = await persistFabricMentionReplyActivity({
				targetType: input.targetType,
				targetId: input.targetId,
				sourceCommentId: input.commentId,
				authorId: input.userId,
				organizationId: input.organizationId,
				workflowId: input.workflowId,
				content: `I couldn't generate a reply: ${errorMessage}`,
				metadata: {
					agentId: "fabric-workspace-assistant",
					agentDisplayName: "Fabric",
					directChatWorkflowId: `${input.workflowId}-direct-chat`,
					targetType: input.targetType,
					status: "failed",
					error: errorMessage,
				},
			});
			return {
				success: false,
				replyCommentId: failureReply.id,
				error: errorMessage,
			};
		}

		const reply = await persistFabricMentionReplyActivity({
			targetType: input.targetType,
			targetId: input.targetId,
			sourceCommentId: input.commentId,
			authorId: input.userId,
			organizationId: input.organizationId,
			workflowId: input.workflowId,
			content: result.responseText,
			metadata: {
				agentId: "fabric-workspace-assistant",
				agentDisplayName: "Fabric",
				directChatWorkflowId: `${input.workflowId}-direct-chat`,
				targetType: input.targetType,
			},
		});

		return {
			success: true,
			replyCommentId: reply.id,
			responseText: result.responseText,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : String(error);
		try {
			const failureReply = await persistFabricMentionReplyActivity({
				targetType: input.targetType,
				targetId: input.targetId,
				sourceCommentId: input.commentId,
				authorId: input.userId,
				organizationId: input.organizationId,
				workflowId: input.workflowId,
				content: `I couldn't generate a reply: ${errorMessage}`,
				metadata: {
					agentId: "fabric-workspace-assistant",
					agentDisplayName: "Fabric",
					targetType: input.targetType,
					status: "failed",
					error: errorMessage,
				},
			});
			return {
				success: false,
				replyCommentId: failureReply.id,
				error: errorMessage,
			};
		} catch {
			return {
				success: false,
				error: errorMessage,
			};
		}
	}
}
