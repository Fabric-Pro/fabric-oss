import { ORPCError } from "@orpc/client";
import {
	continueConversationInNewChat,
	ParentConversationNotFoundError,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

export const continueInNewChat = tenantProtectedProcedure
	.use(requirePermission(Permissions.AGENT_CREATE))
	.route({
		method: "POST",
		path: "/agents/conversations/continue-in-new-chat",
		tags: ["Agent Conversations"],
		summary:
			"Continue a conversation in a new chat with carried-over context",
		description:
			"Creates a fresh conversation linked to the parent, seeded with the parent's exhaustion-synthesis summary as carried-over context.",
	})
	.input(
		z.object({
			organizationId: z.string().nullable().optional(),
			parentConversationId: z.string(),
			summary: z
				.string()
				.min(1, "summary cannot be empty")
				.max(50_000, "summary exceeds 50KB limit"),
			title: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const { user, session } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		try {
			const conversation = await continueConversationInNewChat({
				userId: user.id,
				organizationId,
				parentConversationId: input.parentConversationId,
				carriedOverSummary: input.summary,
				title: input.title,
			});
			return {
				id: conversation.id,
				agentId: conversation.agentId,
				title: conversation.title,
				parentConversationId: conversation.parentConversationId,
				createdAt: conversation.createdAt.toISOString(),
			};
		} catch (error) {
			if (error instanceof ParentConversationNotFoundError) {
				throw new ORPCError("NOT_FOUND", {
					message: "Parent conversation not found",
				});
			}
			throw error;
		}
	});
